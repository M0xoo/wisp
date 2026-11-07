// A real PTY for the tests, until @wisp/native's TypeScript side lands: v1's Python pty.fork helper
// (the same fallback @wisp/native keeps, ADR-0009), resized through fd 3. Test-only: the plugin
// itself never starts a process, the kernel's proc service does.
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { PtyChild, PtySpawner } from '../../src/terms.ts';

const HELPER = fileURLToPath(new URL('./pty-helper.py', import.meta.url));

export const hasPython = (): boolean => process.platform !== 'win32' && spawnSync('python3', ['-c', 'import pty, termios'], { stdio: 'ignore' }).status === 0;

export function realPty(): PtySpawner & { killAll(): void } {
  const live = new Set<ReturnType<typeof spawn>>();
  return {
    killAll: () => live.forEach((c) => c.kill('SIGKILL')),
    spawn(bin, args, o): PtyChild {
      const c = spawn('python3', [HELPER, String(o.pty.rows), String(o.pty.cols), bin, ...args], { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
      live.add(c);
      const ctl = c.stdio[3] as NodeJS.WritableStream | null;
      for (const s of [c.stdin, ctl]) s?.on('error', () => {});
      const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
        c.on('error', reject);
        c.on('exit', (code, signal) => (live.delete(c), resolve({ code, signal })));
      });
      return {
        pid: c.pid ?? 0,
        onStdout: (fn) => (c.stdout?.on('data', fn), { dispose: () => void c.stdout?.off('data', fn) }),
        onStderr: (fn) => (c.stderr?.on('data', fn), { dispose: () => void c.stderr?.off('data', fn) }),
        write: (d) => void c.stdin?.write(d),
        resize: (cols, rows) => void ctl?.write(`${rows} ${cols}\n`),
        kill: (sig = 'SIGTERM') => void c.kill(sig as NodeJS.Signals),
        exited,
      };
    },
  };
}

export const waitFor = async <T>(fn: () => T | Promise<T>, ms = 8000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};
