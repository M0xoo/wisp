// A real ProcService over node:child_process, for tests of plugins that run git and gh. Async only,
// as the server's (apps/server/src/services/proc.ts): exec never blocks the event loop.

import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Child, Disposable, ExecResult, ProcService, SpawnOptions } from '@wisp/kernel';

export type { Child, ExecResult, ProcService, SpawnOptions };

export interface RecordedCall {
  bin: string;
  args: readonly string[];
  cwd: string | undefined;
  ms: number;
}

const cleanEnv = (env: Record<string, string | undefined> | undefined): NodeJS.ProcessEnv => {
  const out: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(env ?? {})) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
};

function child(bin: string, args: readonly string[], opts: SpawnOptions = {}): Child {
  const p = nodeSpawn(bin, [...args], { cwd: opts.cwd, env: cleanEnv(opts.env), stdio: [opts.stdin === 'pipe' ? 'pipe' : 'ignore', 'pipe', 'pipe'], signal: opts.signal });
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    p.on('error', () => resolve({ code: null, signal: null }));
    p.on('close', (code, signal) => resolve({ code, signal }));
  });
  const on = (s: NodeJS.ReadableStream | null, fn: (c: Uint8Array) => void): Disposable => {
    s?.on('data', fn);
    return { dispose: () => void s?.off('data', fn) };
  };
  return {
    pid: p.pid ?? -1,
    onStdout: (fn) => on(p.stdout, fn),
    onStderr: (fn) => on(p.stderr, fn),
    write: (d) => void p.stdin?.write(d),
    closeStdin: () => void p.stdin?.end(),
    resize: () => {},
    kill: (sig = 'SIGTERM') => void p.kill(sig),
    exited,
  };
}

/** spawn's ENOENT, as exec reports it: code null and the error in stderr. */
async function exec(bin: string, args: readonly string[], opts: SpawnOptions & { input?: string; maxBuffer?: number } = {}): Promise<ExecResult> {
  const max = opts.maxBuffer ?? 64 * 1024 * 1024;
  return new Promise((resolve) => {
    const p = nodeSpawn(bin, [...args], { cwd: opts.cwd, env: cleanEnv(opts.env), stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    const timer = opts.timeoutMs ? setTimeout(() => ((timedOut = true), p.kill('SIGKILL')), opts.timeoutMs) : undefined;
    p.stdout?.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) p.kill('SIGKILL');
      else out.push(c);
    });
    p.stderr?.on('data', (c: Buffer) => err.push(c));
    if (opts.input !== undefined) p.stdin?.end(opts.input);
    let failed: Error | undefined;
    p.on('error', (e) => (failed = e));
    p.on('close', (code) => {
      clearTimeout(timer);
      const stderr = Buffer.concat(err).toString('utf8') + (failed ? `${(failed as NodeJS.ErrnoException).code ?? ''} ${failed.message}` : '');
      resolve({ code: failed ? null : code, stdout: Buffer.concat(out).toString('utf8'), stderr, timedOut });
    });
  });
}

async function which(bin: string, env?: Record<string, string | undefined>): Promise<string | null> {
  if (bin.includes('/')) return (await fs.access(bin).then(() => true, () => false)) ? bin : null;
  for (const dir of (env?.['PATH'] ?? process.env['PATH'] ?? '').split(path.delimiter).filter(Boolean)) {
    const p = path.join(dir, bin);
    if (await fs.access(p, fs.constants.X_OK).then(() => true, () => false)) return p;
  }
  return null;
}

/** The test proc service; `calls` records every exec (bench counts and "no git ran" checks). */
export function nodeProc(): ProcService & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    which,
    spawn: child,
    async exec(bin, args, opts) {
      const t = performance.now();
      try {
        return await exec(bin, args, opts);
      } finally {
        calls.push({ bin, args, cwd: opts?.cwd, ms: performance.now() - t });
      }
    },
  };
}
