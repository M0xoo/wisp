// The panes setting (panes/grant.ts, v1 pane-bridge.js parsePanes/appFor and panes.js pinApp): "<app>@home,<app>@task".
import { expect, test } from 'vitest';
import { panesAt, panesProblem, taskTabs, withPin } from '../src/panes/grant.ts';
import type { Item } from '../src/types.ts';

const app = (id: string, title: string, o: Partial<Item> = {}): Item => ({ id, kind: 'app', name: `${id}.html`, title, size: 0, at: 0, by: 'you', ...o }) as Item;
const items = [app('a1', 'Board'), app('a2', 'PR notes'), app('a3', 'Sending', { pending: true }), { ...app('d1', 'Plan'), kind: 'doc' } as Item];

test('pinning on home adds the app once, keeps the others in their order, and Undo takes only it out_v1_pin_app', () => {
  // a pin names an app by id, else by name or title (any case); a doc, a pending save or nothing in My Stuff isn't one
  expect(panesAt('a2@task, board@home ,a3@home,d1@home,gone@home', 'home', items).map((x) => x.id)).toEqual(['a1']);
  expect(panesAt('a2@task', 'task', items).map((x) => x.id)).toEqual(['a2']);
  const first = items[0] as Item;
  const second = items[1] as Item;
  const pinned = withPin('a2@task', first, 'home', true, items);
  expect(pinned).toBe('a2@task,a1@home');
  expect(withPin(pinned, first, 'home', true, items)).toBe('a2@task,a1@home'); // pinned twice: once
  expect(withPin('a2@task,a1@home', second, 'home', true, items)).toBe('a2@task,a1@home,a2@home');
  expect(withPin('a2@task,Board@home,a2@home', first, 'home', false, items)).toBe('a2@task,a2@home'); // by title too
  expect(panesProblem(withPin('', first, 'home', true, items))).toBe('');
  expect(panesProblem('x@nowhere')).toContain('should be <app id or name>@task or @home');
});

test('the apps pinned beside tasks are a tab each beside the task, in pin order, home pins left out_v1_panel_pane_tabs', () => {
  const say = (k: string, v: Readonly<Record<string, string>>): string => `${k}:${v['name'] ?? ''}`;
  expect(taskTabs('a2@task,a1@home,board@task,d1@task,gone@task', items, say)).toEqual([
    { value: 'a2', label: 'PR notes', title: 'stuff.pane.tabTitle:PR notes' },
    { value: 'a1', label: 'Board', title: 'stuff.pane.tabTitle:Board' },
  ]);
  // unpinned beside tasks: its tab goes (the panel then opens Changes, as v1's tabOf)
  expect(taskTabs(withPin('a2@task,a1@task', items[1] as Item, 'task', false, items), items, say).map((x) => x.value)).toEqual(['a1']);
  expect(taskTabs('', items, say)).toEqual([]);
});
