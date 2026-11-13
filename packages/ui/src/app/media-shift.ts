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

/** The reply box docked at the task's foot grew (focus shows its bar, a queued follow-up, a longer draft) by `dock`, or
 *  the scroller's view changed height (the keyboard) by `view`, both in px since the last frame; the rest is the
 *  scroller now. The dock is sticky, so a reader who was at the end would find the last block slid under the box until
 *  they scrolled: there the view goes back to the end. Whether they were at the end is worked out from the frame
 *  before (the dock is in flow, so it added to the scroll height), never from a flag that may be stale. A reader
 *  further up keeps their place (the box covers what's under it, as v1's does); a shrink needs nothing, the browser
 *  clamps. Pure. */
export function dockShift(o: { readonly scrollHeight: number; readonly scrollTop: number; readonly clientHeight: number; readonly dock: number; readonly view: number }): 'end' | 0 {
  if (o.dock < 1 && o.view > -1) return 0;
  return atTail({ scrollHeight: o.scrollHeight - o.dock, scrollTop: o.scrollTop, clientHeight: o.clientHeight - o.view }) ? 'end' : 0;
}
