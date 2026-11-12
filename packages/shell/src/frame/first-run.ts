// The first-run launcher (v1 launcher.js firstRun, F-comp-35): until your first task the box is the prompt, how it runs
// (mode, harness) and Send; Where, vs, Delegate, Goal, Worktree and Later wait behind More options. Once opened, or
// once there's a task of yours, it stays full, kept in this browser.
import type { Json, PluginClient, PluginStore } from '@wisp/client';
import type { LauncherTool } from '@wisp/ui';

/** what a first run keeps of each group of the bar: attach (it's how a prompt gets its files) */
const KEEP: Readonly<Record<'lead' | 'mid' | 'tail', readonly string[]>> = { lead: ['attach'], mid: [], tail: [] };

/** First run: not opened yet (`full`), no task of yours yet, and the saved answer is in (no flash for a returning user). */
export const firstRunOf = (full: boolean, mine: boolean, ready = true): boolean => ready && !full && !mine;

/** The bar's group as the first run shows it: what it keeps, and More options at the end of the tail. */
export function firstRunTools(first: boolean, group: 'lead' | 'mid' | 'tail', tools: readonly LauncherTool[], more?: LauncherTool): LauncherTool[] {
  if (!first) return [...tools];
  return [...tools.filter((x) => KEEP[group].includes(x.id)), ...(group === 'tail' && more ? [more] : [])];
}

/** keyed by the root client: `plugin('shell')` gives a new client each call, and a store is defined once */
const stores = new WeakMap<object, PluginStore<Json>>();

/** Whether the launcher has been opened full in this browser (the shell's client's store). */
export function launcherFull(root: { plugin(id: string): PluginClient }): PluginStore<Json> {
  const had = stores.get(root);
  if (had) return had;
  const client = root.plugin('shell');
  const store = client.defineStore<Json>({ id: 'shell.launcherFull', version: 1, defaults: false, persist: true, check: (v) => (typeof v === 'boolean' ? v : undefined) });
  stores.set(root, store);
  return store;
}
