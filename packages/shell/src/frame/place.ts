// Each task keeps its place (v1 split.js keepPlace / backToPlace, F-task-17): where it was scrolled when you left it,
// so going back, or a reload, lands on the same spot. Held by the turn at the top of the pane and how far into it, so a
// turn landing meanwhile or older ones folding away don't shift what was being read; at the end, back to the end, new
// turns and all. DOM-free: the box's numbers and the turns' tops come in.
import type { Json, PluginClient, PluginStore } from '@wisp/client';

export interface Place {
  readonly end: boolean;
  /** the turn at the top of the pane, and how far its top sits above the pane's top (px) */
  readonly turn?: string;
  readonly dy: number;
  /** the raw offset, when no turn can say */
  readonly top: number;
}

export interface Box {
  readonly scrollTop: number;
  readonly clientHeight: number;
  readonly scrollHeight: number;
}

/** The place to keep, or undefined at the very top (nothing to come back to). `turns`: each turn's top in the box's content. */
export function placeOf(box: Box, turns: readonly { readonly id: string; readonly top: number }[]): Place | undefined {
  if (box.scrollTop < 1) return undefined;
  const end = box.scrollTop + box.clientHeight >= box.scrollHeight - 4;
  // the last turn whose top is at or above the pane's top
  const at = [...turns].reverse().find((t) => t.top <= box.scrollTop + 1);
  return { end, ...(at && { turn: at.id }), dy: at ? box.scrollTop - at.top : 0, top: box.scrollTop };
}

/** Where to scroll to on coming back. */
export function scrollFor(p: Place, box: Pick<Box, 'clientHeight' | 'scrollHeight'>, turns: readonly { readonly id: string; readonly top: number }[]): number {
  const max = Math.max(0, box.scrollHeight - box.clientHeight);
  if (p.end) return max;
  const t = p.turn !== undefined ? turns.find((x) => x.id === p.turn) : undefined;
  return Math.min(max, Math.max(0, t ? t.top + p.dy : p.top));
}

/** v1 MAX_PLACES: the most recent tasks' places are kept, the oldest go first. */
export const MAX_PLACES = 100;

/** The kept places with `id`'s set (newest last) or dropped, at most MAX_PLACES. */
export function keep(all: Readonly<Record<string, Place>>, id: string, p: Place | undefined): Record<string, Place> {
  const rest = Object.entries(all).filter(([k]) => k !== id);
  const next = p ? [...rest, [id, p] as const] : rest;
  return Object.fromEntries(next.slice(-MAX_PLACES));
}

const stores = new WeakMap<object, PluginStore<Json>>();

/** The kept places, in this browser (v1 localStorage wisp.places): the shell's client's store. */
export function placesStore(root: { plugin(id: string): PluginClient }): PluginStore<Json> {
  const had = stores.get(root);
  if (had) return had;
  const store = root
    .plugin('shell')
    .defineStore<Json>({ id: 'shell.places', version: 1, defaults: {}, persist: true, check: (v) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined) });
  stores.set(root, store);
  return store;
}
