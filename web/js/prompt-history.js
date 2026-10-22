// The prompts you launched before, like a shell's history: ↑ in an empty prompt box brings back the
// last one, ↑ again the one before, ↓ goes forward and past the newest empties the box. DOM-free:
// the launcher keeps the list (wisp.sent) and applies the steps.

export const MAX_SENT = 50;

// The list with `text` as the newest (once, however often it was sent), at most MAX_SENT long.
export function remember(list, text) {
  const t = String(text || '').trim();
  if (!t) return list;
  return [...list.filter((x) => x !== t), t].slice(-MAX_SENT);
}

// What ↑ or ↓ does: { at, value } puts list[at] in the box (at null: back to an empty box), null
// leaves the key to the textarea. `at` is the entry on show: browsing goes on only while the box
// still holds it as it was, and only from its first line (↑) or last line (↓), so the caret can
// still move through a prompt of several lines.
export function historyStep({ key, value, list, at, firstLine = true, lastLine = true }) {
  const browsing = at != null && list[at] === value;
  if (key === 'ArrowUp' && firstLine && (browsing || !value.trim())) {
    const i = browsing ? at - 1 : list.length - 1;
    return i >= 0 ? { at: i, value: list[i] } : null;
  }
  if (key === 'ArrowDown' && lastLine && browsing) return at + 1 < list.length ? { at: at + 1, value: list[at + 1] } : { at: null, value: '' };
  return null;
}
