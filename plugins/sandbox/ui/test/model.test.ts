// ADR-0047: `/sandbox …` in New task, and a sandbox's owner said in words.
import { expect, test } from 'vitest';
import { ownerTask, ownerWords, sandboxPrompt } from '../src/model.ts';

const say = (k: string, v?: Readonly<Record<string, string | number>>): string => (v ? `${k}(${Object.values(v).join(',')})` : k);

test('a_sandbox_prompt_is_read_off_new_task_and_its_owner_is_said_in_words', () => {
  expect(sandboxPrompt('/sandbox fix the login')).toBe('fix the login');
  expect(sandboxPrompt('  /Sandbox\ntwo lines\nhere')).toBe('two lines\nhere');
  expect(sandboxPrompt('/sandbox')).toBe('');
  expect(sandboxPrompt('fix the login')).toBeNull();
  expect(sandboxPrompt('/sandboxes')).toBeNull();
  expect(ownerWords({ task: 'p:t1' }, say)).toBe('sandbox.owner.task');
  expect(ownerWords({ lead: 't1', member: 'codex' }, say)).toBe('sandbox.owner.delegate(codex)');
  expect(ownerWords({ crew: 'ada', job: 'm|t' }, say, () => 'Ada')).toBe('sandbox.owner.job(Ada)');
  expect(ownerWords({ crew: 'ada' }, say, () => 'Ada')).toBe('sandbox.owner.member(Ada)');
  expect(ownerWords({ judges: 't1' }, say)).toBe('sandbox.owner.judges');
  expect(ownerWords(null, say)).toBe('sandbox.owner.none');
  expect([ownerTask({ task: 'p:t1' }), ownerTask({ crew: 'x' })]).toEqual(['p:t1', undefined]);
});
