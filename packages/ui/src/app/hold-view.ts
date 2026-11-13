// Where the task's page holds the reader while it changes under them (v1 tail.js, turns.js renderBody): pictures growing,
// the reply box growing, a turn landing. Every read comes before the one write in a frame.
import { atTail, dockShift, mediaShift, turnsShift, type Grew } from './media-shift.ts';

/** Pictures and videos in the turns load lazily with no box kept for them, so each grows when it arrives: the view
 *  stays where the reader had it (v1 #776, `mediaShift`). A ResizeObserver runs after layout and before paint, so the
 *  shift is never seen. A media box that had no size (a closed fold) opening is the reader's own doing: it moves nothing.
 *  The dock and the view are watched by the same observer: when the reply box grows, or the keyboard shortens the view,
 *  at the tail the view goes back to the end, so the last block never sits under the box (`dockShift`). Every read
 *  comes before the one write. */
export function holdMedia(body: HTMLElement, dock: HTMLElement): () => void {
  const anchors = typeof CSS !== 'undefined' && CSS.supports?.('overflow-anchor', 'auto') === true;
  const sizes = new WeakMap<Element, number | null>();
  const size = (m: Element): number | null => (m.getClientRects().length > 0 ? (m as HTMLElement).offsetHeight : null);
  const turnsEl = body.querySelector<HTMLElement>(':scope > [data-kit="turns"]');
  const turns = turnsEl ? turnFollower(body, turnsEl, anchors) : undefined;
  let tail = atTail(body);
  const onScroll = (): void => {
    tail = atTail(body);
    turns?.onScroll();
  };
  const held = new Map<Element, number>(); // the dock's, the view's and the turns' heights, at the last frame
  const ro = new ResizeObserver((entries) => {
    const grew: Grew[] = [];
    const by = { dock: 0, view: 0, turns: 0 };
    for (const { target: m, borderBoxSize } of entries) {
      if (m === dock || m === body || m === turnsEl) {
        const to = borderBoxSize[0]?.blockSize ?? (m as HTMLElement).offsetHeight;
        const from = held.get(m);
        held.set(m, to);
        if (from !== undefined) by[m === dock ? 'dock' : m === body ? 'view' : 'turns'] = to - from;
        continue;
      }
      if (!m.isConnected) {
        ro.unobserve(m);
        continue;
      }
      const from = sizes.get(m);
      const to = size(m);
      sizes.set(m, to);
      if (from != null && to != null && Math.abs(to - from) >= 1) grew.push({ top: m.getBoundingClientRect().top, from, to });
    }
    if (!body.isConnected || body.clientHeight === 0) return;
    // a picture growing is mediaShift's; the turns growing otherwise (a turn landed, steps came in) is the follower's
    if (grew.length === 0 && Math.abs(by.turns) >= 1 && turns?.grew(by.turns)) return void (tail = atTail(body));
    const dockEnd = (by.dock !== 0 || by.view !== 0) && dockShift({ scrollHeight: body.scrollHeight, scrollTop: body.scrollTop, clientHeight: body.clientHeight, dock: by.dock, view: by.view }) === 'end';
    if (grew.length === 0 && !dockEnd) return;
    // a task that fit on screen is at its end and its start at once: a picture there pulls nothing
    const dy = grew.length === 0 ? 0 : mediaShift({ tail: tail && body.scrollTop > 0, anchors, inset: body.getBoundingClientRect().top + barOf(body), grew });
    if (dy === 'end' || dockEnd) body.scrollTop = body.scrollHeight;
    else if (Math.abs(dy) >= 1) body.scrollTop += dy;
    tail = atTail(body);
  });
  const watch = (root: ParentNode): void => {
    for (const m of root.querySelectorAll('img, video')) {
      if (sizes.has(m)) continue;
      sizes.set(m, size(m));
      ro.observe(m);
    }
  };
  watch(body);
  ro.observe(dock);
  ro.observe(body);
  if (turnsEl) ro.observe(turnsEl);
  const mo = new MutationObserver((records) => {
    watch(body);
    turns?.changed(records);
  });
  mo.observe(body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-live'] });
  body.addEventListener('scroll', onScroll, { passive: true });
  return () => {
    turns?.stop();
    ro.disconnect();
    mo.disconnect();
    body.removeEventListener('scroll', onScroll);
  };
}

const barOf = (body: HTMLElement): number => body.querySelector<HTMLElement>('[data-kit="it-bar"]')?.offsetHeight ?? 0;

/** F-page-44 (v1 turns.js renderBody `follow` / `place` / `land`): a turn landing while you read doesn't move you; at
 *  the end you're taken to it, from its start (a new turn, or the running one once it has finished: `data-live` goes).
 *  Not while the task opens (its kept place is the frame's), and not for what the reader did themselves (a fold they
 *  opened: v1's `byHand`). */
export function turnFollower(body: HTMLElement, turnsEl: HTMLElement, anchors: boolean): { onScroll: () => void; changed: (r: readonly MutationRecord[]) => void; grew: (by: number) => boolean; stop: () => void } {
  let armed = false;
  let frame: number | undefined;
  let landed: HTMLElement | undefined;
  let byHand = false;
  // at the end, as the last scroll left it (a shrink moves scrollTop, so then this is the one to trust)
  let atEnd = atTail(body);
  // WebKit (no scroll anchoring): the turn under the reading line and its top (px from the view's top)
  let reading: { el: HTMLElement; top: number } | undefined;
  const all = (): HTMLElement[] => [...turnsEl.querySelectorAll<HTMLElement>('[data-turn]')];
  const readLine = (): void => {
    if (anchors) return;
    const top = body.getBoundingClientRect().top;
    const el = all().find((t) => t.getBoundingClientRect().bottom > top + 1);
    reading = el ? { el, top: el.getBoundingClientRect().top - top } : undefined;
  };
  // armed a frame after the first turns are in: what the task opens on is the frame's (its kept place, its top)
  const arm = (): void => {
    if (armed || frame !== undefined || !turnsEl.querySelector('[data-turn]')) return;
    frame = requestAnimationFrame(() => {
      armed = true;
      readLine();
    });
  };
  // a click or key in the page: what grows in the next two frames is the reader's own doing (the layout it changed
  // comes in the next frame's ResizeObserver, after that frame's rAF callbacks, so the flag outlives one of them)
  let clear: number | undefined;
  const hand = (e: Event): void => {
    // typing or sending in the reply box (the dock, in the same scroller) changes no turn by hand
    if (!turnsEl.contains(e.target as Node)) return;
    byHand = true;
    if (clear !== undefined) cancelAnimationFrame(clear);
    clear = requestAnimationFrame(() => {
      clear = requestAnimationFrame(() => {
        clear = undefined;
        byHand = false;
      });
    });
  };
  body.addEventListener('click', hand, { capture: true, passive: true });
  body.addEventListener('keydown', hand, { capture: true });
  arm();
  return {
    onScroll: () => {
      atEnd = atTail(body);
      if (armed) readLine();
    },
    changed: (records) => {
      arm();
      if (!armed) return;
      const turns = all();
      const last = turns[turns.length - 1];
      if (!last) return;
      for (const r of records) {
        // the last turn added (older ones loading go first), or the last turn's run finishing
        if (r.type === 'childList' && [...r.addedNodes].some((n) => n === last || (n instanceof HTMLElement && n.contains(last)))) landed = last;
        if (r.type === 'attributes' && r.target === last && !last.hasAttribute('data-live')) landed = last;
      }
    },
    grew: (by) => {
      // a shrink only matters with a turn that landed (older turns folding away as it came)
      if (!armed || byHand || (by < 0 && !landed)) {
        landed = undefined; // a landing not followed now never comes back as a late jump
        return false;
      }
      const top = body.getBoundingClientRect().top;
      // where the reader was before: after a growth the end then is the end minus what grew (exact even when the
      // frame restored a place this frame); after a shrink the browser has clamped, so the last scroll's word
      const tail = by > 0 ? atTail({ scrollHeight: body.scrollHeight - by, scrollTop: body.scrollTop, clientHeight: body.clientHeight }) : atEnd;
      const was = reading?.el.isConnected ? reading : undefined;
      const to = landed?.isConnected ? landed : undefined;
      landed = undefined;
      const d = turnsShift({ tail, anchors, landed: !!to, ...(was && { held: { from: was.top, to: was.el.getBoundingClientRect().top - top } }) });
      if (d === 'land' && to) body.scrollTop += to.getBoundingClientRect().top - top - barOf(body);
      else if (d === 'end') body.scrollTop = body.scrollHeight;
      else if (typeof d === 'number' && Math.abs(d) >= 1) body.scrollTop += d;
      else return false;
      atEnd = atTail(body);
      readLine();
      return true;
    },
    stop: () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (clear !== undefined) cancelAnimationFrame(clear);
      body.removeEventListener('click', hand, { capture: true });
      body.removeEventListener('keydown', hand, { capture: true });
    },
  };
}
