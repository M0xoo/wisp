import { expect, test } from 'vitest';
import { sectionPlan } from '../src/fold.ts';
import type { State } from '../src/model.ts';
import type { Member, SessionRow } from '../src/types.ts';

const member = (id: string, extra: Partial<Member> = {}): Member => ({ id, name: id, paused: false, ...extra }) as Member;
const idle: State = { jobs: [], sent: [], asks: false, live: [], unread: 0, mood: 'idle' };
const job = (id: string, extra: Partial<SessionRow> = {}): SessionRow => ({ id, state: 'running', crew: { id: 'x', job: 'task' }, ...extra }) as SessionRow;
const none = { order: null, full: new Set<string>() };

test('with_nobody_busy_two_members_keep_a_row_and_the_rest_fold_into_faces', () => {
  const crew = ['a', 'b', 'c', 'd', 'e'].map((id) => member(id));
  const states = new Map(crew.map((m) => [m.id, idle]));
  const p = sectionPlan(crew, states, { all: false, open: new Set(), hold: none, crewOpen: null });
  expect(p.rows.map((m) => m.id)).toEqual(['a', 'b']);
  expect(p.folded.map((m) => m.id)).toEqual(['c', 'd', 'e']);
  expect(p.jobsMax('a')).toBe(1); // an idle member filling the minimum keeps one job under it
  expect(p.fewer).toBe(false);
});

test('busy_members_always_get_a_row_first_and_one_left_over_never_folds_alone', () => {
  const crew = ['a', 'b', 'c', 'd'].map((id) => member(id));
  // ranked: the busy ones first (rankCrew's job); c asks, d works on a job for you
  const ranked = [crew[2], crew[3], crew[0], crew[1]] as Member[];
  const states = new Map<string, State>(crew.map((m) => [m.id, idle]));
  states.set('c', { ...idle, asks: true, mood: 'asks' });
  states.set('d', { ...idle, live: [job('j1')], mood: 'live' });
  const p = sectionPlan(ranked, states, { all: false, open: new Set(), hold: none, crewOpen: null });
  expect(p.rows.map((m) => m.id)).toEqual(['c', 'd']);
  expect(p.folded.map((m) => m.id)).toEqual(['a', 'b']);
  expect(p.jobsMax('c')).toBe(3);
  // three members, two busy: the third would fold alone, so it shows
  const three = sectionPlan(ranked.slice(0, 3), states, { all: false, open: new Set(), hold: none, crewOpen: null });
  expect(three.folded).toEqual([]);
  // a check-in in progress isn't busy (scheduled members would pop in and out all day)
  states.set('d', { ...idle, live: [job('j2', { crew: { id: 'd', job: 'checkin' } })], mood: 'live' });
  const rounds = sectionPlan(ranked, states, { all: false, open: new Set(), hold: none, crewOpen: null });
  expect(rounds.rows.map((m) => m.id)).toEqual(['c', 'd']); // d only fills the minimum now
  expect(rounds.jobsMax('d')).toBe(1);
});

test('show_all_lists_everyone_with_show_fewer_and_the_open_member_stays_among_the_faces', () => {
  const crew = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => member(id));
  const states = new Map(crew.map((m) => [m.id, idle]));
  const all = sectionPlan(crew, states, { all: true, open: new Set(), hold: none, crewOpen: null });
  expect(all.rows).toHaveLength(7);
  expect(all.fewer).toBe(true);
  expect(all.jobsMax('g')).toBe(3);
  const p = sectionPlan(crew, states, { all: false, open: new Set(), hold: none, crewOpen: 'g' });
  expect(p.faces.map((m) => m.id)).toEqual(['c', 'd', 'e', 'g']);
});

test('while_the_pointer_is_in_the_section_rows_shown_stay_and_the_order_holds', () => {
  const crew = ['a', 'b', 'c', 'd'].map((id) => member(id));
  const states = new Map<string, State>(crew.map((m) => [m.id, idle]));
  // c was busy when the pointer came in, so it had a row; it went quiet and ranks last now
  const hold = { order: ['c', 'a', 'b', 'd'], full: new Set(['c', 'a', 'b']) };
  const p = sectionPlan(crew, states, { all: false, open: new Set(), hold, crewOpen: null });
  expect(p.rows.map((m) => m.id)).toEqual(['c', 'a', 'b', 'd']); // d would fold alone, so it shows
  const out = sectionPlan(crew, states, { all: false, open: new Set(), hold: none, crewOpen: null });
  expect(out.rows.map((m) => m.id)).toEqual(['a', 'b']);
});
