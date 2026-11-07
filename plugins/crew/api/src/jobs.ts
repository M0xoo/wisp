// A crew member's jobs, in the order that matters (v1 web/js/crew-jobs.js): the ranking the Crew
// section and the rail's hover card share, and what the card does with it. Pure: the UI and the
// server both read it, so it sits in the api rather than in a UI package.

/** The fields of a job row these rules read (a Summary has them all). */
export interface JobLike {
  id: string;
  state?: string;
  unread?: boolean;
  archived?: boolean;
  pending?: boolean;
  updatedAt?: number;
}

/** Asking you (0), working (1), an unread report (2), then what it finished (3). */
export const jobRank = (s: JobLike): number => (s.pending || s.state === 'running' ? 1 : s.state === 'waiting' ? 0 : s.state === 'review' && s.unread ? 2 : 3);
export const byUrgency = (a: JobLike, b: JobLike): number => jobRank(a) - jobRank(b) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
/** Still on the member's plate: one you marked done or archived is only in its thread. */
export const standing = (s: JobLike): boolean => (!s.archived && s.state !== 'done') || s.state === 'running' || s.state === 'waiting';

/** How many rows the card shows; past that its last row opens the thread. */
export const CARD_ROWS = 6;

/**
 * Every job the face counts, not only the ones that sit under it in the section: a check-in or a job
 * you sent is in the list like any task, but the face's live chip counts it, so the card shows it.
 */
export const cardJobs = <J extends JobLike>(st: { jobs: readonly J[]; sent: readonly J[] }): J[] => [...st.jobs, ...st.sent].filter((s) => s.pending || standing(s)).sort(byUrgency);

/** The marker a row wears, from the same rank. */
export const jobMark = (s: JobLike): string => ['asks', 'live', 'unread', ''][jobRank(s)] ?? '';

/**
 * The rows while the card is up: each keeps its place, whatever its job does (nothing moves under the
 * pointer). A job that left gives its place to a newcomer (a Starting up placeholder to its real job)
 * or keeps it until the card closes; other newcomers go last, while there's room.
 */
export function holdRows(shown: readonly string[], fresh: readonly string[], gone: (id: string) => boolean, max = CARD_ROWS): string[] {
  const news = fresh.filter((id) => !shown.includes(id));
  const out = shown.map((id) => (gone(id) && news.length ? (news.shift() ?? id) : id));
  while (out.length < max && news.length) out.push(news.shift() ?? '');
  return out;
}

/**
 * Is the pointer, since it left the card's face, going for the card rather than along the rail? Its
 * whole way so far, not its last move. out: pixels toward the card, down: pixels along the rail.
 */
export const headingForCard = (out: number, down: number): boolean => out >= 2 && out * 6 >= Math.abs(down);

/** The arrow keys inside the card: index of the next stop, or null when the key isn't one of its own. */
export function stepRow(key: string, at: number, n: number): number | null {
  const to = ({ ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: n - 1 } as Record<string, number>)[key];
  return to === undefined ? null : Math.max(0, Math.min(to, n - 1));
}
