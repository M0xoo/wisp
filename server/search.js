// Finding past work (GET /search, the ⌘K palette's "In answers"): every task's title, prompts and
// answers (their cards' words), searched in memory. Every word asked for must be in one piece of a
// task (one prompt, or one answer); newest tasks first, one hit per turn.

const MAX_PIECE = 40_000; // past this a piece is a log, not something to find words in
const SNIP = 70; // characters either side of the first word in the snippet

// The words of a card: every string in it, its kind and ids aside.
function wordsOf(v, out = [], depth = 0) {
  if (depth > 6 || out.length > 400) return out;
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) wordsOf(x, out, depth + 1);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (!['type', 'id', 'status', 'tone', 'change', 'device', 'language'].includes(k)) wordsOf(x, out, depth + 1);
  return out;
}

function snippet(text, at) {
  const from = Math.max(0, at - SNIP);
  const to = Math.min(text.length, at + SNIP);
  return `${from ? '…' : ''}${text.slice(from, to).replace(/\s+/g, ' ').trim()}${to < text.length ? '…' : ''}`;
}

// sessions: the store's tasks. Returns [{ id, title, turn, where: 'title' | 'prompt' | 'answer', snippet, at }].
export function searchTasks(sessions, q, { limit = 30 } = {}) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter((w) => w.length > 1).slice(0, 8);
  if (!words.length) return [];
  const out = [];
  const tasks = [...sessions].filter((s) => s && !s.parentId && !s.pending).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  for (const s of tasks) {
    const pieces = [{ where: 'title', text: s.title || '' }];
    for (const t of s.turns || []) {
      pieces.push({ where: 'prompt', turn: t.id, text: String(t.prompt || '').slice(0, MAX_PIECE), at: t.startedAt });
      const answer = [t.answer, ...wordsOf(t.presentation?.blocks || [])].filter((x) => typeof x === 'string').join('\n').slice(0, MAX_PIECE);
      if (answer) pieces.push({ where: 'answer', turn: t.id, text: answer, at: t.endedAt || t.startedAt });
    }
    let hits = 0;
    for (const p of pieces) {
      const low = p.text.toLowerCase();
      if (!words.every((w) => low.includes(w))) continue;
      out.push({ id: s.id, title: s.title || '', turn: p.turn || null, where: p.where, snippet: snippet(p.text, low.indexOf(words[0])), at: p.at || s.updatedAt || 0 });
      // A title hit says it all for that task; else up to three of its turns
      if (p.where === 'title' || ++hits >= 3) break;
    }
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}
