// The overlap note's × (v1 #787, overlaps.js DISMISSED): a closed note stays closed for that task, through a reload,
// until something new comes up: another task, another file or a conflict (or one going away: what it says changed).
// The Overlap / Clash pill stays either way. Kept in this browser, as v1 kept it in localStorage
// (wisp.overlapsDismissed): a per-viewer choice, not the task's data. DOM-free: the store comes in.
import type { Json, PluginClient, PluginStore } from '@wisp/client';
import type { OverlapRow } from './rows-view.ts';

/** task id → what its note said when it was closed */
export type Dismissed = Readonly<Record<string, string>>;

/** What a note says, v1's `said`: each overlap's task, files and conflicts, in task order (the ranking may move). */
export function said(all: readonly OverlapRow[]): string {
  return JSON.stringify(all.map((o) => [o.id, o.files, o.conflicts ?? null]).sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1)));
}

/** The overlaps to show for task `id`: none while it says what it said when closed. */
export function shownOverlaps(all: readonly OverlapRow[], dismissed: Dismissed | undefined, id: string): readonly OverlapRow[] {
  return all.length && dismissed?.[id] === said(all) ? [] : all;
}

/** v1 forgot tasks that were gone; v2's client holds only the tasks it has loaded, so it can't tell which are:
 * it keeps the most recently closed notes instead (the oldest go first), as the kept places do. */
export const MAX_DISMISSED = 200;

/** The kept map with `id`'s note closed on what it says now (newest last), at most MAX_DISMISSED. */
export function dismiss(all: Dismissed | undefined, id: string, overlaps: readonly OverlapRow[]): Record<string, string> {
  const kept = Object.entries(all ?? {}).filter(([k]) => k !== id);
  return Object.fromEntries([...kept, [id, said(overlaps)] as const].slice(-MAX_DISMISSED));
}

const stores = new WeakMap<object, PluginStore<Json>>();

/** The closed notes, in this browser: the shell's client's store (one per client). */
export function dismissedStore(root: { plugin(id: string): PluginClient }): PluginStore<Json> {
  const had = stores.get(root);
  if (had) return had;
  const store = root.plugin('shell').defineStore<Json>({
    id: 'shell.overlapsDismissed',
    version: 1,
    defaults: {},
    persist: true,
    check: (v) => (v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string') ? (v as Json) : undefined),
  });
  stores.set(root, store);
  return store;
}
