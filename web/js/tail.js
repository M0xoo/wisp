// The tail of a task: where new output keeps the reader at the end. DOM-free (it only reads a box's
// scroll numbers), so test/web-pure.test.js can drive it; features/scroll.js re-exports it.
//
// Nothing that happens by itself moves what you're reading. The one exception is the tail, and the
// other is your own send, which moves the view once (docs/feed.md, Scroll and focus rules).

const SLACK = 40; // how near the end still counts as at the end, like the crew thread (crew.js)
const LEFT = 2; // once you've scrolled up: a slow 30px up has left, and isn't pulled back
const OWN_MS = 15000; // a send that has no turn yet: past this, the next turn isn't its answer
const LAND_MS = 1000; // a smooth scroll to a turn: long enough for it to arrive

const gapOf = (box) => box.scrollHeight - box.clientHeight - box.scrollTop;

// Per box: where the last scroll ended and whether it went up.
const seen = new WeakMap();

// A scroll on `box` happened (the body's passive listener, turns.js). Up only counts when it left
// the end: a fold that shrinks the page clamps scrollTop too, and the reader didn't move.
export function noteScroll(box) {
  const was = seen.get(box);
  const y = box.scrollTop;
  const up = y > was?.y ? false : y < was?.y ? gapOf(box) > LEFT : !!was?.up;
  seen.set(box, { y, up });
}

export const atTail = (box) => gapOf(box) <= (seen.get(box)?.up ? LEFT : SLACK);

// Scrolling to a turn takes a moment, and all that time the view is far from the end. A render in
// that moment still follows, and a row changing section (which kills a smooth scroll: its card
// leaves the page) sends it on again, or the reader stops halfway. Scrolling up calls it off.
export const landStart = (n, now = Date.now()) => {
  n.landUntil = now + LAND_MS;
};
export const landing = (n, box, now = Date.now()) => n.landUntil > now && !seen.get(box)?.up;

// Down to the very end, only if that moves anything: any write cancels a smooth scroll in flight.
export function toEnd(box) {
  const end = box.scrollHeight - box.clientHeight;
  if (end - box.scrollTop >= 1) box.scrollTop = end;
}

// A send that starts a turn with no pending turn to show for it (it interrupts the run, or a queued
// one sent now). The next new turn is its answer, unless it's so late that it can't be.
export const ownSend = (n, now = Date.now()) => {
  n.ownUntil = now + OWN_MS;
};
export const ownWaiting = (n, now = Date.now()) => n.ownUntil > now;

// What changed about the task's latest turn. `known` holds the turns on the page (ids, or a Map by
// id), `last` the latest one the page knew, `flagged` an ownSend still waiting for its turn.
//   adopted: the id of the pending turn the real one just replaced. The same turn, not a new one.
//   newTurn: a turn the page hasn't seen. A rollback also lands here, with nothing of its own.
//   own:     the user's send started it, so the view goes to it once. Compact is housekeeping.
export function turnChange({ turns, known, last, flagged = false }) {
  const latest = turns.at(-1);
  const id = latest?.id;
  const keys = known instanceof Map ? [...known.keys()] : [...known];
  const pending = (x) => String(x).startsWith('pending-');
  if (id === last) return { newTurn: false, adopted: null, own: false };
  if (id && !pending(id) && !keys.includes(id)) {
    const gone = keys.find((k) => pending(k) && !turns.some((t) => t.id === k));
    if (gone) return { newTurn: false, adopted: gone, own: false };
  }
  return { newTurn: true, adopted: null, own: !!id && latest.by !== 'compact' && (pending(id) || flagged) };
}

// A picture or video in a task took its real size: it loads lazily and nothing holds its box
// before that, so it grows from nothing to its height. `grew` is each one's top now and its height
// before and after. At the tail the view goes back to the end ('end'). Elsewhere what's being read
// holds: browsers with scroll anchoring (Chrome) already did that (`anchors`); without it (WebKit:
// Safari, the Mac app) each one that was wholly above the reading line (`inset`) pushed the text
// down by what it grew, so that much is the shift to undo.
export function mediaShift({ tail, anchors, inset, grew }) {
  if (tail) return 'end';
  if (anchors) return 0;
  let above = 0; // what the ones higher up grew: they pushed this one down too
  let dy = 0;
  for (const g of [...grew].sort((a, b) => a.top - b.top)) {
    if (g.top - above + g.from <= inset) dy += g.to - g.from;
    above += g.to - g.from;
  }
  return dy;
}
