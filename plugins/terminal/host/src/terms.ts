// Terminals inside wisp (v1 server/pty.js Terms): take over a session in the page instead of a
// terminal app, which a wisp Grid (or any server without a desktop) doesn't have. One terminal per
// task and kind; its output is kept so a page that opens later sees the screen.
//
// The PTY itself comes from the kernel's proc service (`spawn(…, { pty })`: wisp-native, or its
// Python fallback). Every terminal walks the flow in flow.ts; a closed one leaves the registry at once
// (as v1's did) and finishes stopping on its own, so a restart never waits for, or races, a dying one.

import type { InputOrder as Order, TermInfo, TermKind, TermState } from '@wisp-plugin/terminal-api';
import { type Env, termEnv } from './env.ts';
import { type FlowEvent, isLive, isOver, SLOW_MS, step } from './flow.ts';
import { InputOrder, type Later } from './order.ts';
import { Screen } from './screen.ts';

export const GONE_MS = 10 * 60_000; // an exited terminal is forgotten after this
export const PING_MS = 25_000; // keeps proxies (a machine's tunnel, the grid's edge) from timing the stream out
export const ACTIVE_MS = 15 * 60_000; // a terminal used this recently keeps a cloud computer awake

/** The part of the kernel's proc service a terminal needs (structural, so any proc satisfies it). */
export interface PtyChild {
  readonly pid: number;
  onStdout(fn: (chunk: Uint8Array) => void): { dispose(): void };
  onStderr(fn: (chunk: Uint8Array) => void): { dispose(): void };
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
}
export interface PtySpawner {
  spawn(bin: string, args: readonly string[], opts: { cwd: string; env: Record<string, string>; pty: { cols: number; rows: number }; tree: boolean }): PtyChild;
}

/** One page streaming a terminal: an SSE response, written as v1 wrote it. */
export interface Sink {
  write(s: string): void;
  end(s?: string): void;
  onClose(fn: () => void): void;
}

export interface TermsOptions {
  kind: TermKind;
  proc: PtySpawner;
  env: Env;
  later: Later;
  now?: () => number;
  /** its state moved (open, ready, slow, ended, gone) */
  onChange?: (info: TermInfo | { id: string; kind: TermKind; state: 'gone' }) => void;
}

const clampSize = (n: unknown, lo: number, hi: number, d: number): number => (Number.isFinite(Number(n)) && n !== null && n !== '' ? Math.min(hi, Math.max(lo, Math.round(Number(n)))) : d);
const frame = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const GONE = frame('gone', {});

interface Term {
  id: string;
  child: PtyChild | null;
  cwd: string;
  cols: number;
  rows: number;
  resizable: boolean;
  state: TermState;
  code: number | null;
  startedAt: number;
  usedAt: number;
  tui: boolean;
  clients: Set<Sink>;
  screen: Screen;
  order: InputOrder;
  cancels: (() => void)[];
}

export class Terms {
  readonly #map = new Map<string, Term>();
  readonly #o: TermsOptions;
  readonly #now: () => number;

  constructor(o: TermsOptions) {
    this.#o = o;
    this.#now = o.now ?? Date.now;
  }

  get kind(): TermKind {
    return this.#o.kind;
  }

  info(id: string): TermInfo | null {
    const t = this.#map.get(id);
    return t ? this.#info(t) : null;
  }

  /** A program is on it now (v1: `get(id)?.code === null`). */
  live(id: string): boolean {
    const t = this.#map.get(id);
    return !!t && isLive(t.state);
  }

  /** Kept output, for tests and the replay. */
  screen(id: string): string | null {
    return this.#map.get(id)?.screen.read() ?? null;
  }

