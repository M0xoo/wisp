// The prompt boxes' own keys (v1 web/js/prompt-history.js, launcher.js modeKey; F-task-31, F-comp-4): ↑ in an empty
// box brings back the last prompt sent (the last 50, here in this browser), ↑ again the one before, ↓ forward and
// past the newest empties it; Shift+Tab cycles Plan → Edits → Full auto. DOM-free but for the event it reads.
import type { Json, PluginClient, PluginStore } from '@wisp/client';

export const MAX_SENT = 50;
const MODES = ['plan', 'edits', 'auto'] as const;
export type PromptMode = (typeof MODES)[number];

/** Shift+Tab: plan → edits → auto → plan */
export const nextMode = (m: string): PromptMode => MODES[(MODES.indexOf(m as PromptMode) + 1) % MODES.length] ?? 'auto';

/** The list with `text` as the newest (once, however often it was sent), at most MAX_SENT long. */
export function remember(list: readonly string[], text: string): string[] {
  const t = text.trim();
  if (!t) return [...list];
  return [...list.filter((x) => x !== t), t].slice(-MAX_SENT);
}

/**
 * What ↑ or ↓ does: `{ at, value }` puts list[at] in the box (`at: null`: back to an empty box); `null` leaves the key
 * to the textarea. Browsing goes on only while the box still holds the entry as it was: an edited entry is a draft.
 */
export function historyStep(i: {
  readonly key: string;
  readonly value: string;
  readonly list: readonly string[];
  readonly at: number | null;
  readonly firstLine: boolean;
  readonly lastLine: boolean;
}): { at: number | null; value: string } | null {
  const browsing = i.at !== null && i.list[i.at] === i.value;
  if (i.key === 'ArrowUp' && i.firstLine && (browsing || !i.value.trim())) {
    const next = browsing && i.at !== null ? i.at - 1 : i.list.length - 1;
    const v = i.list[next];
    return next >= 0 && v !== undefined ? { at: next, value: v } : null;
  }
  if (i.key === 'ArrowDown' && i.lastLine && browsing && i.at !== null) {
    const v = i.list[i.at + 1];
    return v !== undefined ? { at: i.at + 1, value: v } : { at: null, value: '' };
  }
  return null;
}

/** keyed by the root client: `plugin('shell')` gives a new client each call, and a store is defined once */
const stores = new WeakMap<object, PluginStore<Json>>();

/** The prompts sent from this browser, oldest first (the shell's client's store). */
export function sentStore(root: { plugin(id: string): PluginClient }): PluginStore<Json> {
  const had = stores.get(root);
  if (had) return had;
  const client = root.plugin('shell');
  const store = client.defineStore<Json>({ id: 'shell.sent', version: 1, defaults: [], persist: true, check: (v) => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : undefined) });
  stores.set(root, store);
  return store;
}

/**
 * One box's keys: call from its keydown (after its menus). True when the key was taken. `mode`: the box's mode and how
 * to change it, when it has one.
 */
export function promptKeys(o: {
  readonly sent: () => readonly string[];
  readonly value: () => string;
  readonly set: (v: string) => void;
  readonly mode?: { readonly get: () => string; readonly set: (m: PromptMode) => void };
}): (e: KeyboardEvent) => boolean {
  let at: number | null = null;
  return (e) => {
    if (e.isComposing || e.altKey || e.metaKey || e.ctrlKey) return false;
    if (e.key === 'Tab' && e.shiftKey && o.mode) {
      e.preventDefault();
      o.mode.set(nextMode(o.mode.get()));
      return true;
    }
    if (e.shiftKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return false;
    const el = e.currentTarget as HTMLTextAreaElement | null;
    if (el && el.selectionStart !== el.selectionEnd) return false;
    const text = o.value();
    const pos = el?.selectionStart ?? 0;
    const step = historyStep({ key: e.key, value: text, list: o.sent(), at, firstLine: !text.slice(0, pos).includes('\n'), lastLine: !text.slice(pos).includes('\n') });
    if (!step) return false;
    e.preventDefault();
    at = step.at;
    o.set(step.value);
    return true;
  };
}
