// Scopes (plan §6.4, Obsidian's components): everything a plugin registers is owned by one, and
// deactivating a plugin is disposing its scope. Disposal runs in reverse order of registration, children
// first, exactly once; a failing disposer doesn't stop the others.
import type { Disposable, Scope } from './contract.ts';
import { detached } from './trace-context.ts';

/** The timer functions a scope uses; tests pass a fake clock's. */
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
}

export const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export interface ScopeOptions {
  timers?: Timers;
  /** a disposer or a timer callback threw */
  onError?: (err: unknown, scope: string) => void;
}

const asDisposable = (d: Disposable | (() => void)): Disposable => (typeof d === 'function' ? { dispose: d } : d);

export class ScopeImpl implements Scope {
  readonly name: string;
  readonly #ac = new AbortController();
  readonly #items: Disposable[] = [];
  readonly #opts: ScopeOptions;
  #alive = true;

  constructor(name: string, opts: ScopeOptions = {}) {
    this.name = name;
    this.#opts = opts;
  }
  get signal(): AbortSignal {
    return this.#ac.signal;
  }
  get alive(): boolean {
    return this.#alive;
  }
  /** live registrations, children included (the testkit's leak check reads it) */
  get size(): number {
    return this.#items.length;
  }

  add(d: Disposable | (() => void)): void {
    const item = asDisposable(d);
    if (!this.#alive) {
      this.#run(item); // too late to own it: free it now rather than leak it
      return;
    }
    this.#items.push(item);
  }

  /** Remove a registration without disposing it (it was freed on its own). */
  forget(d: Disposable): void {
    const i = this.#items.indexOf(d);
    if (i >= 0) this.#items.splice(i, 1);
  }

  child(name: string): ScopeImpl {
    const c = new ScopeImpl(`${this.name}/${name}`, this.#opts);
    const entry: Disposable = { dispose: () => c.dispose() };
    this.add(entry);
    // a child disposed on its own leaves its parent's list
    c.add(() => this.forget(entry));
    return c;
  }

  timeout(ms: number, fn: () => void): void {
    const t = this.#opts.timers ?? realTimers;
    const entry: Disposable = { dispose: () => t.clearTimeout(h) };
    const h = t.setTimeout(() => {
      this.forget(entry);
      this.#guard(fn);
    }, ms);
    this.add(entry);
  }

  interval(ms: number, fn: () => void): void {
    const t = this.#opts.timers ?? realTimers;
    const h = t.setInterval(() => this.#guard(fn), ms);
    this.add({ dispose: () => t.clearInterval(h) });
  }

  dispose(): void {
    if (!this.#alive) return;
    this.#alive = false;
    this.#ac.abort(new Error(`scope ${this.name} disposed`));
    while (this.#items.length) {
      const d = this.#items.pop();
      if (d) this.#run(d);
    }
  }

  #guard(fn: () => void): void {
    // a timer's callback never belongs to the call that scheduled it
    detached(() => {
      try {
        fn();
      } catch (err) {
        this.#opts.onError?.(err, this.name);
      }
    });
  }

  #run(d: Disposable): void {
    try {
      d.dispose();
    } catch (err) {
      this.#opts.onError?.(err, this.name);
    }
  }
}

export const createScope = (name: string, opts?: ScopeOptions): ScopeImpl => new ScopeImpl(name, opts);
