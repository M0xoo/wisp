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
