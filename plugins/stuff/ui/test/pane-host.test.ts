// A pinned pane's calls (panes/host.ts, v1 panes.js paneCall): checked against what you allowed, writes held to six a
// minute, asked of the server first and sent only after your click on the card.
import { expect, test } from 'vitest';
import { paneHost, type PaneCard, type PaneHostDeps } from '../src/panes/host.ts';
import type { Grant, Item, TaskRow } from '../src/types.ts';
import en from '../src/i18n/en.json' with { type: 'json' };

const cat = en as Record<string, string>;
const t = (k: string, v?: Readonly<Record<string, string | number>>): string => (cat[k] ?? k).replace(/\{(\w+)\}/g, (_, w: string) => String(v?.[w] ?? ''));

const app = (allowed: string[], changed = false): Item => ({ id: 'a1', kind: 'app', name: 'board', title: 'Board', size: 0, at: 0, by: 'you', allowed, changed }) as Item;
const tasks: TaskRow[] = [
  { id: 't1', title: 'Fix login with sk-ant-abcdefghijklmnopqrstuvwxyz', state: 'review', agent: 'claude' },
  { id: 't2', title: 'Sending…', state: 'running', agent: 'claude', pending: true } as TaskRow,
];

function deps(o: { allowed: string[]; changed?: boolean; grant?: Grant; answer?: boolean; pinned?: boolean; mode?: string }): PaneHostDeps & { cards: PaneCard[]; sent: string[] } {
  const cards: PaneCard[] = [];
  const sent: string[] = [];
  let now = 1_000_000;
  return {
    cards,
    sent,
    item: () => app(o.allowed, o.changed),
    pinned: () => o.pinned ?? true,
    grant: () => Promise.resolve(o.grant ?? { allowed: o.allowed, changed: false }),
    card: (c) => (cards.push(c), Promise.resolve(o.answer ?? true)),
    tasks: () => tasks,
    crew: () => [{ id: 'ada', name: 'Ada', role: 'Reviewer', busy: true }],
    usage: () => Promise.resolve([]),
    project: (n) => (n === 'web' ? { name: 'web', path: '/w/web' } : undefined),
    defaults: () => Promise.resolve({ agent: 'claude', mode: o.mode ?? 'auto' }),
    told: (text) => sent.push(`told:${text}`),
    harnessName: (a) => (a === 'claude' ? 'Claude Code' : (a ?? '')),
    launch: (b) => (sent.push(`launch:${String(b['prompt'])}:${String(b['cwd'] ?? 'scratch')}:${String(b['mode'])}`), Promise.resolve({ id: 't9', title: 'New', state: 'running', agent: 'claude' })),
    followUp: (id, text) => (sent.push(`follow:${id}:${text}`), Promise.resolve()),
    done: (id) => (sent.push(`done:${id}`), Promise.resolve()),
    watch: () => sent.push('watch'),
    now: () => (now += 1000),
    t,
  };
}

test('a pane reads what you allowed it, light and scrubbed, and nothing else_v1_pane_call', async () => {
  const d = deps({ allowed: ['tasks:read', 'crew:read'] });
  const h = paneHost(d);
  const list = (await h.call('tasks.list', [])) as Record<string, unknown>[];
  expect(list.map((x) => x['id'])).toEqual(['t1']); // a task still sending isn't listed
  expect(String(list[0]?.['title'])).toContain('[redacted');
  expect(list[0]?.['harness']).toBe('Claude Code');
  expect(await h.call('crew.list', [])).toEqual([{ id: 'ada', name: 'Ada', role: 'Reviewer', busy: true, nextAt: null }]);
  await expect(h.call('prs.list', [])).rejects.toThrow('needs "prs:read"');
  await expect(h.call('tasks.get', ['nope'])).rejects.toThrow('No task nope.');
  await expect(h.call('fs.read', [])).rejects.toThrow('wisp has no fs.read()');
  expect(await h.call('tasks.watch', [])).toBe(true);
  expect(d.sent).toEqual(['watch']);
});

