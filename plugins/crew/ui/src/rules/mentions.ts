// Ported from the TypeScript reference (git show v2-ts-server-reference:plugins/crew/api/src/). Pure.
// @Name mentions of crew members in a text (v1 server/channels/mentions.js's CREW_MENTION, handleOf,
// crewMentions; server/crew.js plainCrew). Pure and import-free: the server, the page and the
// channels grammar all read mentions the same way.

/** How a mention is stored in a prompt (the page's prompt boxes write it; a plain `@Ada` works too). */
export const CREW_MENTION = /@\[([^\]\n]{1,200})\]\(crew:([a-z0-9]{6,40})\)/g;

/** A member's @handle: "Bo Lee" → "bo-lee" (letters and digits of any script, at most 24). */
export const handleOf = (name: unknown): string =>
  String(name ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);

const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface Named {
  readonly id: string;
  readonly name: string;
}

export interface Mentions<M extends Named> {
  /** every member named, in the order they appear */
  all: M[];
  /** the ones the text starts with: it is addressed to them */
  lead: M[];
  /** the text without the leading mentions (the whole text when there are none) */
  rest: string;
}

interface Hit<M> {
  member: M;
  at: number;
  len: number;
}

/** The members a text names: `@[Ada](crew:<id>)` or a plain `@Ada` / `@ada`, leading or in passing. */
export function crewMentions<M extends Named>(text: unknown, members: readonly M[]): Mentions<M> {
  const src = String(text ?? '');
  const hits = new Map<string, Hit<M>>();
  for (const x of src.matchAll(CREW_MENTION)) {
    const m = members.find((y) => y.id === x[2]);
    if (m && !hits.has(m.id)) hits.set(m.id, { member: m, at: x.index, len: x[0].length });
  }
  // Plain @names: the longest first, so "@Ada Lovelace" isn't read as "@Ada".
  const blanked = src.replace(CREW_MENTION, (s) => ' '.repeat(s.length));
  for (const m of [...members].sort((a, b) => b.name.length - a.name.length)) {
    if (hits.has(m.id)) continue;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}_@\\]])@(${escRe(m.name)}|${escRe(handleOf(m.name))})(?![\\p{L}\\p{N}_-])`, 'iu');
    const x = re.exec(blanked);
    if (x) hits.set(m.id, { member: m, at: x.index + (x[1] ?? '').length, len: x[0].length - (x[1] ?? '').length });
  }
  const list = [...hits.values()].sort((a, b) => a.at - b.at);
  // Leading: mentions with nothing but spaces and commas before them.
  let at = (/^\s*/.exec(src)?.[0] ?? '').length;
  const lead: M[] = [];
  for (const h of list) {
    if (h.at !== at) break;
    lead.push(h.member);
    at = h.at + h.len;
    at += (/^[\s,:]*/.exec(src.slice(at))?.[0] ?? '').length;
  }
  return { all: list.map((h) => h.member), lead, rest: lead.length ? src.slice(at).trim() : src };
}

/** Stored mentions as an agent or a person reads them: `@Ada`. */
export const plainCrew = (text: unknown): string => String(text ?? '').replace(CREW_MENTION, '@$1');

/** A mention as the page's @ picker writes it. */
export const mentionOf = (m: Named): string => `@[${m.name.replace(/[\]\n]/g, '')}](crew:${m.id})`;
