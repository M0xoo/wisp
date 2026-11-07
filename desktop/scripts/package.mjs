// Builds the Tauri app as a download, under the names electron-builder uses
// (packaging/desktop/electron-builder.yml): wisp-mac-<arch>.dmg and .zip, wisp-windows-<arch>-setup.exe,
// and the shell alone for npm, wisp-shell-<mac|windows>-<arch>.tar.gz (packShell).
// Nothing here is released yet: .github/workflows/tauri-package.yml keeps them as a dry run's artifacts.
//
//   node desktop/scripts/package.mjs [--target <triple>] [--out dist/tauri] [--features qa] [--skip-build]
//
// Needs Rust. TAURI_CLI picks the CLI ("cargo tauri" here if you have it), MAC_SIGN_IDENTITY a
// Developer ID (ad hoc otherwise, as in release.yml without its secrets: Apple silicon runs nothing
// unsigned). Mac only: dmg and zip. Windows only: the installer. Linux stays on Electron.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NODE_VERSION, TARGETS, fetchNode, hostTarget } from './fetch-node.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHELL = path.join(ROOT, 'desktop/src-tauri');
const STAGE = path.join(SHELL, 'stage'); // gitignored
export const CLI = '@tauri-apps/cli@2.12.4';
export const ENTITLEMENTS = path.join(ROOT, 'packaging/desktop/entitlements.mac.plist');

export const isMac = (triple) => triple.endsWith('apple-darwin');
export const archOf = (triple) => (triple.startsWith('aarch64') ? 'arm64' : 'x64');
export const isWindows = (triple) => triple.includes('windows');
// The shell alone, for a wisp from npm (bin/desktop-shell.js shellAsset() names them the same way):
// mac and windows now, linux once it builds.
export const shellArtefact = (triple) => `wisp-shell-${isMac(triple) ? 'mac' : isWindows(triple) ? 'windows' : 'linux'}-${archOf(triple)}.tar.gz`;
export const artefacts = (triple) => (isMac(triple) ? [`wisp-mac-${archOf(triple)}.dmg`, `wisp-mac-${archOf(triple)}.zip`] : [`wisp-windows-${archOf(triple)}-setup.exe`]);

// What goes in the app: what npm ships (electron-builder's list too), plus the Node side of the shell.
export function appFiles(pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))) {
  return [...new Set(['package.json', ...pkg.files.map((f) => f.replace(/\/$/, '')), 'desktop/entry.mjs', 'desktop/remove-electron.mjs'])];
}

// A separate config, never tauri.conf.json: tauri-build fails on resources that aren't there, and
// cargo check, dev:tauri and qa/desktop-tauri.mjs have no stage/.
// Windows has no resources folder of its own (resource_dir is the exe's): `app` there would land in
// the install folder, PACKAGED in server/update.js wouldn't match it, and the app would call itself
// an npm install. root() in src/main.rs looks in resources/app.
export function overlay(triple) {
  const mac = isMac(triple);
  return {
    bundle: {
      targets: mac ? ['app'] : ['nsis'],
      resources: { 'stage/app/': mac ? 'app/' : 'resources/app/', 'stage/node/': 'node/' },
      // %LOCALAPPDATA%, so the updater can replace it without admin rights (as electron-builder.yml).
      ...(mac ? {} : { windows: { nsis: { installMode: 'currentUser', installerHooks: 'installer-hooks.nsh' } } }),
    },
  };
}

