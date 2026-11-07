// The conversation flow every channel shares (kit/conversation.ts): converse's start and thread
// paths against a recording phone, surface's open and shared places, Linking's codes and its
// guessing limits, Turns' per-key order, and same().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ActArgs, ChannelCtx, ChannelHub, Parsed, Phone, RunOpts, StartOpts } from '@wisp-plugin/channels-api';
import type { Conversation, Linkable } from '@wisp-plugin/channels-api/kit';
import { Linking, RateLimit, Turns, converse, firstPart, newLinkCode, same, surface } from '@wisp-plugin/channels-api/kit';

const project = { id: 'p1', name: 'api', path: '/code/api' };
const ctx: ChannelCtx = { projects: [project], machines: [{ id: 'm1', name: 'laptop', usable: true, agents: [] }], agents: [], adapters: [], crew: [{ id: 'adaaaa', name: 'Ada', agent: 'claude', cwd: '/code/api' }], goals: [], defaultProject: project, defaultAgent: 'claude', sandbox: false, tasks: [{ id: 's1', title: 'Fix login', state: 'running' }] };

interface Calls {
  started: { p: Parsed; o: StartOpts }[];
  ran: { id: string; p: Parsed; o: RunOpts }[];
  mentioned: { id: string; p: Parsed }[];
  acts: ActArgs[];
  counts: string[];
  said: string[];
}

function rig(over: Partial<Phone> = {}, conv: Partial<Conversation> = {}): { c: Conversation; calls: Calls } {
  const calls: Calls = { started: [], ran: [], mentioned: [], acts: [], counts: [], said: [] };
  const phone = {
    context: async () => ctx,
    count: (kind: string, detail = '') => void calls.counts.push(detail ? `${kind}:${detail}` : kind),
    threadCtx: async () => ({ agent: 'claude', machine: '' }),
    startParsed: async (p: Parsed, o: StartOpts) => (calls.started.push({ p, o }), { ack: `▶ ${p.prompt}` }),
    mention: async (id: string, p: Parsed) => (calls.mentioned.push({ id, p }), { ack: `▶ ${p.crew?.name} has it` }),
    run: async (id: string, p: Parsed, o: RunOpts) => (calls.ran.push({ id, p, o }), '✓ Sent'),
    stop: async () => '■ Stopped.',
    status: async () => 'Working: Fix login',
    ...over,
  } as unknown as Phone;
  const say = async (t: string): Promise<number> => (calls.said.push(t), calls.said.length);
  const s = surface({ ctx, post: say, open: true, typed: '', noList: 'Lists are in wisp.' });
  const c: Conversation = {
    phone,
    hub: { act: async (a: ActArgs) => (calls.acts.push(a), '✓ Marked done') },
    ctx,
    channel: 'test',
    name: 'Test',
    sender: 'Ada',
    cap: 'auto',
    approvals: true,
    ...s,
    thread: () => ({ channel: 'test', ref: 'r1' }),
    noThread: 'That only works in a task’s thread.',
    ...conv,
  };
  return { c, calls };
}

test('converse: a task starts with its options, and the ack is said', async () => {
  const { c, calls } = rig();
  await converse(c, 'in api plan: fix it');
  assert.equal(calls.started.length, 1);
  assert.equal(calls.started[0]?.p.project?.name, 'api');
  assert.equal(calls.started[0]?.p.mode, 'plan');
  assert.deepEqual(calls.started[0]?.o.thread, { channel: 'test', ref: 'r1' });
  assert.deepEqual(calls.said, ['▶ fix it']);
});

test('converse: lists, refusals, the cap and an empty prompt answer without starting anything', async () => {
  const { c, calls } = rig({}, { cap: 'edits' });
  await converse(c, 'status');
  await converse(c, 'on nowhere: fix it');
  await converse(c, 'full auto: fix it');
  await converse(c, 'plan:');
  await converse(c, 'stop');
  assert.equal(calls.started.length, 0);
  assert.match(calls.said[0] ?? '', /Running:\n• Fix login/);
  assert.match(calls.said[1] ?? '', /No machine “nowhere”[\s\S]*Nothing started/);
  assert.match(calls.said[2] ?? '', /Full auto isn’t allowed from here[\s\S]*Nothing started\.$/);
  assert.equal(calls.said[3], 'What should it do? Say it after the options.');
  assert.equal(calls.said[4], 'That only works in a task’s thread.');
  assert.deepEqual(calls.counts, ['list:status', 'refused:no-match', 'refused:mode', 'list:stop']);
});

