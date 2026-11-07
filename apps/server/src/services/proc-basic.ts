// A plain-pipes `proc` service, until the terminal agent's apps/server/src/services/proc.ts (wisp-native
// PTYs and process trees) lands: boot takes that one when it is passed in. No PTY here; `pty` asks fail.
import { spawn as nodeSpawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import path from 'node:path';
import type { Child, Disposable, ExecResult, ProcService, SpawnOptions } from '@wisp/kernel';

const win = process.platform === 'win32';

async function which(bin: string, env: Record<string, string | undefined> = process.env): Promise<string | null> {
  if (bin.includes('/') || (win && bin.includes('\\'))) return (await executable(bin)) ? bin : null;
  const exts = win ? String(env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of String(env['PATH'] ?? env['Path'] ?? '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const p = path.join(dir, bin + ext);
      if (await executable(p)) return p;
    }
  }
  return null;
}

async function executable(p: string): Promise<boolean> {
  try {
    await access(p, win ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const listen = (stream: NodeJS.ReadableStream | null, fn: (c: Uint8Array) => void): Disposable => {
  stream?.on('data', fn);
  return { dispose: () => stream?.off('data', fn) };
};

function spawn(bin: string, args: readonly string[], opts: SpawnOptions = {}): Child {
  if (opts.pty) throw new Error('this wisp has no PTY support yet (wisp-native is not loaded)');
  const env = opts.env ? Object.fromEntries(Object.entries(opts.env).filter((e): e is [string, string] => e[1] !== undefined)) : process.env;
  // a .cmd shim on Windows runs through the shell, as v1's resolveCommand did
  const cp = nodeSpawn(bin, [...args], { cwd: opts.cwd, env, stdio: [opts.stdin ?? 'pipe', 'pipe', 'pipe'], detached: !win && opts.tree !== false, shell: win && /\.(cmd|bat)$/i.test(bin), ...(opts.signal && { signal: opts.signal }), ...(opts.timeoutMs && { timeout: opts.timeoutMs }) });
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    cp.once('error', () => resolve({ code: -1, signal: null }));
    cp.once('close', (code, signal) => resolve({ code, signal }));
  });
  const kill = (signal: 'SIGTERM' | 'SIGKILL' | 'SIGINT' = 'SIGTERM'): void => {
    try {
      // the whole group: a harness's own children go with it
      if (!win && opts.tree !== false && cp.pid) process.kill(-cp.pid, signal);
      else cp.kill(signal);
    } catch {
      cp.kill(signal);
    }
  };
  return {
    pid: cp.pid ?? -1,
    onStdout: (fn) => listen(cp.stdout, fn),
    onStderr: (fn) => listen(cp.stderr, fn),
    write: (d) => void cp.stdin?.write(d),
    closeStdin: () => void cp.stdin?.end(),
    resize: () => undefined,
    kill,
    exited,
  };
}

async function exec(bin: string, args: readonly string[], opts: SpawnOptions & { input?: string; maxBuffer?: number } = {}): Promise<ExecResult> {
  const max = opts.maxBuffer ?? 10 * 1024 * 1024;
  const child = spawn(bin, args, { ...opts, tree: opts.tree ?? false });
  const out: Uint8Array[] = [];
  const err: Uint8Array[] = [];
  let size = 0;
  let timedOut = false;
  const keep = (to: Uint8Array[]) => (c: Uint8Array) => {
    size += c.length;
    if (size <= max) to.push(c);
  };
  child.onStdout(keep(out));
  child.onStderr(keep(err));
  if (opts.input !== undefined) child.write(opts.input);
  child.closeStdin();
  const timer = opts.timeoutMs ? setTimeout(() => ((timedOut = true), child.kill('SIGKILL')), opts.timeoutMs) : undefined;
  const { code } = await child.exited;
  if (timer) clearTimeout(timer);
  return { code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), timedOut };
}

export const basicProc = (): ProcService => ({ which, spawn, exec });