export function stage(root = ROOT, dest = path.join(STAGE, 'app')) {
  fs.rmSync(dest, { recursive: true, force: true });
  for (const f of appFiles(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')))) {
    fs.cpSync(path.join(root, f), path.join(dest, f), { recursive: true, filter: (s) => !/[\\/](node_modules|\.DS_Store)$/.test(s) });
  }
  return dest;
}

function tauri(triple, config, features) {
  const words = (process.env.TAURI_CLI || `npx --yes ${CLI}`).split(' ');
  const args = [...words.slice(1), 'build', '--ci', '--target', triple, '--config', config, ...(features ? ['--features', features] : [])];
  execFileSync(words[0], args, { cwd: SHELL, stdio: 'inherit', shell: process.platform === 'win32' });
}

const bundleDir = (triple) => path.join(process.env.CARGO_TARGET_DIR || path.join(SHELL, 'target'), triple, 'release', 'bundle');
const run = (cmd, ...args) => execFileSync(cmd, args, { stdio: 'inherit' });

// Node first, then the bundle around it: a signature seals what's inside. Tauri signs only its own
// binary and leaves Node with the Node project's signature, so the app's entitlements wouldn't reach it.
export function signArgs(file, identity = '-', entitlements = ENTITLEMENTS) {
  return ['--force', '--options', 'runtime', '--timestamp=none', '--entitlements', entitlements, '--sign', identity, file];
}

function packMac(triple, out) {
  const app = path.join(bundleDir(triple), 'macos', 'wisp.app');
  const identity = process.env.MAC_SIGN_IDENTITY || '-';
  run('codesign', ...signArgs(path.join(app, 'Contents/Resources/node/bin/node'), identity));
  run('codesign', ...signArgs(app, identity));
  run('codesign', '--verify', '--strict', '--verbose=1', app);
  const [dmg, zip] = artefacts(triple).map((f) => path.join(out, f));
  // ditto as electron-builder does: keeps Node's executable bit, and wisp.app at the top of the zip.
  fs.rmSync(zip, { force: true });
  run('ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', app, zip);
  const room = fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-dmg-'));
  run('ditto', app, path.join(room, 'wisp.app'));
  fs.symlinkSync('/Applications', path.join(room, 'Applications'));
  run('hdiutil', 'create', '-quiet', '-ov', '-volname', 'wisp', '-fs', 'APFS', '-format', 'ULMO', '-srcfolder', room, dmg);
  fs.rmSync(room, { recursive: true, force: true });
}

function packWindows(triple, out) {
  const dir = path.join(bundleDir(triple), 'nsis');
  const built = fs.readdirSync(dir).find((f) => f.endsWith('-setup.exe'));
  if (!built) throw new Error(`no installer in ${dir}`);
  fs.copyFileSync(path.join(dir, built), path.join(out, artefacts(triple)[0]));
}

// The same build without Node or wisp's files: wisp.app on a Mac, the bare binary elsewhere (Windows
// has WebView2, the resources were the installer's files). A wisp from npm runs it on its own Node
// and files. On a Mac the bundle's signature sealed what's gone, so it's signed again.
const tarBin = () => (process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32/tar.exe') : 'tar');
export function packShell(triple, out) {
  const room = fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-shell-'));
  try {
    let inside;
    if (isMac(triple)) {
      inside = 'wisp.app';
      run('ditto', path.join(bundleDir(triple), 'macos', 'wisp.app'), path.join(room, inside));
      for (const dir of ['app', 'node']) fs.rmSync(path.join(room, inside, 'Contents/Resources', dir), { recursive: true, force: true });
      run('codesign', ...signArgs(path.join(room, inside), process.env.MAC_SIGN_IDENTITY || '-'));
      run('codesign', '--verify', '--strict', '--verbose=1', path.join(room, inside));
    } else {
      inside = isWindows(triple) ? 'wisp.exe' : 'wisp';
      fs.copyFileSync(path.join(path.dirname(bundleDir(triple)), inside), path.join(room, inside));
      fs.chmodSync(path.join(room, inside), 0o755);
    }
    const file = path.join(out, shellArtefact(triple));
    fs.rmSync(file, { force: true });
    // System32's bsdtar on Windows (Git Bash's GNU tar takes C:\ for a host name). COPYFILE_DISABLE:
    // no ._ files for macOS's extended attributes.
    execFileSync(tarBin(), ['-czf', file, inside], { cwd: room, stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1' } });
    return file;
  } finally {
    fs.rmSync(room, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : fallback;
  };
  const triple = arg('--target', hostTarget());
  const out = path.resolve(arg('--out', path.join(ROOT, 'dist/tauri')));
  if (!TARGETS[triple]) throw new Error(`no Tauri packaging for ${triple}`);
  fs.mkdirSync(out, { recursive: true });
  if (!process.argv.includes('--skip-build')) {
    stage();
    await fetchNode(triple, path.join(STAGE, 'node'));
    const config = path.join(STAGE, 'tauri.conf.json');
    fs.writeFileSync(config, JSON.stringify(overlay(triple), null, 2));
    tauri(triple, config, arg('--features'));
  }
  (isMac(triple) ? packMac : packWindows)(triple, out);
  packShell(triple, out);
  for (const f of artefacts(triple)) console.log(`${f}  ${fs.statSync(path.join(out, f)).size} bytes  (Node ${NODE_VERSION})`);
  console.log(`${shellArtefact(triple)}  ${fs.statSync(path.join(out, shellArtefact(triple))).size} bytes  (the shell alone)`);
}
