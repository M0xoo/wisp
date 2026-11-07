// A pipes-only proc for the tests (the plugin itself only ever gets the kernel's proc service).
import { spawn } from 'node:child_process';
import type { StdioChild } from '../../src/client.ts';

export function pipes(): { spawn(bin: string, args: readonly string[], o: { cwd: string }): StdioChild; killAll(): void; started: string[] } {
  const live = new Set<ReturnType<typeof spawn>>();
  const started: string[] = [];
  return {
    started,
    killAll: () => live.forEach((c) => c.kill('SIGKILL')),
    spawn(bin, args, o) {
      started.push([bin, ...args].join(' '));
      const c = spawn(bin, [...args], { cwd: o.cwd, stdio: ['pipe', 'pipe', 'ignore'] });
      live.add(c);
      c.stdin.on('error', () => {});
      return {
        onStdout: (fn) => c.stdout.on('data', fn),
        write: (d) => void c.stdin.write(d),
        kill: (s) => void c.kill((s ?? 'SIGTERM') as NodeJS.Signals),
        exited: new Promise((resolve, reject) => (c.on('error', reject), c.on('exit', () => (live.delete(c), resolve(undefined))))),
      };
    },
  };
}

export const realLater = (ms: number, fn: () => void): (() => void) => {
  const t = setTimeout(fn, ms);
  t.unref();
  return () => clearTimeout(t);
};