test('converse: a start that fails says so, and a first reply that fails is owed', async () => {
  const { c, calls } = rig({ startParsed: async () => Promise.reject(new Error('no such folder')) });
  await converse(c, 'fix it');
  assert.equal(calls.said[0], 'Couldn’t start it: no such folder');
  let owed: (() => Promise<unknown>) | null = null;
  const failing = rig({}, { say: async () => Promise.reject(new Error('down')), owe: (send) => (err) => ((owed = send), Promise.reject(err)) as never });
  await assert.rejects(converse(failing.c, 'fix it'), /down/);
  assert.ok(owed, 'the ack is kept for later');
});

test('converse in a thread: stop, status, done, a follow-up, @crew, /btw', async () => {
  const { c, calls } = rig();
  await converse(c, 'stop', 's1');
  await converse(c, 'status', 's1');
  await converse(c, 'done', 's1');
  await converse(c, 'with sonnet carry on', 's1');
  await converse(c, '@ada look at this', 's1');
  await converse(c, '/btw what changed?', 's1');
  await converse(c, '/btw', 's1');
  assert.deepEqual(calls.said.slice(0, 3), ['■ Stopped.', 'Working: Fix login', '✓ Marked done']);
  assert.deepEqual(calls.acts, [{ sessionId: 's1', kind: 'done', ref: '', index: 0 }]);
  assert.equal(calls.ran[0]?.p.prompt, 'with sonnet carry on'); // no harness here knows sonnet: words for the agent
  assert.equal(calls.mentioned[0]?.p.crew?.name, 'Ada');
  assert.equal(calls.ran[1]?.o.btw, true);
  assert.equal(calls.said.at(-1), 'Type your question after /btw.');
});

test('converse in a thread: a refused follow-up undoes what beforeRun did, a failed one says so', async () => {
  let undone = 0;
  const refused = rig({ run: async () => 'That session is gone.' }, { beforeRun: () => () => void undone++ });
  await converse(refused.c, 'carry on', 's1');
  assert.equal(undone, 1);
  const failed = rig({ run: async () => Promise.reject(new Error('offline')) }, { beforeRun: () => () => void undone++ });
  await converse(failed.c, 'carry on', 's1');
  assert.equal(undone, 2);
  assert.equal(failed.calls.said[0], 'Couldn’t send that: offline');
  const sent = rig({}, { beforeRun: () => () => void undone++, runLine: (l) => `${l}!` });
  await converse(sent.c, 'carry on', 's1');
  assert.equal(undone, 2);
  assert.equal(sent.calls.said[0], '✓ Sent!');
});

test('surface: where others read, lists are one line, refusals have no choices, names you didn’t write go', async () => {
  const said: string[] = [];
  const post = async (t: string): Promise<void> => void said.push(t);
  const s = surface({ ctx, post, open: false, typed: 'fix it', noList: 'Lists are in wisp.' });
  const p = (command: string): Parsed => ({ command, arg: '', crew: null, tagged: [], project: null, machine: null, agent: null, model: null, effort: null, mode: null, prompt: '', problems: [], notes: [] });
  await s.list(p('projects'), ctx);
  await s.list(p('status'), ctx);
  await s.list(p('help'), ctx);
  await s.refuse([{ kind: 'no-match', text: 'No machine “x”.', choices: ['laptop'] }]);
  await s.say('▶ api · Opus · on laptop');
  assert.equal(said[0], 'Lists are in wisp.');
  assert.equal(said[1], '1 running, 0 waiting: see them in wisp.');
  assert.match(said[2] ?? '', /Try: plan: fix the flaky test$/);
  assert.doesNotMatch(said[3] ?? '', /Choices/);
  assert.equal(said[4], '▶ Opus');
});

