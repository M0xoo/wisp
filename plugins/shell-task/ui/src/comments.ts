// Comments on lines of the side panel's Changes, like a review (v1 comments.js, comment-text.js): each waits above
// the reply box, numbered, and goes out at the top of the next follow-up in v1's words, so the agent knows exactly
// which line you meant. DOM-free: the rules and the text; the store holds them per task until they go.
//
//   <comments>
//   1. On "server/auth.js", line 40:
//   > const ttl = 60
//   Make this configurable.
//   </comments>
//
//   Also run the tests.
import type { Json, PluginClient, PluginStore } from '@wisp/client';

export interface LineComment {
  /** the file as it is now */
  readonly file: string;
  /** a line only removed has only its old number */
  readonly side: 'new' | 'old';
  readonly line: number;
  readonly code: string;
  readonly note: string;
}

/** The row's key in its file: `n12` (a line as it is now) or `o12` (a removed line, numbered as before). */
export const lineKey = (side: 'new' | 'old', line: number): string => `${side === 'old' ? 'o' : 'n'}${line}`;

/** A diff row → the comment's place, or nothing for a row with no number (a gap). */
export function placeOf(
  file: string,
  row: { readonly op: string; readonly a?: number | undefined; readonly b?: number | undefined; readonly text?: string | undefined },
): Omit<LineComment, 'note'> | undefined {
  const old = row.op === '-';
  const line = old ? row.a : row.b;
  if (line === undefined || row.op === '…') return undefined;
  return { file, side: old ? 'old' : 'new', line, code: row.text ?? '' };
}

/** "math.js:2", "math.js:2 (removed)": the tray's and the mark's words. */
export const lineLabel = (c: Pick<LineComment, 'file' | 'line' | 'side'>): string => `${c.file.split('/').pop() ?? c.file}:${c.line}${c.side === 'old' ? ' (removed)' : ''}`;

/** The comments at the top of the follow-up, then what was typed (v1 withComments). */
export function withComments(list: readonly LineComment[], text: string): string {
  if (list.length === 0) return text;
  const items = list.map((c, i) => {
    const file = c.file.replace(/"/g, "'").replace(/\s+/g, ' ');
    const where = c.side === 'old' ? `, removed line ${c.line} (numbered as before the change)` : `, line ${c.line}`;
    return [`${i + 1}. On "${file}"${where}:`, `> ${c.code}`.trimEnd(), ...(c.note.trim() ? [c.note.trim()] : [])].join('\n');
  });
  return `<comments>\n${items.join('\n\n')}\n</comments>${text.trim() ? `\n\n${text.trim()}` : ''}`;
}

type Saved = Record<string, LineComment[]>;
const stores = new WeakMap<PluginClient, PluginStore<Json>>();

/** The comments waiting per task, kept across reloads (a review takes a while): this plugin's client's store (the pane,
 * the tray and the reply box's prompt source all get wisp.shell-task's client). */
export function commentStore(client: PluginClient): PluginStore<Json> {
  const had = stores.get(client);
  if (had) return had;
  const store = client.defineStore<Json>({
    id: 'shell-task.comments',
    version: 1,
    defaults: {},
    persist: true,
    check: (v) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined),
  });
  stores.set(client, store);
  return store;
}

export const waiting = (all: unknown, task: string): readonly LineComment[] => ((all as Saved | undefined)?.[task] ?? []) as readonly LineComment[];

/** One more on `task`'s list (a second on the same line replaces the first: one card per line). */
export function added(all: unknown, task: string, c: LineComment): Saved {
  const cur = { ...((all as Saved | undefined) ?? {}) };
  const list = (cur[task] ?? []).filter((x) => !(x.file === c.file && x.side === c.side && x.line === c.line));
  cur[task] = [...list, c];
  return cur;
}

export function removed(all: unknown, task: string, i: number): Saved {
  const cur = { ...((all as Saved | undefined) ?? {}) };
  const list = (cur[task] ?? []).filter((_, j) => j !== i);
  if (list.length) cur[task] = list;
  else delete cur[task];
  return cur;
}
