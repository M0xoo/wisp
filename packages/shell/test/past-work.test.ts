// ⌘K past work (src/palette/tasks.ts pastWork, v1 F-task-20): runtime.search's hits as task items with the words found.
import { expect, test } from 'vitest';
import { pastWork } from '../src/palette/tasks.ts';

test('three letters or more find tasks by the words inside their prompts and answers_v1_palette_past_work', async () => {
  const sent: unknown[] = [];
  const opened: unknown[] = [];
  const ctx = {
    client: {
      plugin: () => ({ home: 'p' }),
      scope: { timers: { now: () => 10 * 60_000 } },
      commands: { run: async (cmd: { id: string }, args: unknown) => (sent.push([cmd.id, args]), [{ id: 's1', title: 'Add rate limiting', snippet: 'cover  the\\nX-Forwarded-For', updatedAt: 0 }]) },
    },
    navigate: (n: unknown) => opened.push(n),
  } as never;
  const items = await pastWork(ctx, 'forwarded', new AbortController().signal);
  expect(sent).toEqual([['runtime.search', { peer: 'p', q: 'forwarded', limit: 20 }]]);
  expect(items.map((i) => [i.id, i.label, i.group])).toEqual([['task:p:s1', 'Add rate limiting', 'shell.palette.group.tasks']]);
  expect(items[0]?.sub).toContain('X-Forwarded-For');
  items[0]?.run?.();
  expect(opened).toEqual([{ t: 'openTask', id: 'p:s1' }]);
  // a search overtaken by the next keystroke shows nothing
  const ctl = new AbortController();
  ctl.abort();
  expect(await pastWork(ctx, 'forwarded', ctl.signal)).toEqual([]);
});
