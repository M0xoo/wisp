// The project selector and switcher (frame/project-switch.ts): ⌘P, ⌘0–⌘9, and projects that hold their tasks.
import { expect, test } from 'vitest';
import { projectList, projectOf } from '../src/frame/rows-view.ts';
import { PROJECT_SOURCE, projectShortcuts } from '../src/frame/project-switch.ts';
import { BUILT_IN_KEYS } from '../src/keys.ts';
import type { ShellContext } from '../src/contract.ts';

test('a_project_added_as_dot_holds_its_tasks', () => {
  const list = projectList([{ id: 'p', name: 'demo', path: '/tmp/demo/.' }, { id: 'q', name: 'web', path: '/tmp/web/' }], undefined);
  expect(list.map((p) => p.path)).toEqual(['/tmp/demo', '/tmp/web']);
  expect(projectOf('/tmp/demo', list)?.id).toBe('p');
  expect(projectOf('/tmp/demo/src', list)?.id).toBe('p');
  expect(projectOf('/tmp/web', list)?.id).toBe('q');
  expect(projectOf('/tmp/demolition', list)).toBeUndefined();
});

test('cmd_p_opens_the_switcher_and_cmd_digits_jump_to_projects', () => {
  const set: string[] = [];
  const opened: unknown[] = [];
  const rows = [{ id: 'a', name: 'api', path: '/a' }, { id: 'b', name: 'web', path: '/b' }];
  const list = (kind: string) => () => (kind === 'project' ? rows : []);
  const ctx = {
    client: { entities: { list } },
    projectFilter: { value: () => 'all', set: (id: string) => set.push(id) },
    navigate: (i: unknown) => opened.push(i),
    t: (k: string) => k,
    platform: { apple: true },
  } as unknown as ShellContext;
  const keys = projectShortcuts(ctx);
  const by = (k: string) => keys.find((s) => s.keys === k);
  by('mod+p')?.run({} as never);
  expect(JSON.stringify(opened[0])).toContain(PROJECT_SOURCE);
  expect(by('mod+2')?.run({} as never)).toBe(true);
  expect(by('mod+0')?.run({} as never)).toBe(true);
  expect(by('mod+5')?.run({} as never)).toBe(false); // no fifth project: the key goes on
  expect(set).toEqual(['b', 'all']);
  // no user plugin can take them
  for (const k of ['mod+p', 'mod+0', 'mod+9']) expect(BUILT_IN_KEYS.has(k)).toBe(true);
});
