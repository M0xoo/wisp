// The command palette's ranking (v1 web/js/fuzzy.js, tags.js, palette.js `results`), pure:
//   - each query word must appear in order (a subsequence) in the item; word starts, runs and early
//     positions score higher, and a plain substring on a word boundary beats any scattered match;
//   - the label is the field that's highlighted and counts 1.5×; sub, tags, keywords, group match too;
//   - "#auth" keeps only items tagged auth; a plain word that is a tag counts more than one in a title;
//   - recency: +20 just now, +10 a day old, never 0, so newer wins between equal matches;
//   - best first, groups kept together in the order of their best hit, 12 per group;
//   - an empty query shows each group's first `limit` (6) items, in the order given.

import type { PaletteItem } from '../contract.ts';

const BOUNDARY = /[\s\-_./:#@()[\]]/;

function isStart(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1] ?? '';
  const cur = text[i] ?? '';
  return BOUNDARY.test(prev) || (prev === prev.toLowerCase() && cur !== cur.toLowerCase());
}

function score(text: string, idx: readonly number[]): number {
  let s = 0;
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k] ?? 0;
    s += 1;
    if (isStart(text, i)) s += k === 0 ? 8 : 5;
    if (k > 0) {
      const gap = i - (idx[k - 1] ?? 0) - 1;
      s += gap === 0 ? 4 : -Math.min(gap, 6) * 0.6;
    }
  }
  if (idx[0] === 0) s += 6;
  return s - (idx[0] ?? 0) * 0.15 - text.length * 0.02;
}

export interface Hit {
  score: number;
  idx: number[];
}

/** One needle against one text, or null. */
export function matchOne(needle: string, text: string): Hit | null {
  if (!needle) return { score: 0, idx: [] };
  const n = needle.toLowerCase();
  const h = text.toLowerCase();
  let end = -1;
  for (let i = 0, j = 0; i < h.length; i++) {
    if (h[i] === n[j] && ++j === n.length) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  const sub = h.indexOf(n);
  if (sub >= 0) {
    let at = sub;
    for (let k = sub; k >= 0; k = h.indexOf(n, k + 1)) {
      if (isStart(text, k)) {
        at = k;
        break;
      }
    }
    const idx = Array.from(n, (_, k) => at + k);
    return { score: score(text, idx), idx };
  }
  let start = end;
  for (let j = n.length - 1; j >= 0; start--) if (h[start] === n[j]) j--;
  start++;
  const idx: number[] = [];
  for (let i = start, j = 0; j < n.length; i++) {
    if (h[i] === n[j]) {
      idx.push(i);
      j++;
    }
  }
  return { score: score(text, idx), idx };
}

/** A whole query against [label, ...rest]; idx are the label's matched positions. */
export function fuzzy(query: string, fields: readonly string[]): Hit | null {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { score: 0, idx: [] };
  const [label = '', ...rest] = fields;
  let total = 0;
  const idx = new Set<number>();
  for (const w of words) {
    const t = matchOne(w, label);
    let best = t ? t.score * 1.5 : -Infinity;
    for (const f of rest) {
      const m = f ? matchOne(w, f) : null;
      if (m && m.score > best) best = m.score;
    }
    if (best === -Infinity) return null;
    if (t && t.score * 1.5 === best) for (const i of t.idx) idx.add(i);
    total += best;
  }
  return { score: total, idx: [...idx].sort((a, b) => a - b) };
}

export function recency(at: number | undefined, now: number): number {
  if (!at) return 0;
  const hours = Math.max(0, now - at) / 3.6e6;
  return 20 / (1 + hours / 24);
}

export interface Query {
  tags: string[];
  text: string;
}

export function splitQuery(q: string): Query {
  const tags: string[] = [];
  const words: string[] = [];
  for (const w of q.trim().split(/\s+/).filter(Boolean)) {
    if (w.startsWith('#') && w.length > 1) tags.push(w.slice(1).toLowerCase());
    else if (w !== '#') words.push(w);
  }
  return { tags, text: words.join(' ') };
}

export function tagScore(q: Query, tags: readonly string[] = []): { score: number; hit: string[] } | null {
  const hit = new Set<string>();
  let s = 0;
  for (const w of q.tags) {
    const t = tags.find((x) => x === w) ?? tags.find((x) => x.startsWith(w));
    if (t === undefined) return null;
    hit.add(t);
    s += t === w ? 14 : 8;
  }
  for (const w of q.text.toLowerCase().split(/\s+/).filter(Boolean)) {
    const t = tags.find((x) => x === w) ?? (w.length > 2 ? tags.find((x) => x.startsWith(w)) : undefined);
    if (t !== undefined) {
      hit.add(t);
      s += t === w ? 10 : 5;
    }
  }
  return { score: s, hit: [...hit] };
}

export interface Ranked {
  readonly item: PaletteItem;
  /** the label's matched positions, to mark */
  readonly idx: readonly number[];
}

const GROUP_LIMIT = 6;
const PER_GROUP = 12;

export function rank(items: readonly PaletteItem[], query: string, now: number, deep: readonly PaletteItem[] = []): Ranked[] {
  if (!query.trim()) {
    const per = new Map<string, number>();
    return items
      .filter((it) => {
        const n = per.get(it.group) ?? 0;
        per.set(it.group, n + 1);
        return n < GROUP_LIMIT;
      })
      .map((item) => ({ item, idx: [] }));
  }
  const q = splitQuery(query);
  const hits: { item: PaletteItem; idx: number[]; score: number }[] = [];
  for (const it of items) {
    const t = tagScore(q, it.tags);
    if (!t) continue;
    if (it.fill !== undefined && it.tags?.[0] !== undefined && q.tags.includes(it.tags[0])) continue; // that topic is already in the query
    const m = q.text ? fuzzy(q.text, [it.label, it.sub ?? '', it.tags?.join(' ') ?? '', it.keywords ?? '', it.group]) : { score: 0, idx: [] };
    if (m) hits.push({ item: it, idx: m.idx, score: m.score + t.score + (it.rank ?? 0) + recency(it.at, now) });
  }
  hits.sort((a, b) => b.score - a.score || (b.item.at ?? 0) - (a.item.at ?? 0));
  const groups = [...new Set(hits.map((h) => h.item.group))];
  const listed = new Set(hits.map((h) => h.item.id));
  const extra = deep.filter((it) => !listed.has(it.id)).map((item) => ({ item, idx: [] as number[] }));
  return [...groups.flatMap((g) => hits.filter((h) => h.item.group === g).slice(0, PER_GROUP)), ...extra];
}

/** Splits a label into runs for <mark>: [text, marked][] */
export function marks(text: string, idx: readonly number[]): [string, boolean][] {
  if (idx.length === 0) return [[text, false]];
  const on = new Set(idx);
  const out: [string, boolean][] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = on.has(i);
    const last = out.at(-1);
    if (last && last[1] === hit) last[0] += text[i] ?? '';
    else out.push([text[i] ?? '', hit]);
  }
  return out;
}
