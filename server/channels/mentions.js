// @names in a text. Pure, and imports nothing: grammar.js reads them, and wisp Grid imports grammar.js
// without the rest of wisp (grid/route.js).

export const CREW_MENTION = /@\[([^\]\n]{1,200})\]\(crew:([a-z0-9]{6,40})\)/g;
export const handleOf = (name) => String(name || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 24);
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The members a text names: `@[Ada](crew:<id>)` (the page's form) or a plain `@Ada` / `@ada`.
// lead: the text starts with it, i.e. it's addressed to them. rest: the text without the leading mentions.
export function crewMentions(text = '', members = []) {
  const src = String(text);
  const hits = new Map();
  for (const x of src.matchAll(CREW_MENTION)) {
    const m = members.find((y) => y.id === x[2]);
    if (m && !hits.has(m.id)) hits.set(m.id, { member: m, at: x.index, len: x[0].length });
  }
  // Plain @names: the longest first, so "@Ada Lovelace" isn't read as "@Ada".
  for (const m of [...members].sort((a, b) => b.name.length - a.name.length)) {
    if (hits.has(m.id)) continue;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}_@\\]])@(${escRe(m.name)}|${escRe(handleOf(m.name))})(?![\\p{L}\\p{N}_-])`, 'iu');
    const x = re.exec(src.replace(CREW_MENTION, (s) => ' '.repeat(s.length)));
    if (x) hits.set(m.id, { member: m, at: x.index + x[1].length, len: x[0].length - x[1].length });
  }
  const list = [...hits.values()].sort((a, b) => a.at - b.at);
  // Leading: mentions with nothing but spaces and commas before them.
  let at = src.match(/^\s*/)[0].length;
  const lead = [];
  for (const h of list) {
    if (h.at !== at) break;
    lead.push(h.member);
    at = h.at + h.len;
    at += src.slice(at).match(/^[\s,:]*/)[0].length;
  }
  return { all: list.map((h) => h.member), lead, rest: lead.length ? src.slice(at).trim() : src };
}
