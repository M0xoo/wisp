// The Node binary the Tauri app ships: the official nodejs.org build, pinned by version and sha256
// for each target triple. Not Homebrew's (it links dylibs), not pkg or SEA: agents, the MCP bridge
// and fork() in server/app-db.js all re-run wisp's files through process.execPath.
//
//   node desktop/scripts/fetch-node.mjs [triple] [dest]
//
// To move to a new Node: change NODE_VERSION and each sha256 from
// https://nodejs.org/dist/v<version>/SHASUMS256.txt. Linux has none: it stays on Electron.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 22, not 24: 24's binaries want macOS 13.5 (LC_BUILD_VERSION minos) and the app's floor is 13.3.
export const NODE_VERSION = '22.23.4';

export const TARGETS = {
  'aarch64-apple-darwin': { name: 'darwin-arm64', ext: 'tar.gz', sha256: 'c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428' },
  'x86_64-apple-darwin': { name: 'darwin-x64', ext: 'tar.gz', sha256: 'efcc2b0db6f94bf53eddb038fe2b370277a042bd29e4f19b8f8e23598795b819' },
  'x86_64-pc-windows-msvc': { name: 'win-x64', ext: 'zip', sha256: 'cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20' },
  'aarch64-pc-windows-msvc': { name: 'win-arm64', ext: 'zip', sha256: 'a8b8cd79cbbb3062435f449591d98dd63730bbbf30ce2d7cc3a6376c236cb111' },
};

export const hostTarget = (platform = process.platform, arch = process.arch) => {
  const triple = { darwin: { arm64: 'aarch64-apple-darwin', x64: 'x86_64-apple-darwin' }, win32: { arm64: 'aarch64-pc-windows-msvc', x64: 'x86_64-pc-windows-msvc' } }[platform]?.[arch];
  if (!triple) throw new Error(`no Tauri build for ${platform} ${arch}: Linux stays on Electron`);
  return triple;
};

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
// Git Bash puts GNU tar first on a Windows PATH, and that one can't read a zip.
const tar = () => (process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar');

// Into dest: bin/node on macOS, node.exe on Windows, each with Node's LICENSE. That's where
// node() in desktop/src-tauri/src/main.rs looks. npm stays behind: wisp never runs it from here.
export async function fetchNode(triple, dest, { base = 'https://nodejs.org/dist', version = NODE_VERSION, targets = TARGETS, cache = path.join(os.tmpdir(), 'wisp-node-cache') } = {}) {
  const target = targets[triple];
  if (!target) throw new Error(`no pinned Node for ${triple} (have: ${Object.keys(targets).join(', ')})`);
  const stem = `node-v${version}-${target.name}`;
  const file = `${stem}.${target.ext}`;
  const archive = path.join(cache, file);
  fs.mkdirSync(cache, { recursive: true });
  if (!fs.existsSync(archive) || sha256(archive) !== target.sha256) {
    const r = await fetch(`${base}/v${version}/${file}`);
    if (!r.ok) throw new Error(`couldn't download ${file}: HTTP ${r.status}`);
    const got = Buffer.from(await r.arrayBuffer());
    const hash = createHash('sha256').update(got).digest('hex');
    if (hash !== target.sha256) throw new Error(`${file} doesn't match its pinned sha256 (got ${hash})`);
    fs.writeFileSync(archive, got);
  }
  const unpack = fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-node-'));
  try {
    const exe = target.ext === 'zip' ? ['node.exe'] : ['bin', 'node'];
    execFileSync(tar(), ['-xf', archive, '-C', unpack, `${stem}/${exe.join('/')}`, `${stem}/LICENSE`]);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.join(dest, ...exe.slice(0, -1)), { recursive: true });
    fs.copyFileSync(path.join(unpack, stem, ...exe), path.join(dest, ...exe));
    fs.copyFileSync(path.join(unpack, stem, 'LICENSE'), path.join(dest, 'LICENSE'));
    if (target.ext !== 'zip') fs.chmodSync(path.join(dest, ...exe), 0o755);
    return path.join(dest, ...exe);
  } finally {
    fs.rmSync(unpack, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [triple = hostTarget(), dest = path.join(os.tmpdir(), `wisp-node-${triple}`)] = process.argv.slice(2);
  console.log(await fetchNode(triple, dest));
}
