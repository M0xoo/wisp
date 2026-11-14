// What a turn's refusals allow (frame/answer-of.ts blockedOf, v1 #777).
import { expect, test } from 'vitest';
import { blockedOf } from '../src/frame/answer-of.ts';

test('allow_and_retry_only_when_the_server_kept_refusals_a_full_auto_turn_says_why', () => {
  expect(blockedOf({ mode: 'edits', ext: { 'wisp.runtime': { blocked: [{ tool: 'Bash', detail: 'rm' }] } } })).toBe('allowable');
  // Full auto: the server keeps nothing (runtime-core `allowable`), whatever the agent's card lists
  expect(blockedOf({ mode: 'auto', ext: { 'wisp.runtime': { changes: [] } } })).toBe('unallowed');
  // a card from before, or an agent's own blocked card on a Plan turn: nothing to allow, no note
  expect(blockedOf({ mode: 'plan' })).toBe('none');
  expect(blockedOf(undefined)).toBe('none');
});
