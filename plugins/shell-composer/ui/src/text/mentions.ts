// Mentions in prompts (v1 web/js/mention-text.js). A prompt stores one as `@[Title](wisp:<id>)` (a
// task), `@[Name](crew:<id>)` (a crew member: they get the message) or `@[Title](stuff:<id>)` (My
// Stuff: the agent gets its file). The box shows `@Title` and keeps the ids aside. Pure.

export type MentionKind = 'task' | 'crew' | 'stuff';

export interface Mention {
  readonly id: string;
  readonly title: string;
  readonly kind: MentionKind;
}

export interface Span extends Mention {
  readonly start: number;
  readonly end: number;
}

const ANY = /@\[([^\]\n]{1,200})\]\((wisp|crew|stuff):([a-z0-9]{6,40})\)/g;
const schemeOf = (kind: MentionKind): string => (kind === 'task' ? 'wisp' : kind);
const kindOf = (scheme: string): MentionKind => (scheme === 'crew' || scheme === 'stuff' ? scheme : 'task');

/** Titles go inside [...]: no ] or newlines, at most 120 characters. */
export function cleanTitle(title: string | undefined, fallback = 'Untitled task'): string {
  return (title ?? '').replace(/[\]\n\r]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || fallback;
}

/** Stored form → what the box shows, plus the mentions in it (each id once). */
export function decode(text: string): { text: string; mentions: Mention[] } {
  const mentions: Mention[] = [];
  const shown = text.replace(ANY, (_m, title: string, scheme: string, id: string) => {
    if (!mentions.some((m) => m.id === id)) mentions.push({ id, title, kind: kindOf(scheme) });
    return `@${title}`;
  });
  return { text: shown, mentions };
}

/** Where each known mention sits in the shown text, longest titles first; sorted, non-overlapping. */
export function spans(text: string, mentions: readonly Mention[]): Span[] {
  const out: Span[] = [];
  for (const m of [...mentions].sort((a, b) => b.title.length - a.title.length)) {
    const needle = `@${m.title}`;
    for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) {
      const end = i + needle.length;
      if (!out.some((s) => i < s.end && end > s.start)) out.push({ ...m, start: i, end });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Shown text → stored form. A mention edited into something else is plain text again. */
export function encode(text: string, mentions: readonly Mention[]): string {
  let out = '';
  let at = 0;
  for (const s of spans(text, mentions)) {
    out += `${text.slice(at, s.start)}@[${s.title}](${schemeOf(s.kind)}:${s.id})`;
    at = s.end;
  }
  return out + text.slice(at);
}

/** For people: titles, no ids. */
export const plain = (text: string): string => text.replace(ANY, '@$1');

/** The mentions still in the shown text (the others were edited away). */
export const liveMentions = (text: string, mentions: readonly Mention[]): Mention[] =>
  mentions.filter((m) => text.includes(`@${m.title}`));

/** The `@query` being typed at the caret, or null: an @ at a word start, no space after it yet. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)@([^\s@]{0,40})$/.exec(before);
  if (!m) return null;
  const query = m[2] ?? '';
  return { start: caret - query.length - 1, query };
}

/** Replaces the `@query` at `start..caret` with `@Title ` and returns the new text and caret. */
export function insertMention(text: string, start: number, caret: number, m: Mention): { text: string; caret: number } {
  const ins = `@${m.title} `;
  return { text: text.slice(0, start) + ins + text.slice(caret), caret: start + ins.length };
}

/** Pasted text that is only task references (ids, `wisp:<id>`, `#/s/<id>` links) `known` finds → ids. */
export function pastedTasks(text: string, known: (id: string) => boolean): string[] | null {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  if (!parts.length || parts.length > 10) return null;
  const ids = parts.map((p) => (/^(?:wisp:)?([a-f0-9]{12})$/.exec(p) ?? /#\/s\/([a-z0-9]{6,40})\/?$/.exec(p))?.[1]);
  return ids.every((id): id is string => !!id && known(id)) ? [...new Set(ids as string[])] : null;
}
