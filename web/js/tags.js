// Topic tags on a task: searchable words its agent sets with wisp_tag (server/routes/internal.js),
// matched by the ⌘K palette next to its fuzzy search. DOM-free, shared by the server and the page.

export const MAX_TAGS = 10;
const MAX_LEN = 32;

// "Rate Limiting", "#Redis", "next.js" → "rate-limiting", "redis", "next.js". Words with letters,
// digits and - . + only; duplicates and empties go, at most MAX_TAGS.
export function normalizeTags(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : typeof list === 'string' ? list.split(',') : []) {
    const t = String(raw ?? '')
      .toLowerCase()
      .trim()
      .replace(/^#+/, '')
      .replace(/[\s_/]+/g, '-')
      .replace(/[^\p{L}\p{N}\-.+]/gu, '')
      .replace(/-{2,}/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, MAX_LEN);
    if (t && !out.includes(t)) out.push(t);
    if (out.length === MAX_TAGS) break;
  }
  return out;
}

// "#auth login #redis" → { tags: ['auth', 'redis'], text: 'login' }.
export function splitQuery(query) {
  const tags = [];
  const words = [];
  for (const w of String(query || '').trim().split(/\s+/).filter(Boolean)) {
    if (w.startsWith('#') && w.length > 1) tags.push(w.slice(1).toLowerCase());
    else if (w !== '#') words.push(w);
  }
  return { tags, text: words.join(' ') };
}

// How well an item's tags answer a query: every #tag has to name one of them (or start one), and a
// plain word that is a tag counts for more than one found in the title. null: a #tag is missing.
// hit: the tags that matched, to highlight.
export function tagScore({ tags: want, text }, tags = []) {
  const hit = new Set();
  let score = 0;
  for (const w of want) {
    const t = tags.find((x) => x === w) || tags.find((x) => x.startsWith(w));
    if (!t) return null;
    hit.add(t);
    score += t === w ? 14 : 8;
  }
  for (const w of text.toLowerCase().split(/\s+/).filter(Boolean)) {
    const t = tags.find((x) => x === w) || (w.length > 2 && tags.find((x) => x.startsWith(w)));
    if (t) (hit.add(t), (score += t === w ? 10 : 5));
  }
  return { score, hit: [...hit] };
}
