// v1's keys (kbd.js) as the shell registers them: J/K walk the list's rows, E / A / Delete act on the picked row,
// and the open task's keys go to its page, which says what it handled.
import { afterEach, expect, test } from 'vitest';
import { shellUi } from '../src/builtins.tsx';
import type { ShellContext, ShortcutDef } from '../src/contract.ts';
import { TASK_KEY } from '../src/frame/task-keys.ts';

afterEach(() => {
  document.body.innerHTML = '';
});

function fake(main: { kind: string; id?: string }) {
  let picked: string | undefined;
  const went: unknown[] = [];
  const ran: { cmd: string; args: unknown }[] = [];
  const ctx = {
    nav: () => ({ main, side: { kind: 'none' }, overlays: [], layout: 'split' }),
    navigate: (i: unknown) => void went.push(i),
    selection: { get: () => picked, set: (k: string | undefined) => void (picked = k) },
    client: { commands: { run: (cmd: { id: string }, args: unknown) => (ran.push({ cmd: cmd.id, args }), Promise.resolve()) } },
    palette: { open: () => {} },
    sidebar: { toggle: () => {} },
    focusTargets: { focus: () => false },
    t: (k: string) => k,
  } as unknown as ShellContext;
  const keys = (shellUi(ctx).shortcuts ?? []) as ShortcutDef[];
  const press = (id: string): boolean | void => keys.find((s) => s.id === id)?.run({ event: new KeyboardEvent('keydown') } as never);
  return { ctx, keys, press, went, ran, picked: () => picked };
}

test('v1s_keys_walk_the_list_act_on_the_picked_row_and_reach_the_open_tasks_page', () => {
  document.body.innerHTML = ['a', 'b', 'c'].map((id) => `<article data-part="card" data-id="laptop:${id}"></article>`).join('');
  const f = fake({ kind: 'home' });
  // ~30 keys, each once (Enter and Backspace are the second key of Open and Delete)
  expect(new Set(f.keys.map((k) => k.keys)).size).toBeGreaterThanOrEqual(30);
  f.press('shell.next');
  expect(f.picked()).toBe('laptop:a');
  f.press('shell.next');
  f.press('shell.next');
  f.press('shell.next');
  expect(f.picked()).toBe('laptop:c'); // stops at the end
  f.press('shell.prev');
  expect(f.picked()).toBe('laptop:b');
  // E on the picked row: done, as its button does
  expect(f.press('shell.done')).toBe(true);
  expect(f.ran.at(-1)).toEqual({ cmd: 'runtime.setState', args: { id: 'laptop:b', state: 'done' } });
  expect(f.went.at(-1)).toEqual({ t: 'markDone', id: 'laptop:b' });
  // O opens it
  f.press('shell.open');
  expect(f.went.at(-1)).toEqual({ t: 'openTask', id: 'laptop:b' });
  // a task key with no task open goes on
  expect(f.press('shell.task.transcript')).toBe(false);

  // with a task open, its keys reach the page; what the page doesn't handle goes on
  const g = fake({ kind: 'task', id: 'laptop:a' });
  const heard: string[] = [];
  const page = (e: Event): void => {
    const act = (e as CustomEvent<string>).detail;
    heard.push(act);
    if (act !== 'answer:9') e.preventDefault();
  };
  document.addEventListener(TASK_KEY, page);
  expect(g.press('shell.task.transcript')).toBe(true);
  expect(g.press('shell.task.ship')).toBe(true);
  expect(g.press('shell.task.answer9')).toBe(false);
  // E with a task open: the page marks it done (its button), not the list
  expect(g.press('shell.done')).toBe(true);
  expect(heard).toEqual(['transcript', 'ship', 'answer:9', 'done']);
  expect(g.ran).toEqual([]);
  document.removeEventListener(TASK_KEY, page);
});
