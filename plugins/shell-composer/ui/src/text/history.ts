// Prompt history, like a shell's (v1 web/js/prompt-history.js): ↑ in an empty box brings back the
// last prompt, ↑ again the one before, ↓ goes forward and past the newest empties the box. Pure:
// the composer keeps the list in its plugin store and applies the steps.

export const MAX_SENT = 50;

/** The list with `text` as the newest (once, however often it was sent), at most MAX_SENT long. */
export function remember(list: readonly string[], text: string): readonly string[] {
  const t = text.trim();
  if (!t) return list;
  return [...list.filter((x) => x !== t), t].slice(-MAX_SENT);
}

export interface HistoryStepInput {
  readonly key: string;
  readonly value: string;
  readonly list: readonly string[];
  /** the entry on show, or null when not browsing */
  readonly at: number | null;
  /** the caret is on the box's first line (↑ only browses from there) */
  readonly firstLine?: boolean;
  /** the caret is on the box's last line (↓ only browses from there) */
  readonly lastLine?: boolean;
}

/**
 * What ↑ or ↓ does: `{ at, value }` puts list[at] in the box (`at: null`: back to an empty box);
 * `null` leaves the key to the textarea. Browsing goes on only while the box still holds the entry
 * as it was, so an edited entry is a draft again and the caret moves through it.
 */
export function historyStep(i: HistoryStepInput): { at: number | null; value: string } | null {
  const { key, value, list, at } = i;
  const browsing = at !== null && list[at] === value;
  if (key === 'ArrowUp' && i.firstLine !== false && (browsing || !value.trim())) {
    const next = browsing ? at - 1 : list.length - 1;
    const v = list[next];
    return next >= 0 && v !== undefined ? { at: next, value: v } : null;
  }
  if (key === 'ArrowDown' && i.lastLine !== false && browsing) {
    const v = list[at + 1];
    return v !== undefined ? { at: at + 1, value: v } : { at: null, value: '' };
  }
  return null;
}

/** Whether the caret at `pos` is on the first / last line of `text`. */
export function caretLines(text: string, pos: number): { firstLine: boolean; lastLine: boolean } {
  return { firstLine: !text.slice(0, pos).includes('\n'), lastLine: !text.slice(pos).includes('\n') };
}
