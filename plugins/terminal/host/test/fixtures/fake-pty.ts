// A child that is driven by the test: what it prints, when it exits, what it was given.
import type { PtyChild, PtySpawner } from '../../src/terms.ts';

export interface FakeChild extends PtyChild {
  typed: string[];
  sizes: [number, number][];
  killed: string[];
  print(s: string): void;
  printErr(s: string): void;
  exit(code: number | null, signal?: string | null): void;
}

export function fakeChild(): FakeChild {
  const out = new Set<(c: Uint8Array) => void>();
  const err = new Set<(c: Uint8Array) => void>();
  let done: (v: { code: number | null; signal: string | null }) => void = () => {};
  const exited = new Promise<{ code: number | null; signal: string | null }>((r) => (done = r));
  const c: FakeChild = {
    pid: 4242,
    typed: [],
    sizes: [],
    killed: [],
    onStdout: (fn) => (out.add(fn), { dispose: () => void out.delete(fn) }),
    onStderr: (fn) => (err.add(fn), { dispose: () => void err.delete(fn) }),
    write: (d) => void c.typed.push(typeof d === 'string' ? d : new TextDecoder().decode(d)),
    resize: (cols, rows) => void c.sizes.push([cols, rows]),
    kill: (sig = 'SIGTERM') => void c.killed.push(sig),
    exited,
    print: (s) => out.forEach((f) => f(new TextEncoder().encode(s))),
    printErr: (s) => err.forEach((f) => f(new TextEncoder().encode(s))),
    exit: (code, signal = null) => done({ code, signal }),
  };
  return c;
}

export interface FakeProc extends PtySpawner {
  calls: { bin: string; args: readonly string[]; cwd: string; env: Record<string, string>; pty: { cols: number; rows: number } }[];
  children: FakeChild[];
  fail?: Error;
}

export function fakeProc(): FakeProc {
  const p: FakeProc = {
    calls: [],
    children: [],
    spawn(bin, args, opts) {
      if (p.fail) throw p.fail;
      p.calls.push({ bin, args, cwd: opts.cwd, env: opts.env, pty: opts.pty });
      const c = fakeChild();
      p.children.push(c);
      return c;
    },
  };
  return p;
}

/** An SSE response that records what was written. */
export function sink(): { text: string; ended: boolean; close(): void; write(s: string): void; end(s?: string): void; onClose(fn: () => void): void } {
  let closer = (): void => {};
  const s = {
    text: '',
    ended: false,
    close: () => closer(),
    write: (x: string) => void (s.text += x),
    end: (x = '') => void ((s.text += x), (s.ended = true)),
    onClose: (fn: () => void) => void (closer = fn),
  };
  return s;
}

export const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
