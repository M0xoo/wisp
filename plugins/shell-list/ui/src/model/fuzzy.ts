// Fuzzy matching for the palette and the switcher (v1 web/js/fuzzy.js, same scores). Each query word
// has to appear in order (a subsequence) somewhere in the item; matches at word starts, runs of
// consecutive letters and early positions score higher. The title is the field that gets
// highlighted; the other fields can still match, for a lower score.

const BOUNDARY = /[\s\-_./:#@()[\]]/;

export interface Match {
  readonly score: number;
  /** matched positions in the title, ascending */
  readonly idx: readonly number[];
}

function isStart(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1] ?? '';
  const ch = text[i] ?? '';
  return BOUNDARY.test(prev) || (prev === prev.toLowerCase() && ch !== ch.toLowerCase());
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
  const first = idx[0] ?? 0;
  if (first === 0) s += 6;
  return s - first * 0.15 - text.length * 0.02;
}

/** One needle against one haystack: the tightest window ending at the first full match (fzf v1). */
export function matchOne(needle: string, text: string): Match | null {
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
  // a plain substring that starts on a word boundary beats any scattered match
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

/** A whole query against an item; `fields` is [title, ...rest]. null: some word matches nowhere. */
export function fuzzy(query: string, fields: readonly string[]): Match | null {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { score: 0, idx: [] };
  const [title = '', ...rest] = fields;
  let total = 0;
  const idx = new Set<number>();
  for (const w of words) {
    const t = matchOne(w, title);
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

/**
 * A bonus for something touched recently: +20 just now, +10 a day ago, +2.5 after a week. It
 * outweighs a prefix bonus (~10) and never reaches 0, so older ranks below newer for the same text.
 */
export function recency(at: number | undefined, now: number): number {
  if (!at) return 0;
  const hours = Math.max(0, now - at) / 3.6e6;
  return 20 / (1 + hours / 24);
}

/** Best score first; on a tie, the more recent item. */
export const byScore = (a: { score: number; at?: number }, b: { score: number; at?: number }): number => b.score - a.score || (b.at ?? 0) - (a.at ?? 0);

/** The title cut into runs, matched or not, for the kit to render (no HTML). */
export function marks(text: string, idx: readonly number[]): { text: string; hit: boolean }[] {
  if (idx.length === 0) return text ? [{ text, hit: false }] : [];
  const on = new Set(idx);
  const out: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = on.has(i);
    const last = out[out.length - 1];
    if (last && last.hit === hit) last.text += text[i];
    else out.push({ text: text[i] ?? '', hit });
  }
  return out;
}
