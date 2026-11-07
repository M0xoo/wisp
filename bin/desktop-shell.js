// The desktop window for a wisp from npm: the Tauri shell alone (no
// Node, no wisp files), one small archive per platform on each GitHub release. Downloaded once into
// ~/.wisp/desktop/<version>/, checked against that release's SHA256SUMS.txt, and run on this Node
// with this package's files (WISP_NODE, WISP_ROOT: desktop/src-tauri/src/main.rs root() and node()).
// Anything short of a shell that's all there, checked, gives null and a reason: the caller opens a
// browser tab instead. Node built-ins and the system's tar only (Windows 10+ has tar.exe).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const RELEASES = 'https://github.com/M0xoo/wisp/releases/download';
export const GET_APP = 'https://trywisp.dev/#install';
// The sums decide whether there's a shell at all: a hung network mustn't hold up the tab for long.
const [SUMS_TIMEOUT, SHELL_TIMEOUT] = [10_000, 120_000];

// desktop/scripts/package.mjs shellArtefact() names them the same way.
export function shellAsset(platform = process.platform, arch = process.arch) {
  const os = { darwin: 'mac', win32: 'windows', linux: 'linux' }[platform];
  return os && ['x64', 'arm64'].includes(arch) ? `wisp-shell-${os}-${arch}.tar.gz` : null;
}

export const shellDir = (version, home = process.env.WISP_HOME || path.join(os.homedir(), '.wisp')) => path.join(home, 'desktop', version);

// What's in each archive: the app bundle on a Mac (its Info.plist names the Dock tile and the
// notifications), the bare binary elsewhere.
export function shellExe(dir, platform = process.platform) {
  if (platform === 'darwin') return path.join(dir, 'wisp.app/Contents/MacOS/wisp');
  return path.join(dir, platform === 'win32' ? 'wisp.exe' : 'wisp');
}

// The rolling nightly release is tagged `nightly`, every other one v<version>. WISP_SHELL_URL stands
// in for the release folder (qa/install.mjs, a fork's releases).
export const releaseUrl = (version, env = process.env) => (env.WISP_SHELL_URL || `${RELEASES}/${/-nightly\./.test(version) ? 'nightly' : `v${version}`}`).replace(/\/$/, '');

export function sumFor(sums, name) {
  for (const line of String(sums).split(/\r?\n/)) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (m && m[2] === name) return m[1].toLowerCase();
  }
  return null;
}

const tarBin = () => (process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar');

const isFile = (p) => fs.statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;

class ShellError extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

async function get(url, fetchImpl, timeout) {
  let res;
  try {
    res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(timeout) });
  } catch (err) {
    throw new ShellError('offline', `couldn't reach ${new URL(url).host} (${err.cause?.code || err.name})`);
  }
  if (res.status === 404) throw new ShellError('missing', `${url} isn't there`);
  if (!res.ok) throw new ShellError('offline', `${url} answered ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// → { exe } or { exe: null, reason: 'platform' | 'missing' | 'offline' | 'checksum' | 'unpack', message }
export async function desktopShell({ version, home, platform = process.platform, arch = process.arch, env = process.env, fetch: fetchImpl = globalThis.fetch, say = () => {} }) {
  const name = shellAsset(platform, arch);
  if (!name) return { exe: null, reason: 'platform', message: `no wisp app for ${platform} ${arch}` };
  const dir = shellDir(version, home ?? (env.WISP_HOME || path.join(os.homedir(), '.wisp')));
  const exe = shellExe(dir, platform);
  if (isFile(exe)) return { exe };
  const base = releaseUrl(version, env);
  const part = `${dir}.part-${process.pid}`;
  try {
    const sums = (await get(`${base}/SHA256SUMS.txt`, fetchImpl, SUMS_TIMEOUT)).toString('utf8');
    const want = sumFor(sums, name);
    if (!want) throw new ShellError('missing', `wisp ${version} has no ${name}`);
    say(`  ◌ getting the wisp app for ${version} (once)…`);
    const body = await get(`${base}/${name}`, fetchImpl, SHELL_TIMEOUT);
    const got = createHash('sha256').update(body).digest('hex');
    if (got !== want) throw new ShellError('checksum', `${name} doesn't match SHA256SUMS.txt`);
    fs.rmSync(part, { recursive: true, force: true });
    fs.mkdirSync(part, { recursive: true });
    const file = path.join(part, name);
    fs.writeFileSync(file, body);
    try {
      // From inside the folder: Git Bash's GNU tar on PATH takes C:\ for a host name.
      execFileSync(tarBin(), ['-xzf', name], { cwd: part, stdio: 'ignore' });
    } catch (err) {
      throw new ShellError('unpack', `couldn't unpack ${name}: ${err.message.split('\n')[0]}`);
    }
    fs.rmSync(file);
    if (!isFile(shellExe(part, platform))) throw new ShellError('unpack', `${name} holds no wisp app`);
    // Into place in one step, so a half-written folder is never taken for a shell. Another wisp may
    // have got there first: its copy is as good.
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.rmSync(dir, { recursive: true, force: true });
    try {
      fs.renameSync(part, dir);
    } catch (err) {
      if (!isFile(exe)) throw new ShellError('unpack', err.message);
    }
    return { exe };
  } catch (err) {
    return { exe: null, reason: err.reason || 'unpack', message: err.message };
  } finally {
    fs.rmSync(part, { recursive: true, force: true });
  }
}

// How bin/wisp.js starts it: detached, the server on this Node from this package.
export function shellEnv(env, { port, root, node = process.execPath }) {
  const out = { ...env, WISP_PORT: String(port), WISP_NODE: node, WISP_ROOT: root };
  delete out.ELECTRON_RUN_AS_NODE; // the Mac shell would turn itself into Node (macos::be_node_for_electron)
  return out;
}

export const noAppLine = (message) => `  ◌ no wisp app here (${message}): opening a browser tab. The app: ${GET_APP}`;
