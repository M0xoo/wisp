// The PR pane on the real client and the mock peer, with wisp.ship's answer stubbed (the mock peer has no ship).
import { expect, test } from 'vitest';
import type { CommandDef } from '@wisp/client';
import { PrPane } from '../src/side/PrPane.tsx';
import { useTask } from '../src/task-context.tsx';
import { mountTask, part, settle } from './helpers.tsx';
import type { PrPanel } from '../src/side/pr.ts';

const PR: PrPanel = {
  repo: 'o/r',
  number: 42,
  url: 'https://github.com/o/r/pull/42',
  title: 'Fix add in math.js',
  state: 'OPEN',
  branch: 'wisp/fix-add',
  base: 'main',
  author: 'wisp-bot',
  checks: { fail: 1, pending: 0, pass: 2 },
  checkList: [
    { name: 'lint', state: 'pass', ms: 12_000 },
    { name: 'test (node 22)', state: 'fail', ms: 72_000, url: 'https://ci/1' },
    { name: 'build', state: 'pass', ms: 30_000 },
  ],
  reviewers: [{ author: 'lena', state: 'APPROVED' }],
  notes: [
    { author: 'lena', body: 'Looks right; add a test for negatives?', at: 1 },
    { author: 'ci-bot', bot: true, body: 'Coverage 91%' },
  ],
  threads: [{ path: 'math.js', line: 2, notes: [{ author: 'lena', body: 'nit: spacing' }] }],
  additions: 3,
  deletions: 1,
  changedFiles: 1,
  files: [{ path: 'math.js', additions: 3, deletions: 1 }],
};

test('the_pr_pane_shows_the_verdict_failing_checks_first_the_passed_folded_and_the_conversation', async () => {
  const asked: string[] = [];
  const m = await mountTask({ sessionId: 's1', rows: {} }, () => {
    const task = useTask();
    // the task's row carries its PR (wisp.ship's `pr`): only then does the pane ask
    (task as { task: unknown }).task = () => ({ id: 's1', pr: { number: 42 } });
    // the pane's reads and writes go to wisp.ship: answer them here
    (task.client as { run: unknown }).run = (cmd: CommandDef<unknown, unknown>, args: unknown) => {
      asked.push(`${cmd.id} ${JSON.stringify(args)}`);
      return Promise.resolve(cmd.id === 'ship.details' ? [PR] : null);
    };
    return <PrPane />;
  });
  await settle();
  expect(asked[0]).toBe(`ship.details {"key":"${m.key}","session":"s1"}`);
  expect(part('side.pr.verdict.fail')?.textContent).toContain('1 check failing');
  // the failing check is listed; the two that passed fold behind one line
  const rows = [...document.querySelectorAll('[data-kit="check-row"]')].map((r) => r.getAttribute('data-state'));
  expect(rows).toEqual(['fail']);
  const fold = part('side.pr.fold');
  expect(fold?.textContent).toBe('2 passed');
  fold?.click();
  await settle();
  expect([...document.querySelectorAll('[data-kit="check-row"]')].length).toBe(3);
  // reviewers, the conversation (the bot folded), the files, the foot
  expect(part('side.pr.reviews')?.textContent).toContain('Approved');
  expect(part('side.pr.talk')?.textContent).toContain('math.js:2');
  expect(part('side.pr.talk')?.textContent).not.toContain('Coverage 91%');
  expect(part('side.pr.talk')?.textContent).toContain('1 from bots');
  expect(part('side.pr.files')?.textContent).toContain('+3 −1');
  expect(part('side.pr.meta')?.textContent).toBe('#42 · Open · wisp/fix-add → main · by wisp-bot');
});
