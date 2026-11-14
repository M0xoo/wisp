// Topic tags on a task: searchable words its agent sets with wisp_tag, matched by the palette next
// to its fuzzy search (v1 web/js/tags.js).

export const MAX_TAGS = 10;
const MAX_LEN = 32;

/** "Rate Limiting", "#Redis", "next.js" → "rate-limiting", "redis", "next.js". */
export function normalizeTags(list: readonly unknown[] | string): string[] {
  const out: string[] = [];
  const raw = typeof list === 'string' ? list.split(',') : list;
  for (const item of raw) {
    const t = String(item ?? '')
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

export interface Query {
  readonly tags: readonly string[];
  readonly text: string;
}

/** "#auth login #redis" → { tags: ['auth', 'redis'], text: 'login' }. */
export function splitQuery(query: string): Query {
  const tags: string[] = [];
  const words: string[] = [];
  for (const w of query.trim().split(/\s+/).filter(Boolean)) {
    if (w.startsWith('#') && w.length > 1) tags.push(w.slice(1).toLowerCase());
    else if (w !== '#') words.push(w);
  }
  return { tags, text: words.join(' ') };
}

/**
 * How well an item's tags answer a query: every #tag has to name one of them (or start one), and a
 * plain word that is a tag counts for more than one found in the title. null: a #tag is missing.
 */
export function tagScore(q: Query, tags: readonly string[] = []): { score: number; hit: string[] } | null {
  const hit = new Set<string>();
  let score = 0;
  for (const w of q.tags) {
    const t = tags.find((x) => x === w) ?? tags.find((x) => x.startsWith(w));
    if (!t) return null;
    hit.add(t);
    score += t === w ? 14 : 8;
  }
  for (const w of q.text.toLowerCase().split(/\s+/).filter(Boolean)) {
    const t = tags.find((x) => x === w) ?? (w.length > 2 ? tags.find((x) => x.startsWith(w)) : undefined);
    if (t) {
      hit.add(t);
      score += t === w ? 10 : 5;
    }
  }
  return { score, hit: [...hit] };
}
