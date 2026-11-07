// The desktop window for a wisp from npm: the Tauri shell alone (no Node, no wisp files), one small
// archive per platform on each GitHub release. Downloaded once into ~/.wisp/desktop/<version>/, checked
// against that release's SHA256SUMS.txt, and run on this Node with this package's files (WISP_NODE,
// WISP_ROOT: the shell's root() and node()). Anything short of a shell that's all there, checked, gives
// null and a reason: the caller opens a browser tab instead. Node built-ins and the system's tar only
// (Windows 10+ has tar.exe). Port of v1 bin/desktop-shell.js.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

export const RELEASES = 'https://github.com/M0xoo/wisp/releases/download';
export const GET_APP = 'https://trywisp.dev/#install';
// The sums decide whether there's a shell at all: a hung network mustn't hold up the tab for long.
const SUMS_TIMEOUT = 10_000;
const SHELL_TIMEOUT = 120_000;

type Env = Record<string, string | undefined>;
export type ShellReason = 'platform' | 'missing' | 'offline' | 'checksum' | 'unpack';
export type ShellResult = { exe: string } | { exe: null; reason: ShellReason; message: string };
type Fetch = (url: string, init: { redirect: 'follow'; signal: AbortSignal }) => Promise<Response>;

const OS_NAME: Record<string, string> = { darwin: 'mac', win32: 'windows', linux: 'linux' };

/** The archive's name for a platform; desktop packaging names them the same way. */
export function shellAsset(platform: string = process.platform, arch: string = process.arch): string | null {
  const name = OS_NAME[platform];
  return name && ['x64', 'arm64'].includes(arch) ? `wisp-shell-${name}-${arch}.tar.gz` : null;
}

export const shellDir = (version: string, home: string = process.env['WISP_HOME'] || path.join(os.homedir(), '.wisp')): string => path.join(home, 'desktop', version);

// What's in each archive: the app bundle on a Mac (its Info.plist names the Dock tile and the
// notifications), the bare binary elsewhere.
export function shellExe(dir: string, platform: string = process.platform): string {
  if (platform === 'darwin') return path.join(dir, 'wisp.app/Contents/MacOS/wisp');
  return path.join(dir, platform === 'win32' ? 'wisp.exe' : 'wisp');
}

// The rolling nightly release is tagged `nightly`, every other one v<version>. WISP_SHELL_URL stands in
// for the release folder (an install QA run, a fork's releases).
export const releaseUrl = (version: string, env: Env = process.env): string =>
  (env['WISP_SHELL_URL'] || `${RELEASES}/${/-nightly\./.test(version) ? 'nightly' : `v${version}`}`).replace(/\/$/, '');

/** The sha256 a SHA256SUMS.txt gives for one file (sha256sum and shasum lines, CRLF or not), or null. */
export function sumFor(sums: string, name: string): string | null {
  for (const line of String(sums).split(/\r?\n/)) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (m && m[2] === name && m[1]) return m[1].toLowerCase();
  }
  return null;
}

const tarBin = (): string => (process.platform === 'win32' ? path.join(process.env['SystemRoot'] || 'C:\\Windows', 'System32', 'tar.exe') : 'tar');

async function isFile(p: string): Promise<boolean> {
  return fs.stat(p).then((s) => s.isFile(), () => false);
}

