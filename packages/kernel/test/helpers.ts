// Shared test helpers: manifest builders, a seeded random, waits.
import type { Manifest, PluginDef } from '../src/contract.ts';

export function manifest(id: string, extra: Partial<Manifest> & Record<string, unknown> = {}): Manifest {
  return { wispPlugin: 1, id, version: '1.0.0', api: '^1', ...extra } as Manifest;
}

/** A plugin def from a setup function. */
export const def = (id: string, setup: PluginDef['setup']): PluginDef => ({ id, setup });

/** mulberry32: a tiny seeded PRNG, so a failing model test can be replayed by its seed. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wait until `fn` is true, polling; fails after `ms`. */
export async function until(fn: () => boolean, ms = 3000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** The rejection of `p`, for asserting on codes. */
export async function rejection(p: Promise<unknown>): Promise<{ code: string; message: string; details?: unknown }> {
  try {
    await p;
  } catch (e) {
    return e as { code: string; message: string; details?: unknown };
  }
  throw new Error('expected a rejection');
}
