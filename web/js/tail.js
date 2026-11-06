// The tail of a task: where new output keeps the reader at the end. DOM-free (it only reads a box's
// scroll numbers), so test/web-pure.test.js can drive it; features/scroll.js re-exports it.
//
// Nothing that happens by itself moves what you're reading. The one exception is the tail, and the
// other is your own send, which moves the view once (docs/feed.md, Scroll and focus rules).

const SLACK = 40; // how near the end still counts as at the end, like the crew thread (crew.js)
const LEFT = 2; // once you've scrolled up: a slow 30px up has left, and isn't pulled back
const OWN_MS = 15000; // a send that has no turn yet: past this, the next turn isn't its answer

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
