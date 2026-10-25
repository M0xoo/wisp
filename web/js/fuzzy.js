// Fuzzy matching for the command palette. Each query word has to appear in order
// (as a subsequence) somewhere in the item; matches at word starts, runs of
// consecutive letters and early positions score higher. The title is the field
// that gets highlighted; the other fields can still match, for a lower score.

const BOUNDARY = /[\s\-_./:#@()[\]]/;

function isStart(text, i) {
  if (i === 0) return true;
  const prev = text[i - 1];
  return BOUNDARY.test(prev) || (prev === prev.toLowerCase() && text[i] !== text[i].toLowerCase());
}

// Score one needle against one haystack, or null if it doesn't match.
// Finds the tightest window ending at the first full match (fzf v1 style), then scores it.
export function matchOne(needle, text) {
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
  let start = end;
  for (let j = n.length - 1; j >= 0; start--) if (h[start] === n[j]) j--;
  start++;

  // A plain substring that starts on a word boundary beats any scattered match.
  const sub = h.indexOf(n);
  if (sub >= 0) {
    let at = sub;
    for (let k = sub; k >= 0; k = h.indexOf(n, k + 1)) if (isStart(text, k)) { at = k; break; }
    const idx = Array.from(n, (_, k) => at + k);
    return { score: score(text, idx), idx };
  }

  const idx = [];
  for (let i = start, j = 0; j < n.length; i++) if (h[i] === n[j]) idx.push(i), j++;
  return { score: score(text, idx), idx };
}

function score(text, idx) {
  let s = 0;
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    s += 1;
    if (isStart(text, i)) s += k === 0 ? 8 : 5;
    if (k > 0) {
      const gap = i - idx[k - 1] - 1;
      s += gap === 0 ? 4 : -Math.min(gap, 6) * 0.6;
    }
  }
  if (idx[0] === 0) s += 6;
  return s - idx[0] * 0.15 - text.length * 0.02;
}

// Match a whole query against an item. `fields` is [title, ...rest]. Returns
// { score, idx } where idx are the highlighted title positions, or null.
export function fuzzy(query, fields) {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { score: 0, idx: [] };
  const [title = '', ...rest] = fields;
  let total = 0;
  const idx = new Set();
  for (const w of words) {
    const t = matchOne(w, title);
    let best = t ? t.score * 1.5 : -Infinity;
    for (const f of rest) {
      const m = f && matchOne(w, f);
      if (m && m.score > best) best = m.score;
    }
    if (best === -Infinity) return null;
    if (t && t.score * 1.5 === best) t.idx.forEach((i) => idx.add(i));
    total += best;
  }
  return { score: total, idx: [...idx].sort((a, b) => a - b) };
}

// A bonus for something touched recently, added to a match's score so that between
// matches the more recent one wins: +20 just now, +10 a day ago, +2.5 after a week,
// under +1 after a month. That outweighs a prefix or word-start bonus (~10), and it
// never reaches 0, so older always ranks below newer for the same text; only a far
// better match (a scattered subsequence against a clean word) beats recency.
export function recency(at, now = Date.now()) {
  if (!at) return 0;
  const hours = Math.max(0, now - at) / 3.6e6;
  return 20 / (1 + hours / 24);
}

// Best score first; on a tie, the more recent item.
export const byScore = (a, b) => b.score - a.score || (b.at || 0) - (a.at || 0);

// Wrap matched positions in <mark>, escaping everything else.
export function highlight(text, idx, esc) {
  if (!idx?.length) return esc(text);
  const on = new Set(idx);
  let out = '';
  let run = '';
  let inRun = false;
  for (let i = 0; i <= text.length; i++) {
    const hit = i < text.length && on.has(i);
    if (hit !== inRun || i === text.length) {
      out += inRun ? `<mark>${esc(run)}</mark>` : esc(run);
      run = '';
      inRun = hit;
    }
    if (i < text.length) run += text[i];
  }
  return out;
}