type Rig = Linkable & { saves: number; changes: number; n: number };
function linkable(): Rig {
  const ch: Rig = {
    name: 'slack',
    cfg: { linkCode: '123456' } as Linkable['cfg'],
    saves: 0,
    changes: 0,
    n: 0,
    hub: {
      save: () => void ch.saves++,
      onChange: () => void ch.changes++,
      phone: { count: () => {} } as unknown as Phone,
      hash: (s: string) => `h${s.length}${s}`.padEnd(16, '0'),
      randomInt: () => 654321 + ch.n++,
      clock: { now: () => Date.UTC(2026, 10, 7) },
    },
  };
  return ch;
}

test('Linking: the right code links one person and changes; wrong codes change it after five', () => {
  const ch = linkable();
  const link = new Linking(ch, { limit: () => new RateLimit({ max: 1000 }), where: 'Settings → Slack', done: 'Linked.' });
  const say = (t: string): string => t;
  assert.equal(link.attempt('U1', '123456', say), 'Linked.');
  assert.deepEqual(ch.cfg.senders, ['U1']);
  assert.equal(ch.cfg.linkCode, '654321', 'one person, one code');
  assert.equal(link.attempt('U1', 'x', say), 'You’re already linked.');
  for (let i = 0; i < 4; i++) assert.equal(link.attempt(`S${i}`, '000000', say), 'That isn’t the code. wisp shows it in Settings → Slack.');
  assert.equal(ch.cfg.linkCode, '654321');
  link.attempt('S9', '000000', say);
  assert.equal(ch.cfg.linkCode, '654322', 'five wrong codes: a new one');
  assert.equal(ch.cfg.linkGuess?.wrong, 0);
  assert.equal(ch.cfg.linkGuess?.spent, 5);
});

test('Linking: one sender gets five guesses a day, and then not even the right code works', () => {
  const ch = linkable();
  const link = new Linking(ch, { limit: () => new RateLimit({ max: 1000 }), where: 'wisp', done: 'Linked.' });
  for (let i = 0; i < 5; i++) link.attempt('S', `bad${i}`, (t) => t);
  assert.equal(link.attempt('S', ch.cfg.linkCode, (t) => t), undefined, 'silence, else guessing goes on');
  assert.equal(link.attempt('T', ch.cfg.linkCode, (t) => t), 'Linked.', 'someone else still can');
});

test('Linking: the rate limit is silence', () => {
  const ch = linkable();
  const limit = new RateLimit({ max: 1 });
  const link = new Linking(ch, { limit: () => limit, where: 'wisp', done: 'Linked.' });
  assert.ok(link.attempt('S', 'bad', (t) => t));
  assert.equal(link.attempt('S', '123456', (t) => t), undefined);
});

test('Turns: one at a time per key, side by side across keys; settled waits for the answer', async () => {
  const turns = new Turns();
  const order: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const a1 = turns.queue('a', async () => (await gate, order.push('a1')), () => {});
  const a2 = turns.queue('a', () => void order.push('a2'), () => {});
  const b1 = turns.queue('b', () => void order.push('b1'), () => {});
  await b1;
  assert.deepEqual(order, ['b1']);
  release();
  await Promise.all([a1, a2]);
  assert.deepEqual(order, ['b1', 'a1', 'a2']);
  assert.equal(turns.chains.size, 0);
  const errors: unknown[] = [];
  await turns.queue('c', () => Promise.reject(new Error('x')), (e) => errors.push(e));
  assert.equal(errors.length, 1);
  const held = turns.hold('k', Promise.resolve(5));
  assert.ok(turns.settled('k'));
  assert.equal(await held, 5);
  assert.equal(turns.settled('k'), undefined);
});

test('same, firstPart, newLinkCode', () => {
  assert.equal(same('123456', '123456'), true);
  assert.equal(same('123456', '123457'), false);
  assert.equal(same('1234', '12345'), false);
  assert.equal(same('é', 'é'), true);
  assert.equal(firstPart('Couldn’t start it: no such folder'), 'Couldn’t start it.');
  assert.equal(newLinkCode({ randomInt: (min: number) => min } as Pick<ChannelHub, 'randomInt'>), '100000');
});
