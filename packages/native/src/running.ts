// Pieces both backends share: how a process reports its exit and its output.

import type { ExitInfo } from './types.ts';

/** Resolves once; late subscribers are called at once. */
export class ExitLatch {
  readonly exited: Promise<ExitInfo>;
  #info: ExitInfo | null = null;
  #fns = new Set<(e: ExitInfo) => void>();
  #resolve: (e: ExitInfo) => void = () => {};

  constructor() {
    this.exited = new Promise((resolve) => (this.#resolve = resolve));
  }

  get done(): boolean {
    return this.#info !== null;
  }

  finish(info: ExitInfo): void {
    if (this.#info) return;
    this.#info = info;
    this.#resolve(info);
    for (const fn of this.#fns) fn(info);
    this.#fns.clear();
  }

  onExit(fn: (e: ExitInfo) => void): () => void {
    if (this.#info) {
      fn(this.#info);
      return () => {};
    }
    this.#fns.add(fn);
    return () => this.#fns.delete(fn);
  }
}

/**
 * Output chunks. Chunks that arrive before anyone listens are held for the first subscriber: the
 * first lines a program prints come in right after it starts, before the caller has subscribed.
 */
export class DataFeed {
  #fns = new Set<(chunk: Buffer) => void>();
  #held: Buffer[] | null = [];

  push(chunk: Buffer): void {
    if (this.#held) this.#held.push(chunk);
    else for (const fn of this.#fns) fn(chunk);
  }

  on(fn: (chunk: Buffer) => void): () => void {
    this.#fns.add(fn);
    const held = this.#held;
    this.#held = null;
    if (held) for (const chunk of held) fn(chunk);
    return () => this.#fns.delete(fn);
  }
}

/** A terminal size from the caller, as a whole number in range. */
export function clampSize(n: number | undefined, fallback: number): number {
  if (n === undefined || !Number.isFinite(n)) return fallback;
  return Math.min(1000, Math.max(1, Math.round(n)));
}

export const DEFAULT_COLS = 100;
export const DEFAULT_ROWS = 30;
export const DEFAULT_GRACE_MS = 2000;
export const MAX_GRACE_MS = 60_000;

export const graceOf = (ms: number | undefined): number => Math.min(MAX_GRACE_MS, Math.max(0, ms ?? DEFAULT_GRACE_MS));

/** Exited processes kept so what they left behind can still be killed (as the binary keeps them). */
export const GONE_KEPT = 256;