  ids(): string[] {
    return [...this.#map.keys()];
  }

  /** Start a terminal for task id, or return the one still running. argv runs in cwd. */
  open(id: string, a: { argv: readonly string[]; cwd: string; cols?: unknown; rows?: unknown; tui?: boolean }): TermInfo {
    const live = this.#map.get(id);
    if (live && isLive(live.state)) return this.#info(live);
    if (live) this.#forget(id);
    const [bin, ...args] = a.argv;
    const t: Term = {
      id, child: null, cwd: a.cwd, cols: clampSize(a.cols, 20, 500, 100), rows: clampSize(a.rows, 5, 200, 30), resizable: true,
      state: 'idle', code: null, startedAt: this.#now(), usedAt: this.#now(), tui: !!a.tui, clients: new Set(), screen: new Screen(),
      order: new InputOrder((d) => t.child?.write(d), this.#o.later), cancels: [],
    };
    this.#map.set(id, t);
    this.#move(t, 'START');
    t.cancels.push(this.#o.later(SLOW_MS, () => this.#move(t, 'SLOW')));
    try {
      if (!bin) throw new Error('nothing to run');
      t.child = this.#o.proc.spawn(bin, args, { cwd: a.cwd, env: termEnv(this.#o.env, this.#o.kind === 'takeover'), pty: { cols: t.cols, rows: t.rows }, tree: true });
    } catch (e) {
      this.#emit(t, `wisp: couldn’t start a terminal (${e instanceof Error ? e.message : String(e)})\r\n`, false);
      this.#end(t, 127);
      return this.#info(t);
    }
    this.#wire(t, t.child);
    return this.#info(t);
  }

  #wire(t: Term, child: PtyChild): void {
    const dec = new TextDecoder('utf-8');
    child.onStdout((d) => this.#emit(t, dec.decode(d, { stream: true })));
    child.onStderr((d) => this.#emit(t, new TextDecoder().decode(d).replace(/\r?\n/g, '\r\n')));
    child.exited.then(
      ({ code, signal }) => {
        this.#emit(t, dec.decode());
        this.#end(t, code ?? (signal ? 129 : 1));
      },
      (e: unknown) => (this.#emit(t, `wisp: couldn’t start a terminal (${e instanceof Error ? e.message : String(e)})\r\n`, false), this.#end(t, 127)),
    );
  }

  /** ready: the program printed it (wisp's own "couldn't start" line doesn't make it ready) */
  #emit(t: Term, text: string, ready = true): void {
    if (!text) return;
    t.screen.push(text);
    t.usedAt = this.#now();
    if (ready && (t.state === 'starting' || t.state === 'slow')) this.#move(t, 'READY');
    const f = frame('data', text);
    for (const res of t.clients) res.write(f);
  }

  #end(t: Term, code: number): void {
    if (t.code !== null) return;
    t.code = code;
    // 127 before it printed anything: it never ran (a missing program), which is a failed start
    this.#move(t, t.state === 'stopping' ? 'DONE' : code === 127 && t.state !== 'running' ? 'FAIL' : 'EXIT');
    const f = frame('exit', { code });
    for (const res of t.clients) res.write(f);
    if (this.#map.get(t.id) !== t) return this.#drop(t); // closed while stopping: nobody keeps it
    t.cancels.push(this.#o.later(GONE_MS, () => this.#map.get(t.id) === t && this.#forget(t.id)));
  }

  #move(t: Term, e: FlowEvent): void {
    const next = step(t.state, e);
    if (next === t.state) return;
    t.state = next;
    if (this.#map.get(t.id) === t) this.#o.onChange?.(this.#info(t));
  }

  /** Server-sent events: hello (start over), data (output, a JSON string), exit ({ code }), gone. */
  attach(id: string, res: Sink): void {
    const t = this.#map.get(id);
    if (!t) return res.end(GONE);
    // ordered: numbered input goes in in order (input()), so the page needn't wait between sends.
    res.write(frame('hello', { cols: t.cols, rows: t.rows, resizable: t.resizable, ordered: true, state: t.state }));
    res.write(frame('data', t.screen.read())); // always, even empty: the page replays it
    if (isOver(t.state)) return res.end(frame('exit', { code: t.code }));
    t.clients.add(res);
    const stopPing = this.#every(PING_MS, () => res.write(': ping\n\n'));
    res.onClose(() => (stopPing(), t.clients.delete(res)));
  }

  #every(ms: number, fn: () => void): () => void {
    let stop = (): void => {};
    let on = true;
    const tick = (): void => {
      if (!on) return;
      fn();
      stop = this.#o.later(ms, tick);
    };
    stop = this.#o.later(ms, tick);
    return () => ((on = false), stop());
  }

  /** Typed text, numbered or not (an older page sends it plain). */
  input(id: string, data: string, o: Order = {}): boolean {
    const t = this.#map.get(id);
    if (!t || !isLive(t.state) || !t.child) return false;
    t.usedAt = this.#now();
    if (Number.isInteger(o.seq) && typeof o.from === 'string') t.order.put(String(data), o.seq ?? 0, o.from);
    else t.child.write(String(data));
    return true;
  }

  resize(id: string, cols: unknown, rows: unknown): boolean {
    const t = this.#map.get(id);
    if (!t || !isLive(t.state) || !t.resizable || !t.child) return false;
    t.cols = clampSize(cols, 20, 500, t.cols);
    t.rows = clampSize(rows, 5, 200, t.rows);
    t.child.resize(t.cols, t.rows);
    return true;
  }

  /** STOP: a live one hangs up (a start in progress is cancelled); the registry forgets it now. */
  close(id: string): boolean {
    const t = this.#map.get(id);
    if (!t) return false;
    if (isLive(t.state)) {
      this.#move(t, 'STOP');
      t.child?.kill('SIGHUP');
    }
    this.#forget(id);
    return true;
  }

  /** Running terminals someone used lately (a cloud computer stays up for them). */
  active(now = this.#now()): number {
    let n = 0;
    for (const t of this.#map.values()) if (isLive(t.state) && (t.clients.size || now - t.usedAt < ACTIVE_MS)) n++;
    return n;
  }

  closeAll(): void {
    for (const id of [...this.#map.keys()]) this.close(id);
  }

  #forget(id: string): void {
    const t = this.#map.get(id);
    if (!t) return;
    this.#map.delete(id);
    for (const res of t.clients) res.end(GONE);
    t.clients.clear();
    if (t.state !== 'stopping') this.#drop(t);
    this.#o.onChange?.({ id, kind: this.#o.kind, state: 'gone' });
  }

  #drop(t: Term): void {
    for (const c of t.cancels.splice(0)) c();
    t.order.dispose();
  }

  #info(t: Term): TermInfo {
    return { id: t.id, kind: this.#o.kind, state: t.state, cols: t.cols, rows: t.rows, resizable: t.resizable, code: t.code, startedAt: t.startedAt, usedAt: t.usedAt, clients: t.clients.size, tui: t.tui };
  }
}
