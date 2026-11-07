// The pure half of VirtualList: which rows to render for a scroll position, and where a row the
// reader is looking at has gone after heights change. No DOM here, so it is tested exhaustively.

/** Within this many px of the end, a transcript counts as at its tail (v1's tail.js, design/ux.md). */
export const TAIL_SLACK = 40;

export interface Range {
  /** First rendered row (inclusive). */
  readonly start: number;
  /** One past the last rendered row. */
  readonly end: number;
  /** Height of the rows above `start`: the top spacer. */
  readonly padTop: number;
  /** Height of the rows from `end` on: the bottom spacer. */
  readonly padBottom: number;
  readonly total: number;
}

/** Prefix sums: `out[i]` is the top of row `i`, `out[n]` the total height. Negative heights count as 0. */
export function offsets(heights: readonly number[]): number[] {
  const out = new Array<number>(heights.length + 1);
  out[0] = 0;
  let sum = 0;
  for (let i = 0; i < heights.length; i++) {
    sum += Math.max(0, heights[i] ?? 0);
    out[i + 1] = sum;
  }
  return out;
}

/** The last row whose top is at or above `y` (0 when there are no rows). */
export function rowAt(offs: readonly number[], y: number): number {
  const n = offs.length - 1;
  if (n <= 0) return 0;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((offs[mid] ?? 0) <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * The rows that cover [scrollTop, scrollTop + viewport], plus `overscan` rows either side.
 * The spacers and the rendered rows always add up to the total height.
 */
export function computeRange(offs: readonly number[], scrollTop: number, viewport: number, overscan: number): Range {
  const n = offs.length - 1;
  const total = offs[n] ?? 0;
  if (n <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0, total };
  const view = Math.max(0, viewport);
  const top = Math.min(Math.max(0, scrollTop), Math.max(0, total - view));
  const first = rowAt(offs, top);
  // The first row whose top is at or past the viewport's bottom ends the visible run.
  let last = rowAt(offs, top + view);
  if ((offs[last] ?? 0) < top + view || last === first) last += 1;
  const start = Math.max(0, first - overscan);
  const end = Math.min(n, last + overscan);
  return { start, end, padTop: offs[start] ?? 0, padBottom: total - (offs[end] ?? total), total };
}

/** Whether a scroller is at its tail: within TAIL_SLACK px of the end. */
export function atTail(scrollTop: number, viewport: number, scrollHeight: number, slack: number = TAIL_SLACK): boolean {
  return scrollHeight - (scrollTop + viewport) <= slack;
}

export interface Anchor {
  readonly index: number;
  /** How far the viewport's top sits below the anchor row's top. */
  readonly delta: number;
}

/** The row under the top of the viewport, and how far into it the reader is. */
export function anchorAt(offs: readonly number[], scrollTop: number): Anchor {
  const index = rowAt(offs, scrollTop);
  return { index, delta: scrollTop - (offs[index] ?? 0) };
}

/** The scrollTop that puts the anchor row back where it was after the offsets changed. */
export function restoreAnchor(offs: readonly number[], anchor: Anchor): number {
  return (offs[Math.min(anchor.index, offs.length - 1)] ?? 0) + anchor.delta;
}
