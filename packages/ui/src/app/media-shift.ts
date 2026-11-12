// A picture or video in a task took its real size (v1 tail.js mediaShift, #776): it loads lazily and nothing holds
// its box before that, so it grows from nothing to its height. `grew` is each one's top now and its height before and
// after. At the tail the view goes back to the end ('end'). Elsewhere what's being read holds: browsers with scroll
// anchoring (Chrome) already did that (`anchors`); without it (WebKit: Safari, the Mac app) each one that was wholly
// above the reading line (`inset`) pushed the text down by what it grew, so that much is the shift to undo. Pure.

export interface Grew {
  readonly top: number;
  readonly from: number;
  readonly to: number;
}

export function mediaShift(o: { readonly tail: boolean; readonly anchors: boolean; readonly inset: number; readonly grew: readonly Grew[] }): number | 'end' {
  if (o.tail) return 'end';
  if (o.anchors) return 0;
  let above = 0; // what the ones higher up grew: they pushed this one down too
  let dy = 0;
  for (const g of [...o.grew].sort((a, b) => a.top - b.top)) {
    if (g.top - above + g.from <= o.inset) dy += g.to - g.from;
    above += g.to - g.from;
  }
  return dy;
}

/** At the end of a scroller (within a pixel or two). */
export const atTail = (el: { readonly scrollHeight: number; readonly scrollTop: number; readonly clientHeight: number }): boolean => el.scrollHeight - el.scrollTop - el.clientHeight < 2;