test('a pane write goes only after your click, on your defaults, six a minute, and not once the app changed_v1_pane_write', async () => {
  const d = deps({ allowed: ['tasks:read', 'tasks:write'] });
  const h = paneHost(d);
  const out = (await h.call('tasks.launch', [{ prompt: 'Add a test', project: 'web' }])) as Record<string, unknown>;
  expect(out['id']).toBe('t9');
  expect(d.cards[0]?.head).toBe('Board wants to start a task');
  // v1's card: the project, the harness and the mode it will run on, Full auto spelled out and flagged
  expect(d.cards[0]?.rows).toEqual([
    ['Project', 'web'],
    ['Harness', 'Claude Code'],
    ['Mode', 'Full auto: no permission prompts', true],
  ]);
  // your saved defaults, as v1 (its default mode is Full auto), then v1's toast
  expect(d.sent).toEqual(['launch:Add a test:/w/web:auto', 'told:Board started New']);
  const plan = deps({ allowed: ['tasks:write'], mode: 'plan' });
  await paneHost(plan).call('tasks.launch', ['Look around']);
  expect(plan.cards[0]?.rows[2]).toEqual(['Mode', 'Plan', false]);
  expect(plan.sent[0]).toBe('launch:Look around:scratch:plan');
  // a follow-up's card: the task, its harness, its mode and its state (v1)
  await h.call('tasks.followUp', ['t1', 'go on']);
  expect(d.cards[1]?.rows).toEqual([
    ['Task', 'Fix login with sk-ant-abcdefghijklmnopqrstuvwxyz'],
    ['Harness', 'Claude Code'],
    ['Mode', 'Full auto: no permission prompts', true],
    ['State', 'Review'],
  ]);
  await expect(h.call('tasks.launch', [{ prompt: 'x', project: 'nope' }])).rejects.toThrow('No project nope.');
  await expect(h.call('tasks.launch', [{}])).rejects.toThrow('needs a prompt');

  // Cancel on the card: nothing goes
  const no = deps({ allowed: ['tasks:write', 'tasks:read'], answer: false });
  await expect(paneHost(no).call('tasks.followUp', ['t1', 'go on'])).rejects.toThrow('You didn’t send it.');
  expect(no.sent).toEqual([]);
  // unpinned while the card was up: nothing goes
  const gone = deps({ allowed: ['tasks:write', 'tasks:read'], pinned: false });
  await expect(paneHost(gone).call('tasks.done', ['t1'])).resolves.toBe(true); // done needs no card
  await expect(paneHost(gone).call('tasks.followUp', ['t1', 'go on'])).rejects.toThrow('isn’t pinned any more');
  // the app's code changed since you allowed it: the server says so, nothing goes
  const changed = deps({ allowed: ['tasks:write'], changed: true, grant: { allowed: ['tasks:read'], changed: true } });
  await expect(paneHost(changed).call('tasks.done', ['t1'])).rejects.toThrow('allow it again');
  // six writes a minute, whatever became of them
  const busy = deps({ allowed: ['tasks:write', 'tasks:read'] });
  const hb = paneHost(busy);
  for (let i = 0; i < 6; i++) await hb.call('tasks.done', ['t1']);
  await expect(hb.call('tasks.done', ['t1'])).rejects.toThrow('Slow down');
});

test('a pane reads the runtime rows as tasks: bare ids, the project holding the folder, no subagents_v1_light_task', async () => {
  const { taskOfRow } = await import('../src/panes/rows.ts');
  const project = (cwd: string): string | undefined => (cwd.startsWith('/w/web') ? 'web' : undefined);
  const row = { id: 'local:s1', title: 'Fix', state: 'running', agent: 'claude', summary: { cwd: '/w/web/src', status: 'running', live: 'Reading', branch: 'fix' }, body: { ext: { 'wisp.crew': { id: 'ada', name: 'Ada' } } } };
  expect(taskOfRow(row, project)).toMatchObject({ id: 's1', project: 'web', status: 'running', live: 'Reading', branch: 'fix', crew: { id: 'ada', name: 'Ada' } });
  expect(taskOfRow({ ...row, parent_id: 'local:s0' }, project)).toBeUndefined();
  expect(taskOfRow({ ...row, body: { ext: { 'wisp.stuff': { kind: 'pane' } } } }, project)?.kind).toBe('pane');
});

test('a task a pane starts goes out as the host built it, on your saved defaults_v1_launch_defaults', async () => {
  const { launchTask } = await import('../src/commands.ts');
  const wire = (launchTask as unknown as { wire: (a: unknown) => Record<string, unknown> }).wire;
  const body = { prompt: 'x', mode: 'auto', agent: 'claude' };
  expect(wire({ peer: 'local', body })).toEqual(body); // nothing added, nothing taken away
});

test('a pane starts tasks on what New task would: the default profile, else the first harness and Full auto_v1_launch_defaults', async () => {
  const { defaultsFrom } = await import('../src/panes/grant.ts');
  const saved = [{ name: 'reviewer', spec: { harness: 'codex', mode: 'plan' } }, { name: 'default', spec: { harness: 'codex', mode: 'edits', model: 'gpt-5.5', effort: '' } }];
  expect(defaultsFrom(saved, true, 'claude')).toEqual({ agent: 'codex', mode: 'edits', model: 'gpt-5.5' });
  expect(defaultsFrom([], undefined, 'claude')).toEqual({ agent: 'claude', mode: 'auto' });
  expect(defaultsFrom(undefined, false, undefined)).toEqual({ mode: 'auto', worktree: 'off' });
});
