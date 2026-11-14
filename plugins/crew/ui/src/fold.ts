// The Crew section's compact form (v1 crew.js paintCrew, crewRows, stripHtml), pure: who gets a full row (busy
// members, then the most needed up to two), who folds into the row of faces, how many jobs sit under each, and
// whether Show fewer shows. While the pointer or focus is in the section, the order and the rows shown hold.

import { crewRows, FACES_MAX, holdOrder, ROWS_MIN, type State } from './model.ts';
import { JOBS_MAX } from './rules/feed.ts';
import type { Member } from './types.ts';

export interface SectionPlan<M> {
  /** members with a full row, in order */
  rows: M[];
  /** the rest, folded (in order) */
  folded: M[];
  /** the faces on the folded row (the open member's kept in view) */
  faces: M[];
  /** jobs under each shown member: busy (or all shown) 3, an idle one filling the minimum 1 */
  jobsMax: (id: string) => number;
  /** Show all is on and there's enough to fold again */
  fewer: boolean;
}

export interface SectionHold {
  /** the order and the full rows when the pointer came in, or null when it isn't in */
  order: readonly string[] | null;
  full: ReadonlySet<string>;
}

export function sectionPlan<M extends Member>(
  ranked: readonly M[],
  states: ReadonlyMap<string, State>,
  o: { all: boolean; open: ReadonlySet<string>; hold: SectionHold; crewOpen: string | null; min?: number },
): SectionPlan<M> {
  const min = o.min ?? ROWS_MIN;
  const list = holdOrder(ranked, o.hold.order);
  const { full, busy } = crewRows(list, states, { all: o.all, open: o.open, held: o.hold.order ? o.hold.full : new Set(), min });
  const rows = list.filter((m) => full.has(m.id));
  const folded = list.filter((m) => !full.has(m.id));
  const faces = folded.slice(0, FACES_MAX);
  const open = folded.find((m) => m.id === o.crewOpen);
  if (open && !faces.includes(open)) faces[faces.length - 1] = open;
  return { rows, folded, faces, jobsMax: (id) => (busy.has(id) || o.all ? JOBS_MAX : 1), fewer: o.all && list.length > min + 1 };
}
