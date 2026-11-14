// A crew member picked on the rail: the list holds only that member's jobs (v1 crew.js inPick). The job's marker
// is the crew's note in the row's body (`body.ext["wisp.crew"]`), read as `crew`.
import { expect, test } from 'vitest';
import type { SessionRow } from '../src/types.ts';
import { flatSession } from '../src/model/wire.ts';
import { sections } from '../src/model/sections.ts';

const row = (id: string, crew?: string): SessionRow =>
  flatSession({ id, title: id, state: 'review', agent: 'claude', created_at: 1, updated_at: 2, body: { cwd: '/p', ...(crew && { ext: { 'wisp.crew': { id: crew, job: 'task' } } }) }, summary: { status: 'done', preview: '' } } as unknown as SessionRow);

test('a_picked_crew_members_list_holds_only_their_jobs_read_from_the_rows_crew_note', () => {
  const rows = [row('a', 'ada'), row('b'), row('c', 'bob')];
  expect(rows.map((s) => s.crew?.id)).toEqual(['ada', undefined, 'bob']);
  const keyed = rows.map((s) => ({ key: `p:${s.id}`, s }));
  const ids = (f: Parameters<typeof sections>[1]): string[] => Object.values(sections(keyed as never, f)).flat().map((e) => (e as { s?: SessionRow }).s?.id ?? '').filter(Boolean).sort();
  expect(ids({ project: 'all', crew: 'ada' })).toEqual(['a']);
  expect(ids({ project: 'all', crew: 'nobody' })).toEqual([]);
  expect(ids({ project: 'all' })).toEqual(['a', 'b', 'c']);
});

const job = (id: string, crew: string, kind: string, state: string, unread = false): SessionRow =>
  flatSession({ id, title: id, state, agent: 'claude', unread, created_at: 1, updated_at: 2, body: { cwd: '/p', ext: { 'wisp.crew': { id: crew, job: kind } } }, summary: { status: state, preview: '' } } as unknown as SessionRow);

test('with the phone Crew section there, a members jobs for other tasks leave the list until they need you_v1_under_member', async () => {
  const { underMemberOf } = await import('../src/state.ts');
  const rows = [job('d', 'ada', 'delegated', 'running'), job('m', 'ada', 'mention', 'review', true), job('c', 'ada', 'checkin', 'running'), job('g', 'gone', 'delegated', 'running'), job('e', 'ada', 'event', 'done')];
  const keyed = rows.map((s) => ({ key: `p:${s.id}`, s }));
  const ids = (f: Parameters<typeof sections>[1]): string[] => Object.values(sections(keyed as never, f)).flat().map((e) => (e as { s?: SessionRow }).s?.id ?? '').filter(Boolean).sort();
  // nested: the delegated one and the finished event go under Ada; the unread mention needs you (Needs you); a
  // check-in is a task like any other; a job of a member who left stays in the list
  expect(ids({ project: 'all', underMember: underMemberOf(new Set(['ada'])) })).toEqual(['c', 'g', 'm']);
  // no section (side by side): everything stays in the list
  expect(ids({ project: 'all' })).toEqual(['c', 'd', 'e', 'g', 'm']);
});

test('a_crew_jobs_row_shows_its_members_face_read_from_the_crew_member_row_with_the_jobs_mood', async () => {
  const { crewFaceOf } = await import('../src/model/crew-face.ts');
  const rows = [{ id: 'm1', name: 'Ada', updated_at: 1, body: { name: 'Ada', avatar: 'flame.teal.visor.smile.antenna', color: 'teal' } }, { id: 'm2', name: 'Bob', avatar: '🦊' }];
  // asking you (Needs you): the face asks
  expect(crewFaceOf(rows, { crew: { id: 'm1' }, state: 'waiting' })).toEqual({ name: 'Ada', avatar: 'flame.teal.visor.smile.antenna', color: 'teal', mood: 'asks' });
  expect(crewFaceOf(rows, { crew: { id: 'm2' }, state: 'running' })).toEqual({ name: 'Bob', avatar: '🦊', mood: 'live' });
  // a task of yours, or a member who left: the project dot stays
  expect(crewFaceOf(rows, { state: 'waiting' })).toBeUndefined();
  expect(crewFaceOf(rows, { crew: { id: 'gone' }, state: 'done' })).toBeUndefined();
});