class ShellError extends Error {
  readonly reason: ShellReason;
  constructor(reason: ShellReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

function causeOf(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause: unknown = err.cause;
  const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
  return typeof code === 'string' && code ? code : err.name;
}

async function get(url: string, fetchImpl: Fetch, timeout: number): Promise<Buffer> {
  let res: Response;
  try {
    res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(timeout) });
  } catch (err) {
    throw new ShellError('offline', `couldn't reach ${new URL(url).host} (${causeOf(err)})`);
  }
  if (res.status === 404) throw new ShellError('missing', `${url} isn't there`);
  if (!res.ok) throw new ShellError('offline', `${url} answered ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export interface ShellOptions {
  version: string;
  home?: string | undefined;
  platform?: string;
  arch?: string;
  env?: Env;
  fetch?: Fetch;
  say?: (line: string) => void;
}

/** The shell's executable, downloaded and checked on first use, or why there is none. */
export async function desktopShell(opts: ShellOptions): Promise<ShellResult> {
  const { version, platform = process.platform, arch = process.arch, env = process.env, say = () => {} } = opts;
  const fetchImpl: Fetch = opts.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const name = shellAsset(platform, arch);
  if (!name) return { exe: null, reason: 'platform', message: `no wisp app for ${platform} ${arch}` };
  const dir = shellDir(version, opts.home ?? (env['WISP_HOME'] || path.join(os.homedir(), '.wisp')));
  const exe = shellExe(dir, platform);
  if (await isFile(exe)) return { exe };
  const part = `${dir}.part-${process.pid}`;
  try {
    await fetchAndUnpack({ base: releaseUrl(version, env), name, version, part, dir, exe, platform, fetchImpl, say });
    return { exe };
  } catch (err) {
    return { exe: null, reason: err instanceof ShellError ? err.reason : 'unpack', message: err instanceof Error ? err.message : String(err) };
  } finally {
    await fs.rm(part, { recursive: true, force: true });
  }
}

interface Unpack {
  base: string;
  name: string;
  version: string;
  part: string;
  dir: string;
  exe: string;
  platform: string;
  fetchImpl: Fetch;
  say: (line: string) => void;
}

async function fetchAndUnpack(u: Unpack): Promise<void> {
  const sums = (await get(`${u.base}/SHA256SUMS.txt`, u.fetchImpl, SUMS_TIMEOUT)).toString('utf8');
  const want = sumFor(sums, u.name);
  if (!want) throw new ShellError('missing', `wisp ${u.version} has no ${u.name}`);
  u.say(`  ◌ getting the wisp app for ${u.version} (once)…`);
  const body = await get(`${u.base}/${u.name}`, u.fetchImpl, SHELL_TIMEOUT);
  if (createHash('sha256').update(body).digest('hex') !== want) throw new ShellError('checksum', `${u.name} doesn't match SHA256SUMS.txt`);
  await fs.rm(u.part, { recursive: true, force: true });
  await fs.mkdir(u.part, { recursive: true });
  const file = path.join(u.part, u.name);
  await fs.writeFile(file, body);
  try {
    // From inside the folder: Git Bash's GNU tar on PATH takes C:\ for a host name.
    await promisify(execFile)(tarBin(), ['-xzf', u.name], { cwd: u.part });
  } catch (err) {
    throw new ShellError('unpack', `couldn't unpack ${u.name}: ${(err instanceof Error ? err.message : String(err)).split('\n')[0]}`);
  }
  await fs.rm(file);
  if (!(await isFile(shellExe(u.part, u.platform)))) throw new ShellError('unpack', `${u.name} holds no wisp app`);
  // Into place in one step, so a half-written folder is never taken for a shell. Another wisp may have
  // got there first: its copy is as good.
  await fs.mkdir(path.dirname(u.dir), { recursive: true });
  await fs.rm(u.dir, { recursive: true, force: true });
  try {
    await fs.rename(u.part, u.dir);
  } catch (err) {
    if (!(await isFile(u.exe))) throw new ShellError('unpack', err instanceof Error ? err.message : String(err));
  }
}

/** How the CLI starts the shell: detached, the server on this Node from this package. */
export function shellEnv(env: Env, { port, root, node = process.execPath }: { port: number; root: string; node?: string }): Env {
  const out: Env = { ...env, WISP_PORT: String(port), WISP_NODE: node, WISP_ROOT: root };
  delete out['ELECTRON_RUN_AS_NODE']; // the Mac shell would turn itself into Node (macos::be_node_for_electron)
  return out;
}

export const noAppLine = (message: string): string => `  ◌ no wisp app here (${message}): opening a browser tab. The app: ${GET_APP}`;
