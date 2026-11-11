// Projects reach the list (round 17): a task is in the project that holds its folder (v1 projectFor), so the
// project filter shows it; the row stays the same object while its project doesn't change (no repaint).
import { expect, test } from 'vitest';
import { projectList } from '@wisp/shell';
import type { SessionRow } from '../src/types.ts';
import { flatSession } from '../src/model/wire.ts';
import { sections } from '../src/model/sections.ts';
import { inProjectOf } from '../src/state.ts';

const row = (id: string, cwd: string): SessionRow =>
  flatSession({ id, title: id, state: 'review', agent: 'claude', created_at: 1, updated_at: 2, body: { cwd }, summary: { status: 'done', preview: '' } } as unknown as SessionRow);

test('a_task_is_in_the_project_holding_its_folder_and_the_filter_shows_only_that_projects_tasks', () => {
  const ps = projectList(
    [
      { id: 'web', body: { path: '/w/web' } },
      { id: 'api', body: { path: '/w/api' } },
    ],
    ['api'],
  );
  const raw = [row('a', '/w/web/src'), row('b', '/w/api'), row('c', '/tmp/x')];
  const rows = raw.map((r) => inProjectOf(r, ps));
  expect(rows.map((s) => s.projectId)).toEqual(['web', 'api', undefined]);
  expect(inProjectOf(raw[0] as SessionRow, ps)).toBe(rows[0]);
  // the same projects again (a new list, same answer): the same row object
  const again = projectList(
    [
      { id: 'web', body: { path: '/w/web' } },
      { id: 'api', body: { path: '/w/api' } },
    ],
    ['api'],
  );
  expect(inProjectOf(raw[0] as SessionRow, again)).toBe(rows[0]);
  const keyed = rows.map((s) => ({ key: `p:${s.id}`, s }));
  const ids = (project: string): string[] =>
    Object.values(sections(keyed as never, { project }))
      .flat()
      .map((e) => (e as { s?: SessionRow }).s?.id ?? '')
      .filter(Boolean)
      .sort();
  expect(ids('web')).toEqual(['a']);
  expect(ids('all')).toEqual(['a', 'b', 'c']);
});

test('a_row_from_a_sandbox_says_sandbox_in_the_machines_slot_and_one_from_this_wisp_says_nothing', async () => {
  const { machinesByPeer, onMachine } = await import('../src/state.ts');
  const { runOf } = await import('../src/model/row.ts');
  const ms = machinesByPeer([
    { id: 'h:m1', body: { peer: 'sbx1', name: 'Sandbox fix the login', data: { sandbox: 'a1' } } },
    { id: 'h:m2', body: { peer: 'studio', name: 'Studio' } },
    { id: 'h:m3', body: { peer: null, name: 'Not answered yet' } },
  ]);
  expect([...ms.keys()]).toEqual(['m1', 'm2']);
  const r = row('a', '/root/code/web');
  const boxed = onMachine(r, ms.get('m1'));
  expect(onMachine(r, ms.get('m1'))).toBe(boxed);
  expect(onMachine(r, undefined)).toBe(r);
  const ctx = { split: false, open: false, swipes: false, here: 'This Mac', sandbox: 'Sandbox', agents: new Map() } as never;
  expect(runOf(boxed, ctx)).toMatchObject({ where: 'Sandbox', sandbox: true, remote: true });
  expect(runOf(onMachine(r, ms.get('m2')), ctx)).toMatchObject({ where: 'Studio', remote: true });
  expect(runOf(r, ctx)).toMatchObject({ where: 'This Mac', remote: false });
});
