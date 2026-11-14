// Comments on lines of the side panel's Changes, like a review, and on an answer (words picked in a block, or a whole
// block) (v1 comments.js, comment-text.js): each waits above the reply box, numbered, and goes out at the top of the
// next follow-up in v1's words, so the agent knows exactly which part you meant. DOM-free: the rules and the text; the
// store holds them per task until they go.
//
//   <comments>
//   1. On "server/auth.js", line 40:
//   > const ttl = 60
//   Make this configurable.
//   </comments>
//
//   Also run the tests.
import type { Json, PluginClient, PluginStore } from '@wisp/client';
import type { AnswerNote } from '@wisp/shell/contract';

export interface LineComment {
  /** the file as it is now */
  readonly file: string;
  /** a line only removed has only its old number */
  readonly side: 'new' | 'old';
  readonly line: number;
  readonly code: string;
  readonly note: string;
}

/** A comment on an answer (F-page-10): its turn, the block by index and its label, the words picked (`text`). */
export type AnswerComment = Readonly<AnswerNote>;

/** What waits for the next follow-up: a diff line's (kept with no `kind`, as before) or an answer's. */
export type Comment = LineComment | AnswerComment;

export const isLine = (c: Comment): c is LineComment => !('kind' in c) || (c as { kind?: unknown }).kind === undefined;

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

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** One comment in the agent's words (v1 comment-text.js `where`): the place, the quoted words or code, the note. */
function item(c: Comment, i: number): string {
  const note = c.note.trim() ? [c.note.trim()] : [];
  if (isLine(c)) {
    const file = c.file.replace(/"/g, "'").replace(/\s+/g, ' ');
    const where = c.side === 'old' ? `, removed line ${c.line} (numbered as before the change)` : `, line ${c.line}`;
    return [`${i + 1}. On "${file}"${where}:`, `> ${c.code}`.trimEnd(), ...note].join('\n');
  }
  const of = c.of ? ` in your answer to "${clip(c.of.replace(/"/g, "'").replace(/\s+/g, ' ').trim(), 48)}"` : '';
  const label = c.label.replace(/"/g, "'").replace(/\s+/g, ' ');
  if (c.kind === 'text' && c.quote) return [`${i + 1}. On "${label}"${of}, where it says:`, ...c.quote.split('\n').map((l) => `> ${l}`.trimEnd()), ...note].join('\n');
  return [`${i + 1}. On "${label}"${of}:`, ...note].join('\n');
}

/** The comments at the top of the follow-up, then what was typed (v1 withComments). */
export function withComments(list: readonly Comment[], text: string): string {
  if (list.length === 0) return text;
  const items = list.map(item);
  return `<comments>\n${items.join('\n\n')}\n</comments>${text.trim() ? `\n\n${text.trim()}` : ''}`;
}

type Saved = Record<string, Comment[]>;
// one store per plugin, not per client object: the shell asks with the client it holds for wisp.shell-task, the tray
// with its extension's, and a store id may be defined only once
const stores = new Map<string, PluginStore<Json>>();

/** The comments waiting per task, kept across reloads (a review takes a while): this plugin's client's store (the pane,
 * the tray and the reply box's prompt source all get wisp.shell-task's client). */
export function commentStore(client: PluginClient): PluginStore<Json> {
  const had = stores.get(client.id);
  if (had) return had;
  const store = client.defineStore<Json>({
    id: 'shell-task.comments',
    version: 1,
    defaults: {},
    persist: true,
    check: (v) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined),
  });
  stores.set(client.id, store);
  return store;
}

export const waiting = (all: unknown, task: string): readonly Comment[] => ((all as Saved | undefined)?.[task] ?? []) as readonly Comment[];

/** One more on `task`'s list (a second on the same line replaces the first: one card per line; an answer's are each
 * their own, as v1's). */
export function added(all: unknown, task: string, c: Comment): Saved {
  const cur = { ...((all as Saved | undefined) ?? {}) };
  const same = (x: Comment): boolean => isLine(c) && isLine(x) && x.file === c.file && x.side === c.side && x.line === c.line;
  cur[task] = [...(cur[task] ?? []).filter((x) => !same(x)), c];
  return cur;
}

/** The ones waiting on `turn`'s answer, numbered as the tray numbers them (line comments count too). */
export function marksOn(list: readonly Comment[], turn: string): { n: number; i: number; quote?: string; note: string }[] {
  return list.flatMap((c, k) => (!isLine(c) && c.turn === turn ? [{ n: k + 1, i: c.i, ...(c.kind === 'text' && c.quote ? { quote: c.quote } : {}), note: c.note }] : []));
}

/** The tray's words for where a comment is: a diff line by its file and number, words by themselves, a block by its label. */
export const whereOf = (c: Comment): string => (isLine(c) ? lineLabel(c) : c.kind === 'text' && c.quote ? `“${c.quote.replace(/\s+/g, ' ')}”` : c.label);

export function removed(all: unknown, task: string, i: number): Saved {
  const cur = { ...((all as Saved | undefined) ?? {}) };
  const list = (cur[task] ?? []).filter((_, j) => j !== i);
  if (list.length) cur[task] = list;
  else delete cur[task];
  return cur;
}
