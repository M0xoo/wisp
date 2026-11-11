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
  expect(encodeMentions('see @Fix the bug and @Ada', [{ scheme: 'wisp', id: 'a1', title: 'Fix the bug' }, { scheme: 'crew', id: 'ada', title: 'Ada' }])).toBe('see @[Fix the bug](wisp:a1) and @[Ada](crew:ada)');
  expect(encodeMentions('nothing named', [{ scheme: 'wisp', id: 'a1', title: 'Gone' }])).toBe('nothing named');
  const src = (id: string, trigger: '@' | '/', where?: ('reply' | 'home')[]): PromptSourceDef => ({ id, trigger, ...(where && { where }), items: (q) => [{ value: `${id}:${q}`, label: id, insert: id }] });
  const ctx = { client: {} as never };
  expect(itemsFor([src('a', '@'), src('b', '/'), src('c', '/', ['home'])], { trigger: '/', start: 0, query: 'x' }, 'reply', ctx).map((i) => i.value)).toEqual(['b:x']);
});
