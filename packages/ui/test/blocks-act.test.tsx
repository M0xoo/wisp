// The blocks that act (v1 blocks.js R.next, R.question, R.blocked, R.actions, R.terminal, R.tests, R.task, R.compare):
// each does what v1 did through the host's BlockContext, and a host without that action shows no dead control.
import { expect, test } from 'vitest';
import { mount, part } from './helpers.tsx';
import { Answer, type BlockContext, type RunResult } from '../src/index.ts';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const click = (el: Element | null | undefined, o: MouseEventInit = {}): void => void el?.dispatchEvent(new MouseEvent('click', { bubbles: true, ...o }));

test('answer_blocks_that_act_draft_reply_run_and_allow_through_the_host_as_v1_did', async () => {
  const said: string[] = [];
  const ran: string[] = [];
  let refuse = true;
  const ctx: BlockContext = {
    latest: true,
    reply: (t) => void said.push(`reply:${t}`),
    draft: (t) => void said.push(`draft:${t}`),
    run: (c) => {
      ran.push(c);
      return Promise.resolve<RunResult>({ exitCode: c === 'npm run lint' ? 1 : 0, output: `ran ${c}\n` });
    },
    allow: () => {
      said.push('allow');
      return refuse ? Promise.reject(new Error('no')) : Promise.resolve();
    },
    deny: () => void said.push('deny'),
    openTask: (id) => void said.push(`open:${id}`),
    task: (id) => () => (id === 't1' ? { id, title: 'Fix the flaky test', state: 'running', agent: 'claude' } : undefined),
  };
  mount(() => (
    <Answer
      ctx={ctx}
      blocks={[
        { type: 'next', items: ['Add tests', { label: 'Ship it', reply: 'commit and open a PR' }] },
        { type: 'question', question: 'Which **db**?', options: ['Postgres', { label: 'SQLite', detail: 'one file' }] },
        { type: 'blocked', items: [{ tool: 'Bash', detail: 'rm -rf build', why: 'outside the folder' }] },
        { type: 'actions', title: 'Try it', items: [{ label: 'Lint', command: 'npm run lint' }, { label: 'Ask', reply: 'explain it' }, { label: 'Deploy', command: './deploy', confirm: true }] },
        { type: 'terminal', command: 'ls', output: '\u001b[32ma.txt\u001b[0m\n', exitCode: 0 },
        { type: 'tests', passed: 40, failed: 2, skipped: 1, command: 'npm test', failures: [{ name: 'adds', message: 'expected 3', file: 'math.test.js:4' }] },
        { type: 'task', id: 't1' },
        { type: 'task', id: 'gone', title: 'Old one' },
        { type: 'compare', before: { items: ['slow'] }, after: { label: 'Now', items: ['fast'] } },
      ]}
    />
  ));
  // next: a click drafts, ⌘-click sends; an item's own reply wins
  const chips = document.querySelectorAll('[data-part="block.next.chip"]');
  click(chips[0]);
  click(chips[1], { metaKey: true });
  // question: numbered options, the option's text sent
  const opts = document.querySelectorAll('[data-part="block.question.option"]');
  expect(opts[0]?.textContent).toBe('1Postgres');
  click(opts[1]);
  expect(said).toEqual(['draft:Add tests', 'reply:commit and open a PR', 'reply:SQLite']);

  // blocked: Allow settles at once, and a refusal puts the buttons back
  const blocked = part('block.blocked');
  expect(blocked?.textContent).toContain('rm -rf build');
  click([...(blocked?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.includes('Allow')));
  expect(blocked?.hasAttribute('data-resolved')).toBe(true);
  await tick();
  expect(blocked?.hasAttribute('data-resolved')).toBe(false);
  refuse = false;

  // actions: Run shows the exit code and output, a failure offers Send failure to agent; a reply step says Sent;
  // a confirm step asks first, in place
  const acts = document.querySelectorAll('[data-part="block.actions.item"]');
  click(acts[0]?.querySelector('[data-part="block.actions.go"]'));
  await tick();
  expect(acts[0]?.textContent).toContain('exit 1');
  expect(acts[0]?.textContent).toContain('ran npm run lint');
  click([...(acts[0]?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Send failure to agent'));
  expect(said.at(-1)).toContain('reply:Command `npm run lint` failed (exit 1)');
  click(acts[1]?.querySelector('[data-part="block.actions.go"]'));
  expect(acts[1]?.textContent).toContain('Sent');
  click(acts[2]?.querySelector('[data-part="block.actions.go"]'));
  expect(ran).toEqual(['npm run lint']);
  expect(acts[2]?.textContent).toContain('Run command');
  click(acts[2]?.querySelector('[data-part="block.actions.go"]'));
  expect(ran).toEqual(['npm run lint', './deploy']);

  // terminal: colour codes gone, the exit code, Run
  const term = part('block.terminal');
  expect(term?.textContent).toContain('$ ls');
  expect(term?.textContent).toContain('a.txt');
  expect(term?.textContent).not.toContain('[32m');
  expect(term?.textContent).toContain('exit 0');

  // tests: the verdict, the counts, the failure with its file
  const tests = part('block.tests');
  expect(tests?.textContent).toContain('2 failing');
  expect(tests?.textContent).toContain('math.test.js:4');

  // task: live title and state, Open; one this computer doesn't have is inert
  const tasks = document.querySelectorAll('[data-part="block.task"]');
  expect(tasks[0]?.textContent).toContain('Fix the flaky test');
  expect(tasks[0]?.textContent).toContain('Working');
  click(tasks[0]);
  expect(said.at(-1)).toBe('open:t1');
  expect(tasks[1]?.hasAttribute('disabled')).toBe(true);
  expect(tasks[1]?.textContent).toContain('Deleted, or on another computer');

  // compare: both sides with their labels
  expect(part('block.compare')?.textContent).toContain('Before');
  expect(part('block.compare')?.textContent).toContain('Now');
});

test('an_earlier_answers_question_reads_agent_asked_and_a_host_without_actions_shows_no_dead_buttons', () => {
  mount(() => <Answer ctx={{ latest: false, reply: () => {} }} blocks={[{ type: 'question', question: 'Which?', options: ['A'] }, { type: 'blocked', items: [{ tool: 'Bash', detail: 'x' }] }, { type: 'actions', items: [{ label: 'Lint', command: 'npm run lint' }] }]} />);
  expect(part('block.question')?.textContent).toContain('Agent asked');
  expect(part('block.question')?.hasAttribute('data-answered')).toBe(true);
  expect(document.querySelector<HTMLButtonElement>('[data-part="block.question.option"]')?.disabled).toBe(true);
  expect(part('block.blocked')?.textContent).not.toContain('Allow');
  expect(part('block.actions.go')).toBeNull();
});
