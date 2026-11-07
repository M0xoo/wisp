// @names in a text. Pure, and imports nothing: grammar.ts reads them, and wisp Grid reads the same
// grammar without the rest of wisp. The port of v1 server/channels/mentions.js.

export const CREW_MENTION = /@\[([^\]\n]{1,200})\]\(crew:([a-z0-9]{6,40})\)/g;
export const handleOf = (name: unknown): string =>
  String(name || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface Named {
  id: string;
  name: string;
}

interface Hit<M> {
  member: M;
  at: number;
  len: number;
}

function hitsOf<M extends Named>(src: string, members: readonly M[]): Hit<M>[] {
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
    if (x) {
      const lead = x[1] ?? '';
      hits.set(m.id, { member: m, at: x.index + lead.length, len: x[0].length - lead.length });
    }
  }
  return [...hits.values()].sort((a, b) => a.at - b.at);
}

/**
 * The members a text names: `@[Ada](crew:<id>)` (the page's form) or a plain `@Ada` / `@ada`.
 * lead: the text starts with it, i.e. it's addressed to them. rest: the text without the leading mentions.
 */
export function crewMentions<M extends Named>(text: unknown = '', members: readonly M[] = []): { all: M[]; lead: M[]; rest: string } {
  const src = String(text);
  const list = hitsOf(src, members);
  // Leading: mentions with nothing but spaces and commas before them.
  let at = /^\s*/.exec(src)?.[0].length ?? 0;
  const lead: M[] = [];
  for (const h of list) {
    if (h.at !== at) break;
    lead.push(h.member);
    at = h.at + h.len;
    at += /^[\s,:]*/.exec(src.slice(at))?.[0].length ?? 0;
  }
  return { all: list.map((h) => h.member), lead, rest: lead.length ? src.slice(at).trim() : src };
}
