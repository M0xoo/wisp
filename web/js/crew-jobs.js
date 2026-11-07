// A crew member's jobs, in the order that matters: the ranking the Crew section and the rail's hover
// card share, and what the card does with it. DOM-free, so it's tested outside a browser.

// Asking you, working, an unread report, then what it finished.
export const jobRank = (s) => (s.pending || s.state === 'running' ? 1 : s.state === 'waiting' ? 0 : s.state === 'review' && s.unread ? 2 : 3);
export const byUrgency = (a, b) => jobRank(a) - jobRank(b) || (b.updatedAt || 0) - (a.updatedAt || 0);
// Still on the member's plate: one you marked done or archived is only in its thread.
export const standing = (s) => (!s.archived && s.state !== 'done') || s.state === 'running' || s.state === 'waiting';

// How many rows the card shows; past that its last row opens the thread.
export const CARD_ROWS = 6;
// Every job the face counts, not only the ones that sit under it in the section: a check-in or a job
// you sent is in the list like any task, but the face's live chip counts it, so the card must show it.
export const cardJobs = (st) => [...st.jobs, ...st.sent].filter((s) => s.pending || standing(s)).sort(byUrgency);

// The marker a row wears, from the same rank.
export const jobMark = (s) => ['asks', 'live', 'unread', ''][jobRank(s)];

// The rows while the card is up: each keeps its place, whatever its job does (nothing moves under the
// pointer). A job that left gives its place to a newcomer (a Starting up placeholder to its real job)
// or keeps it until the card closes; other newcomers go last, while there's room.
export function holdRows(shown, fresh, gone, max = CARD_ROWS) {
  const news = fresh.filter((id) => !shown.includes(id));
  const out = shown.map((id) => (gone(id) && news.length ? news.shift() : id));
  while (out.length < max && news.length) out.push(news.shift());
  return out;
}

// Is the pointer, since it left the card's face, going for the card rather than along the rail? Its
// whole way so far, not its last move: a steep path to a low row is a run of mostly vertical moves.
// out: pixels toward the card, down: pixels along the rail.
export const headingForCard = (out, down) => out >= 2 && out * 6 >= Math.abs(down);

// The arrow keys inside the card: index of the next stop, or null when the key isn't one of its own.
export function stepRow(key, at, n) {
  const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: n - 1 }[key];
  return to === undefined ? null : Math.max(0, Math.min(to, n - 1));
}
