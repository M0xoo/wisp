// A task in several folders, end to end once (F-comp-47 / F-task-27): two projects picked over the list, New task's
// `runtime.create` carries the second as `dirs` (launchOf + dirsOf, as HomeView sends it), the mock peer keeps them on
// the row's body as runtime's Session.dirs, and the task page's places read both back, its own first.
import { expect, test } from 'vitest';
import { createClient, peerId, type EntityKey } from '@wisp/client';
import { create, dirsOf, launchOf, parsePick, projectList, taskPlaces, type ProjectView } from '@wisp/shell/pure';
import { createMockPeer, type MockTimers } from '../dev/mock-peer.ts';
import { memTransport } from '../dev/mem-transport.ts';

const timers: MockTimers = { now: () => 1_800_000_000_000, setTimeout: () => undefined, clearTimeout: () => undefined };
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

test('new_task_with_two_projects_picked_creates_a_task_whose_spec_has_dirs_and_its_page_shows_both_places', async () => {
  const mock = createMockPeer({ timers, epoch: 'e1' });
  const sent: unknown[] = [];
  const handle = mock.receive.bind(mock);
  mock.receive = (clientId, m) => {
    if (m.t === 'mutate' && m.cmd === 'runtime.create') sent.push(m.args);
    handle(clientId, m);
  };
  const client = createClient({ clientId: 'c1', build: 't', home: peerId('local'), width: 1440, onError: () => undefined });
  await client.start([{ peer: peerId('local'), name: 'mock', transport: memTransport(mock) }]);
  const scope = client.scope.child('test');
  client.peers.watch(peerId('local'), 'list', scope);
  client.peers.watch(peerId('local'), 'config', scope);
  await settle();
  // two projects on this computer (the mock adds them as `wisp add` would)
  const apply = { id: 'resources.apply', owner: () => peerId('local'), optimistic: 'none' as const };
  const resources = [
    { kind: 'project', name: 'api', spec: { path: '/code/api' } },
    { kind: 'project', name: 'web', spec: { path: '/code/web' } },
  ];
  await client.commands.run(apply as never, { resources } as never);
  await settle();
  const projects: ProjectView[] = projectList(client.entities.list<unknown>('project')(), undefined);
  const [a, b] = projects;
  if (!a || !b) throw new Error('two projects were added');
  // the pick "a,b": New task starts in a and also works in b
  const pick = launchOf(parsePick(`${a.id},${b.id}`), projects);
  const start = projects.find((p) => p.id === pick.start);
  const dirs = dirsOf(start, pick.also, projects);
  expect(dirs).toEqual([b.path]);
  const id = 'local:t-dirs';
  const run = client.commands.run(create, { peer: 'local', id, prompt: 'Rename the API in both', agent: 'claude', mode: 'auto', at: 1, cwd: a.path, projectId: a.id, color: a.color, worktree: true, dirs });
  // at once: the optimistic row already says where it works
  const early = client.entities.peek('session', id as EntityKey) as { body?: Record<string, unknown> } | undefined;
  expect(early?.body?.['dirs']).toEqual([b.path]);
  await run;
  await settle();
  // the wire: runtime.create's args name the extra folder
  expect(sent).toHaveLength(1);
  expect((sent[0] as { dirs?: unknown }).dirs).toEqual([b.path]);
  // the peer's row: its body keeps them, and the page's places are its own project, then the other
  const row = client.entities.peek('session', id as EntityKey) as { summary: Record<string, unknown>; body?: Record<string, unknown> };
  expect(row.body?.['dirs']).toEqual([b.path]);
  const places = taskPlaces({ name: String(row.summary['project'] ?? ''), color: String(row.summary['color'] ?? ''), cwd: String(row.summary['cwd'] ?? ''), projectId: String(row.summary['projectId'] ?? '') }, row.body?.['dirs'], projects);
  expect(places.map((p) => p.id)).toEqual([a.id, b.id]);
});
