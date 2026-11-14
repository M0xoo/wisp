import { expect, test } from 'vitest';
import { applyPick, encodeMentions, itemsFor, menuAt } from '../src/frame/prompt-menu.ts';
import type { PromptSourceDef } from '../src/contract.ts';

test('a_prompt_box_opens_its_menu_where_the_caret_is_and_sends_picked_mentions_in_v1s_form', () => {
  expect(menuAt('/go', 3)).toEqual({ trigger: '/', start: 0, query: 'go' });
  expect(menuAt('/goal ship it', 13)).toBeNull(); // past the command
  expect(menuAt('ask @Fi', 7)).toEqual({ trigger: '@', start: 4, query: 'Fi' });
  expect(menuAt('mail a@b', 8)).toBeNull(); // an address, not a mention
  expect(menuAt('@', 1)).toEqual({ trigger: '@', start: 0, query: '' });
  const r = applyPick('ask @Fi please', { trigger: '@', start: 4, query: 'Fi' }, 7, { insert: '@Fix the bug ' });
  expect(r).toEqual({ text: 'ask @Fix the bug  please', caret: 17 });
  expect(
    encodeMentions('see @Fix the bug and @Ada', [
      { scheme: 'wisp', id: 'a1', title: 'Fix the bug' },
      { scheme: 'crew', id: 'ada', title: 'Ada' },
    ]),
  ).toBe('see @[Fix the bug](wisp:a1) and @[Ada](crew:ada)');
  expect(encodeMentions('nothing named', [{ scheme: 'wisp', id: 'a1', title: 'Gone' }])).toBe('nothing named');
  const src = (id: string, trigger: '@' | '/', where?: ('reply' | 'home')[]): PromptSourceDef => ({
    id,
    trigger,
    ...(where && { where }),
    items: (q) => [{ value: `${id}:${q}`, label: id, insert: id }],
  });
  const ctx = { client: {} as never };
  expect(itemsFor([src('a', '@'), src('b', '/'), src('c', '/', ['home'])], { trigger: '/', start: 0, query: 'x' }, 'reply', ctx).map((i) => i.value)).toEqual(['b:x']);
});

test('a pasted task id becomes the task s mention; anything else is pasted as text_v1_paste_task_id', async () => {
  const { pastedTasks, encodeMentions } = await import('../src/frame/prompt-menu.ts');
  const titles: Record<string, string> = { '0192f3a4-aaaa-7bbb': 'Fix login', 'local:s0002': 'Ship it' };
  const title = (id: string): string | undefined => titles[id];
  expect(pastedTasks('0192f3a4-aaaa-7bbb', title)).toEqual([{ scheme: 'wisp', id: '0192f3a4-aaaa-7bbb', title: 'Fix login' }]);
  // several, a wisp: id, a link; each once
  expect(pastedTasks('wisp:0192f3a4-aaaa-7bbb http://x/#/s/local:s0002 0192f3a4-aaaa-7bbb', title)?.map((m) => m.title)).toEqual(['Fix login', 'Ship it']);
  // one that isn't a task here, or words: the box takes the text
  expect(pastedTasks('0192f3a4-aaaa-7bbb nope123', title)).toBeNull();
  expect(pastedTasks('fix the login bug', title)).toBeNull();
  // sent, it's the stored form the agent reads (wisp_session)
  expect(encodeMentions('see @Fix login first', pastedTasks('0192f3a4-aaaa-7bbb', title) ?? [])).toBe('see @[Fix login](wisp:0192f3a4-aaaa-7bbb) first');
});
