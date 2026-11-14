// The first-run launcher (src/frame/first-run.ts, v1 launcher.js firstRun): prompt, mode, harness, Send; the rest behind More.
import { expect, test } from 'vitest';
import { firstRunOf, firstRunTools } from '../src/frame/first-run.ts';

const tool = (id: string) => ({ id, part: `launcher.${id}`, icon: 'clip' as const, label: id, title: id });

test('before your first task only the prompt, how it runs and Send show; More options opens the rest for good_v1_first_run', () => {
  expect(firstRunOf(false, false)).toBe(true);
  expect(firstRunOf(true, false)).toBe(false); // opened once: stays full
  expect(firstRunOf(false, true)).toBe(false); // a task of yours: full
  expect(firstRunOf(false, false, false)).toBe(false); // the saved answer isn't in yet: no flash for a returning user
  const more = tool('more');
  expect(firstRunTools(true, 'lead', [tool('attach'), tool('where')]).map((x) => x.id)).toEqual(['attach']);
  expect(firstRunTools(true, 'mid', [tool('team')])).toEqual([]);
  expect(firstRunTools(true, 'tail', [tool('goal'), tool('worktree'), tool('later')], more).map((x) => x.id)).toEqual(['more']);
  expect(firstRunTools(false, 'tail', [tool('goal'), tool('later')], more).map((x) => x.id)).toEqual(['goal', 'later']);
});
