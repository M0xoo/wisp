// Try it two ways: one task, twice, on one harness, changing one setting. The run keeps its variant
// (subagentModel, skills: 'off'), the group keeps what differed (session.trial), and Compare says it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeBins, makeRepo, records, same, tmp, until } from './helpers.js';

process.env.WISP_HOME = tmp('trytwo-wisp');
process.env.WISP_UPDATE_CHECK = '0';
process.env.CLAUDE_CONFIG_DIR = tmp('trytwo-claude-home'); // never this computer's ~/.claude
for (const k of ['CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE']) delete process.env[k];
const RECORD = tmp('trytwo-record');
process.env.FAKE_RECORD = RECORD;
installFakeBins();
const { startServer } = await import('../server/index.js');
const { adapters } = await import('../server/adapters/index.js');
const { Guard } = await import('../server/guard.js');
const { holdFor } = await import('../web/js/limit-hold.js');
const { differsWords, variantWords } = await import('../web/js/compare-metrics.js');
const { WispClient, tryProblem, tryRuns } = await import('../server/client.js');

const FLAG = '--disable-slash-commands';
let srv;
let base;
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
async function call(p, body, method) {
  const r = await fetch(`${base}/api${p}`, { method: method || (body ? 'POST' : 'GET'), headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
}
async function api(p, body, method) {
  const r = await call(p, body, method);
  if (r.status >= 400) throw Object.assign(new Error(`${p}: ${r.body.error}`), { status: r.status });
  return r.body;
}
const ended = (id) => until(async () => {
  const x = await api(`/sessions/${id}`);
  return x.state !== 'running' && x.turns.at(-1)?.status !== 'running' && x;
}, { timeout: 30_000 });
// Every claude run whose prompt has this word, oldest first.
const runsOf = (word) => records(RECORD, 'claude').filter((r) => r.stdin.includes(word));
const runIn = (word, s) => runsOf(word).find((r) => same(r.cwd, s.worktree.path));
const flags = (r) => r.argv.filter((a) => a === FLAG).length;
const launchTwo = async (word, entry, top = {}) => {
  const out = await api('/sessions', { prompt: `change the add function ${word}`, cwd: makeRepo(), agent: 'claude', model: 'claude-opus-5-5', effort: 'high', compare: [{ agent: 'claude', model: 'claude-opus-5-5', effort: 'high', ...entry }], trial: true, ...top });
  const [a, b] = await Promise.all(out.group.map((x) => ended(x.id)));
  return [a, b];
};
const refused = async (body, pattern, what) => {
  const r = await call('/sessions', { prompt: 'try it', cwd: makeRepo(), agent: 'claude', ...body });
  assert.equal(r.status, 400, what);
  assert.match(r.body.error, pattern, what);
};

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  srv = await startServer({ port, handleSignals: false });
  srv.later.stop();
});
after(() => {
  srv.shutdown();
  srv.server.closeAllConnections?.();
  srv.server.close();
});

test('subagents: the variant reaches run B only, stays for its follow-up, and shows in the summary', async () => {
  const [a, b] = await launchTwo('onlyb', { subagentModel: 'haiku' });
  assert.equal(runIn('onlyb', a).subagentModel, undefined);
  assert.equal(runIn('onlyb', b).subagentModel, 'haiku');
  assert.equal(runIn('onlyb', b).workflowSubagentModel, 'haiku');
  assert.equal(a.subagentModel, undefined);
  assert.equal(b.subagentModel, 'haiku');
  assert.equal(b.turns[0].run?.subagentModel, 'haiku');
  const list = await api('/sessions');
  assert.equal(list.find((x) => x.id === b.id).subagentModel, 'haiku', 'the page reads it from the summary');
  assert.ok(!('subagentModel' in list.find((x) => x.id === a.id)), 'only when set');

  await api(`/sessions/${b.id}/reply`, { text: 'and now the follow-up onlybnext' });
  const after = await ended(b.id);
  assert.equal(runsOf('onlybnext')[0].subagentModel, 'haiku');
  assert.equal(after.turns.at(-1).run?.subagentModel, 'haiku');
});

test('subagents: the session beats defaults.subagentModel both ways, an explicit \'\' included', async () => {
  const cwd = makeRepo();
  const go = (word, extra) => api('/sessions', { prompt: `task ${word}`, cwd, agent: 'claude', worktree: false, ...extra }).then((s) => ended(s.id));
  const sonnet = await go('sessonnet', { subagentModel: 'sonnet' });
  assert.equal(runsOf('sessonnet')[0].subagentModel, 'sonnet', 'the setting unset, the session sets it');
  assert.equal(sonnet.turns[0].run?.subagentModel, 'sonnet');
  await api('/config', { defaults: { subagentModel: 'haiku' } }, 'PATCH');
  try {
    const own = await go('sesexplicit', { subagentModel: '' });
    assert.equal(runsOf('sesexplicit')[0].subagentModel, undefined, 'the task’s model, whatever the setting says');
    assert.equal(own.subagentModel, '');
    assert.equal(own.turns[0].run?.subagentModel, undefined);
    await go('sesdefault', {});
    assert.equal(runsOf('sesdefault')[0].subagentModel, 'haiku', 'not set: the setting');
    await api(`/sessions/${own.id}/reply`, { text: 'carry on sesexplicitnext' });
    await ended(own.id);
    assert.equal(runsOf('sesexplicitnext')[0].subagentModel, undefined, 'a follow-up keeps it');
    const list = await api('/sessions');
    assert.equal(list.find((x) => x.id === own.id).subagentModel, '', 'an explicit \'\' is set: Rerun keeps it');
  } finally {
    await api('/config', { defaults: { subagentModel: '' } }, 'PATCH');
  }
});

test('skills off: the flag on run B only, on its follow-up too, and recorded on the turn', async () => {
  const [a, b] = await launchTwo('skillsb', { skills: 'off' });
  assert.equal(flags(runIn('skillsb', a)), 0);
  assert.equal(flags(runIn('skillsb', b)), 1);
  assert.equal(b.skills, 'off');
  assert.equal(a.skills, undefined);
  assert.equal(b.turns[0].run?.skills, 'off');
  assert.equal(a.turns[0].run?.skills, undefined);
  assert.equal((await api('/sessions')).find((x) => x.id === b.id).skills, 'off');
  await api(`/sessions/${b.id}/reply`, { text: 'and the next one skillsbnext' });
  await ended(b.id);
  assert.equal(flags(runsOf('skillsbnext')[0]), 1);
});

test('skills off: never twice in a lean run; unset or anything else adds nothing', async () => {
  const go = (word, opts) => adapters.claude.run({ prompt: word, cwd: makeRepo(), mode: 'plan', model: '', systemPrompt: 'x', attachments: [], onEvent: () => {}, ...opts }).done;
  await go('adapterlean', { lean: true, skills: 'off' });
  await go('adapteroff', { skills: 'off' });
  await go('adapteron', {});
  await go('adapterbogus', { skills: 'on' });
  const rec = (w) => records(RECORD, 'claude').concat(records(RECORD, 'retro')).find((r) => r.stdin.includes(w));
  assert.equal(flags(rec('adapterlean')), 1, 'LEAN has it already');
  assert.equal(flags(rec('adapteroff')), 1);
  assert.equal(flags(rec('adapteron')), 0);
  assert.equal(flags(rec('adapterbogus')), 0);
});

test('skills off: /compact goes without the flag, typed or from Compact now, and the next turn has it again', async () => {
  const cwd = makeRepo();
  const first = await api('/sessions', { prompt: 'task compactfirst', cwd, agent: 'claude', worktree: false, skills: 'off' });
  await ended(first.id);
  assert.equal(flags(runsOf('compactfirst')[0]), 1);

  const count = () => records(RECORD, 'claude').length;
  let was = count();
  await api(`/sessions/${first.id}/reply`, { text: '  /compact keep the tests' });
  await ended(first.id);
  assert.equal(count(), was + 1);
  assert.equal(flags(records(RECORD, 'claude').at(-1)), 0, 'typed: with the flag it answers “isn’t available in this environment”');

  was = count();
  srv.runner.reply(srv.store.get(first.id), '/compact', [], { by: 'compact' }); // what routes/sessions.js does for Compact now
  await ended(first.id);
  assert.equal(count(), was + 1);
  assert.equal(records(RECORD, 'claude').at(-1).stdin.trim(), '/compact');
  assert.equal(flags(records(RECORD, 'claude').at(-1)), 0, 'Compact now');

  await api(`/sessions/${first.id}/reply`, { text: 'back to work compactnext' });
  await ended(first.id);
  assert.equal(flags(runsOf('compactnext')[0]), 1, 'back on the next turn');
});

test('skills off: Compact now through its route goes without the flag, and a normal follow-up has it back', async () => {
  // A large warm task, what the route asks for (test/compact.test.js).
  process.env.FAKE_CONTEXT = '1h';
  try {
    const s = await api('/sessions', { prompt: 'task routecompact', cwd: makeRepo(), agent: 'claude', worktree: false, skills: 'off' });
    await ended(s.id);
    assert.equal(flags(runsOf('routecompact')[0]), 1);
    const was = records(RECORD, 'claude').length;
    assert.equal((await call(`/sessions/${s.id}/compact`, {})).status, 200);
    const compacted = await until(async () => {
      const x = await api(`/sessions/${s.id}`);
      return x.turns.length === 2 && x.turns[1].status !== 'running' && x.state !== 'running' && x;
    }, { timeout: 30_000 });
    assert.equal(compacted.turns[1].by, 'compact');
    const run = records(RECORD, 'claude').slice(was);
    assert.equal(run.length, 1);
    assert.equal(run[0].stdin.trim(), '/compact');
    assert.equal(flags(run[0]), 0, 'with the flag it answers “isn’t available in this environment”');
    await api(`/sessions/${s.id}/reply`, { text: 'back to work routenext' });
    await ended(s.id);
    assert.equal(flags(runsOf('routenext')[0]), 1, 'back on the next turn');
  } finally {
    delete process.env.FAKE_CONTEXT;
  }
});

test('trial: written on every run of the launch, with only what differs, in run order', async () => {
  const [a, b] = await launchTwo('writes', { subagentModel: 'haiku', effort: 'max' });
  const differs = [{ key: 'effort', values: ['high', 'max'] }, { key: 'subagentModel', values: ['', 'haiku'] }];
  assert.deepEqual(a.trial, { differs, kept: null });
  assert.deepEqual(b.trial, { differs, kept: null });
});

test('trial: the effective subagent model, from the setting; skills read on or off; the same setup is []', async () => {
  await api('/config', { defaults: { subagentModel: 'haiku' } }, 'PATCH');
  try {
    const [a] = await launchTwo('effective', { subagentModel: '' });
    assert.deepEqual(a.trial.differs, [{ key: 'subagentModel', values: ['haiku', ''] }]);
  } finally {
    await api('/config', { defaults: { subagentModel: '' } }, 'PATCH');
  }
  const [c] = await launchTwo('skillswords', { skills: 'off' });
  assert.deepEqual(c.trial.differs, [{ key: 'skills', values: ['on', 'off'] }]);
  const [d] = await launchTwo('nothing', {});
  assert.deepEqual(d.trial, { differs: [], kept: null });
  const [e] = await launchTwo('harness', { agent: 'codex', model: '', effort: '' });
  assert.deepEqual(e.trial.differs.map((x) => x.key), ['agent', 'model', 'effort']);
});

test('Keep this: trial.kept is that run on every run of its group; a task without a trial ignores it', async () => {
  const [a, b] = await launchTwo('keep', { skills: 'off' });
  await api(`/sessions/${b.id}`, { trialKept: true }, 'PATCH');
  assert.equal((await api(`/sessions/${a.id}`)).trial.kept, b.id);
  assert.equal((await api(`/sessions/${b.id}`)).trial.kept, b.id);
  const plain = await api('/sessions', { prompt: 'a plain task keepplain', cwd: makeRepo(), agent: 'claude', worktree: false });
  await ended(plain.id);
  await api(`/sessions/${plain.id}`, { trialKept: true }, 'PATCH');
  assert.equal((await api(`/sessions/${plain.id}`)).trial, undefined);
});

test('plain Compare has no trial', async () => {
  const out = await api('/sessions', { prompt: 'plain compare', cwd: makeRepo(), agent: 'claude', compare: [{ agent: 'codex' }] });
  const [a, b] = await Promise.all(out.group.map((x) => ended(x.id)));
  assert.equal(a.trial, undefined);
  assert.equal(b.trial, undefined);
});

test('refused: values outside the list, and either field on anything but Claude Code', async () => {
  await refused({ subagentModel: 'opus' }, /subagentModel must be/, 'top level');
  await refused({ compare: [{ agent: 'claude', subagentModel: 'opus' }] }, /subagentModel must be/, 'a compare entry');
  await refused({ subagentModel: null }, /subagentModel must be/, 'null isn’t a value');
  await refused({ skills: 'on' }, /skills must be/, 'top level');
  await refused({ compare: [{ agent: 'claude', skills: 'none' }] }, /skills must be/, 'a compare entry');
  await refused({ agent: 'codex', subagentModel: 'haiku' }, /Subagents and Skills are Claude Code only/, 'lead on codex');
  await refused({ agent: 'codex', skills: 'off' }, /Subagents and Skills are Claude Code only/, 'lead on codex');
  await refused({ compare: [{ agent: 'codex', skills: 'off' }] }, /Subagents and Skills are Claude Code only/, 'a run on codex');
  await refused({ compare: [{ agent: 'codex', subagentModel: '' }] }, /Subagents and Skills are Claude Code only/, 'present is present');
  await refused({ agent: 'auto', subagentModel: 'haiku' }, /Subagents and Skills are Claude Code only/, 'Auto may not pick Claude');
  await refused({ compare: [{ agent: 'auto', skills: 'off' }] }, /Subagents and Skills are Claude Code only/, 'nor for a run');
});

test('refused: a variant that would change nothing, on a lead with a team', async () => {
  const subagents = [{ name: 'Rev', agent: 'codex' }];
  await refused({ subagents, compare: [{ agent: 'claude', subagentModel: 'haiku' }], trial: true }, /team/, 'two identical paid runs otherwise');
});

test('refused: a trial needs two runs, not Plan, not an Auto lead; nothing is made first', async () => {
  const before = srv.store.all().length;
  const cwd = makeRepo();
  const trees = () => fs.readdirSync(path.join(srv.store.home, 'worktrees')).length;
  fs.mkdirSync(path.join(srv.store.home, 'worktrees'), { recursive: true });
  const had = trees();
  await refused({ cwd, trial: true }, /two runs/, 'one run');
  await refused({ cwd, trial: true, compare: [{ agent: 'claude' }], mode: 'plan' }, /Plan/, 'Plan');
  await refused({ cwd, trial: true, agent: 'auto', compare: [{ agent: 'claude' }] }, /^Pick a harness first$/, 'Auto');
  await refused({ cwd, trial: true, agent: 'claude', route: { key: 'claude:opus:high' }, compare: [{ agent: 'claude' }] }, /^Pick a harness first$/, 'routed elsewhere');
  assert.equal(srv.store.all().length, before);
  assert.equal(trees(), had);
  await assert.rejects(srv.launcher.launch({ prompt: 'x', cwd, agent: 'claude', trial: true }, null, { dry: true }), /two runs/, 'on dry too');
});

test('refused: a trial without a worktree per run, in place or with no folder; nothing is made, on dry too', async () => {
  const words = /^Try it two ways needs a project in git: each run keeps its own worktree\.$/;
  const scratch = path.join(srv.store.home, 'scratch');
  const dirs = () => (fs.existsSync(scratch) ? fs.readdirSync(scratch).length : 0);
  const sessions = srv.store.all().length;
  const had = dirs();
  const both = { trial: true, compare: [{ agent: 'claude', skills: 'off' }] };
  await refused({ ...both, worktree: false }, words, 'in place: both runs in one folder');
  await refused({ ...both, scratch: true, cwd: undefined }, words, 'no folder: one scratch folder for both');
  assert.equal(srv.store.all().length, sessions, 'the refusal makes no session');
  assert.equal(dirs(), had, 'nor a scratch folder');
  const dry = { prompt: 'x', agent: 'claude', ...both };
  await assert.rejects(srv.launcher.launch({ ...dry, cwd: makeRepo(), worktree: false }, null, { dry: true }), { message: words });
  await assert.rejects(srv.launcher.launch({ ...dry, scratch: true }, null, { dry: true }), { message: words });
  const plain = await api('/sessions', { prompt: 'plain compare in place', cwd: makeRepo(), agent: 'claude', worktree: false, compare: [{ agent: 'codex' }] });
  await Promise.all(plain.group.map((x) => ended(x.id)));
});

test('/terminal drops the variant with the compare runs: a terminal can’t carry them', async () => {
  const s = await api('/sessions', { prompt: '/terminal look around', cwd: makeRepo(), agent: 'claude', compare: [{ agent: 'claude', skills: 'off' }], trial: true, subagentModel: 'haiku' });
  assert.equal(s.group, undefined);
  assert.equal(s.subagentModel, undefined);
  await ended(s.id).catch(() => {});
});

test('terminal sessions: a run with a variant is driven by wisp, or the variant would go unused', async () => {
  const s = await api('/sessions', { prompt: 'task interminal', cwd: makeRepo(), agent: 'claude', worktree: false, skills: 'off', tui: true });
  assert.equal(s.tui, undefined);
  await ended(s.id);
  assert.equal(flags(runsOf('interminal')[0]), 1);
});

test('fork and move: a fork keeps the variant on Claude and drops it on another harness; a moved run keeps it', async () => {
  const s = await api('/sessions', { prompt: 'task forkme', cwd: makeRepo(), agent: 'claude', subagentModel: 'haiku', skills: 'off' });
  await ended(s.id);
  const f = await api(`/sessions/${s.id}/fork`, { prompt: 'carry on forked' });
  assert.equal(f.subagentModel, 'haiku');
  assert.equal(f.skills, 'off');
  await ended(f.id);
  assert.equal(runsOf('carry on forked')[0].subagentModel, 'haiku');
  assert.equal(flags(runsOf('carry on forked')[0]), 1);
  const c = await api(`/sessions/${s.id}/fork`, { prompt: 'carry on elsewhere', agent: 'codex' });
  assert.equal(c.subagentModel, undefined);
  assert.equal(c.skills, undefined);
  await ended(c.id);

  const [moved] = await srv.launcher.launch({ prompt: 'moved here', cwd: makeRepo(), agent: 'claude', subagentModel: 'sonnet', skills: 'off', moved: { from: 'there', title: 'moved', packs: [null], turns: [] } });
  assert.equal(moved.subagentModel, 'sonnet');
  assert.equal(moved.skills, 'off');
  await ended(moved.id);
});

test('Ask near the limit: together multiplies a run’s estimate, not the runs already going', () => {
  const now = Date.now();
  const done = (id, costUsd) => ({ id, agent: 'claude', createdAt: now - 3600_000, turns: [{ status: 'done', startedAt: now - 3600_000, endedAt: now - 3000_000, stats: { costUsd } }] });
  const running = { id: 'r', agent: 'claude', createdAt: now, turns: [{ status: 'running' }] };
  const window = { id: 'five_hour', label: '5-hour', used: 0.5, resetsAt: now + 3600_000, ms: 5 * 3600_000 };
  const g = new Guard({ store: { all: () => [done('a', 1), done('b', 1), done('c', 1), running], config: { defaults: {} } }, budget: { windows: () => [window], rate: () => 0.1, acked: () => 0, ack() {} }, setting: () => '90' });
  const one = g.windows('claude', 'default', { kind: 'first' })[0];
  const two = g.windows('claude', 'default', { kind: 'first', together: 2 })[0];
  const x = 0.1; // the median run, in shares
  const going = x / 2; // the one running, at half
  assert.ok(Math.abs(one.est.first[1] - (x + going)) < 1e-9);
  assert.ok(Math.abs(two.est.first[1] - (x * 2 + going)) < 1e-9, '(x * together + running) * r');
  assert.ok(Math.abs(one.running - going) < 1e-9, 'the page needs the part that isn’t multiplied');
  assert.equal(g.check({ agent: 'claude', account: 'default' }), null);
  const near = { ...window, used: 0.72 };
  const h = new Guard({ store: g.store, budget: { windows: () => [near], rate: () => 0.1, acked: () => 0, ack() {} }, setting: () => '90' });
  assert.equal(h.check({ agent: 'claude', account: 'default' }), null, '0.72 + 0.15 stays under 0.9 alone');
  assert.equal(h.check({ agent: 'claude', account: 'default', together: 2 }).id, 'five_hour', '0.72 + 0.25 crosses it');
  let acked = 0;
  const i = new Guard({ store: g.store, budget: { windows: () => [near], rate: () => 0.1, acked: () => 0, ack() { acked++; } }, setting: () => '90' });
  i.confirm({ agent: 'claude', account: 'default' });
  assert.equal(acked, 0);
  i.confirm({ agent: 'claude', account: 'default', together: 2 });
  assert.equal(acked, 1, 'a yes covers what you said yes to');
});

test('Ask near the limit, the page’s rule: holdFor sums the same way', () => {
  const w = { id: 'five_hour', label: '5-hour', used: 0.72, line: 0.9, resetsAt: null, running: 0.05, est: { first: [0.1, 0.15, 0.2] } };
  assert.equal(holdFor([w], 'first'), null);
  assert.equal(holdFor([w], 'first', 1), null);
  const h = holdFor([w], 'first', 2);
  assert.equal(h.id, 'five_hour');
  assert.ok(Math.abs(h.to[1] - 1) < 1e-9 || h.to[1] <= 1, 'capped at the limit');
  assert.ok(Math.abs(h.to[0] - (0.72 + 0.05 * 2 + 0.05)) < 1e-9, 'the running part counts once');
  assert.equal(holdFor([{ ...w, running: undefined }], 'first'), null, 'from a wisp that doesn’t send it');
});

test('Ask near the limit: a launch sums the runs sharing an account, not those on two accounts or harnesses', async () => {
  const seen = [];
  const { check } = srv.guard;
  const { accountFor } = srv.runner;
  srv.guard.check = (x) => (seen.push(x), null);
  srv.runner.accountFor = (agent, want) => want || '';
  try {
    const go = async (compare, account) => {
      seen.length = 0;
      const out = await api('/sessions', { prompt: 'summed', cwd: makeRepo(), agent: 'claude', account, compare });
      await Promise.all(out.group.map((x) => ended(x.id)));
      return seen.map((x) => x.together);
    };
    assert.deepEqual(await go([{ agent: 'claude' }]), [2, 2], 'one account');
    assert.deepEqual(await go([{ agent: 'claude', account: 'home' }], 'work'), [1, 1], 'two accounts');
    assert.deepEqual(await go([{ agent: 'codex' }]), [1, 1], 'two harnesses');
    assert.deepEqual(await go([{ agent: 'claude' }, { agent: 'codex' }]), [2, 2, 1], 'mixed');
  } finally {
    srv.guard.check = check;
    srv.runner.accountFor = accountFor;
  }
});

test('telemetry: one count with no properties, for a trial only, never on dry or a refusal', async () => {
  const seen = [];
  const { track } = srv.telemetry;
  srv.telemetry.track = (event, props) => {
    if (event === 'try_two_ways') seen.push(props);
  };
  try {
    await launchTwo('counted', { skills: 'off' });
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0] ?? {}, {}, 'a count: no agent, no prompt, no paths');
    const plain = await api('/sessions', { prompt: 'plain compare uncounted', cwd: makeRepo(), agent: 'claude', compare: [{ agent: 'codex' }] });
    await Promise.all(plain.group.map((x) => ended(x.id)));
    await refused({ trial: true }, /two runs/, 'a refused one');
    await srv.launcher.launchAny({ prompt: 'dry', cwd: makeRepo(), agent: 'claude', compare: [{ agent: 'claude', skills: 'off' }], trial: true }, null, { dry: true });
    assert.equal(seen.length, 1);
    // A machine's wisp gets the launch from this one, which counted it.
    const out = await api('/sessions', { prompt: 'on a machine', cwd: makeRepo(), agent: 'claude', compare: [{ agent: 'claude', skills: 'off' }], trial: true, counted: true });
    await Promise.all(out.group.map((x) => ended(x.id)));
    assert.equal(seen.length, 1);
  } finally {
    srv.telemetry.track = track;
  }
});

test('telemetry: the count goes through the off switch; what leaves holds no prompt, path or agent', async () => {
  const env = Object.fromEntries(['CI', 'DO_NOT_TRACK', 'WISP_TELEMETRY'].map((k) => [k, process.env[k]]));
  const { post } = srv.telemetry;
  const { telemetry } = srv.store.config.defaults;
  srv.telemetry.post = async () => true; // never the network
  for (const k of Object.keys(env)) delete process.env[k];
  const counts = () => srv.telemetry.queue.filter((x) => x.event === 'try_two_ways');
  try {
    srv.telemetry.queue.length = 0;
    srv.store.config.defaults.telemetry = 'off';
    await launchTwo('telemetryoff', { skills: 'off' });
    assert.equal(counts().length, 0, 'Settings off: nothing queued');

    srv.store.config.defaults.telemetry = 'on';
    process.env.WISP_TELEMETRY = '0';
    await launchTwo('telemetryenv', { skills: 'off' });
    assert.equal(counts().length, 0, 'WISP_TELEMETRY=0: nothing queued');
    delete process.env.WISP_TELEMETRY;

    await launchTwo('telemetrysecret', { subagentModel: 'haiku' });
    assert.equal(counts().length, 1);
    const sent = counts()[0];
    assert.deepEqual(Object.keys(sent.properties).sort(), [...Object.keys(srv.telemetry.common), 'distinct_id'].sort(), 'only what every event carries');
    const text = JSON.stringify(sent);
    for (const word of ['telemetrysecret', 'change the add', 'haiku', 'claude', 'opus', '/tmp', '/var/']) assert.ok(!text.includes(word), `no ${word} in it`);
  } finally {
    srv.telemetry.queue.length = 0;
    srv.telemetry.post = post;
    srv.store.config.defaults.telemetry = telemetry;
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('Compare: what differed, in words', () => {
  const opts = { model: (id) => ({ 'claude-opus-5-5': 'Opus', 'claude-sonnet-5-5': 'Sonnet' })[id] || id, taskModel: 'Opus' };
  assert.equal(differsWords([{ key: 'subagentModel', values: ['', 'haiku'] }], opts), 'Subagents: Opus → Haiku');
  assert.equal(differsWords([{ key: 'subagentModel', values: ['sonnet', ''] }], opts), 'Subagents: Sonnet → Opus');
  assert.equal(differsWords([{ key: 'skills', values: ['on', 'off'] }], opts), 'Skills: on → off');
  assert.equal(differsWords([{ key: 'effort', values: ['high', 'max'] }], opts), 'Thinking: High → Max');
  assert.equal(differsWords([{ key: 'effort', values: ['', 'xhigh'] }], opts), 'Thinking: Default → X-High');
  assert.equal(differsWords([{ key: 'model', values: ['claude-opus-5-5', 'claude-sonnet-5-5'] }], opts), 'Model: Opus → Sonnet');
  assert.equal(differsWords([{ key: 'effort', values: ['high', 'max'] }, { key: 'skills', values: ['on', 'off'] }], opts), 'Thinking: High → Max · Skills: on → off');
  assert.equal(differsWords([{ key: 'agent', values: ['claude', 'codex'] }], { agent: (id) => ({ claude: 'Claude Code', codex: 'Codex' })[id] }), 'Harness: Claude Code → Codex');
  assert.equal(differsWords([{ key: 'account', values: ['work', 'home'] }], { account: (id) => id.toUpperCase() }), 'Account: WORK → HOME');
  assert.equal(differsWords([{ key: 'skills', values: ['on', 'off', 'on'] }], opts), 'Skills: on → off → on');
  assert.equal(differsWords([], opts), 'Same setup on both runs');
  assert.equal(differsWords(undefined, opts), 'Same setup on both runs');
});

test('the variant in words, for the pill, the tooltips and Compare’s columns', () => {
  assert.deepEqual(variantWords({ subagentModel: 'haiku' }), ['Subagents on Haiku']);
  assert.deepEqual(variantWords({ subagentModel: 'sonnet', skills: 'off' }), ['Subagents on Sonnet', 'Skills off']);
  assert.deepEqual(variantWords({}), []);
  assert.deepEqual(variantWords(undefined), []);
  assert.deepEqual(variantWords({ subagentModel: '' }), [], 'the task’s model is what happens anyway');
  assert.deepEqual(variantWords({ subagentModel: '' }, 'haiku'), ['Subagents on task’s model'], 'not with the setting on');
});

test('CLI: --try parsing, and what it refuses before it reaches a wisp', () => {
  assert.deepEqual(tryRuns(['subagents=haiku']), { subagentModel: 'haiku' });
  assert.deepEqual(tryRuns(['subagents=sonnet', 'skills=off']), { subagentModel: 'sonnet', skills: 'off' });
  assert.deepEqual(tryRuns(['subagents=task,skills=off']), { subagentModel: '', skills: 'off' });
  assert.throws(() => tryRuns(['subagents=opus']), /--try subagents=haiku\|sonnet\|task/);
  assert.throws(() => tryRuns(['skills=on']), /--try skills=off/);
  assert.throws(() => tryRuns(['thinking=max']), /--try subagents=/);
  assert.match(tryProblem({ agent: null }), /^--try needs --agent: pick a harness first$/);
  assert.match(tryProblem({ agent: 'auto' }), /^--try needs --agent/);
  assert.match(tryProblem({ agent: 'claude', compare: [{ agent: 'codex' }] }), /--compare/);
  assert.match(tryProblem({ agent: 'claude', mode: 'plan' }), /Plan/i);
  assert.match(tryProblem({ agent: 'claude', worktree: false }), /^--try keeps a worktree per run: leave out --no-worktree$/);
  assert.equal(tryProblem({ agent: 'claude', worktree: true }), null);
  assert.equal(tryProblem({ agent: 'claude', mode: 'edits' }), null);
});

test('CLI: bin/wisp.js refuses --try locally, with the words it shows', async () => {
  const bin = fileURLToPath(new URL('../bin/wisp.js', import.meta.url));
  const run = (...args) => new Promise((resolve) => execFile(process.execPath, [bin, ...args], { env: { ...process.env, WISP_PORT: '1' }, timeout: 15_000 }, (err, stdout, stderr) => resolve({ code: err?.code, stderr })));
  const a = await run('--json', '--try', 'skills=off', 'do it');
  assert.notEqual(a.code, 0);
  assert.match(a.stderr, /--try needs --agent: pick a harness first/);
  const b = await run('--json', '--agent', 'claude', '--try', 'subagents=opus', 'do it');
  assert.notEqual(b.code, 0);
  assert.match(b.stderr, /--try subagents=haiku\|sonnet\|task/);
  const c = await run('--json', '--agent', 'claude', '--no-worktree', '--try', 'skills=off', 'do it');
  assert.notEqual(c.code, 0);
  assert.match(c.stderr, /--try keeps a worktree per run: leave out --no-worktree/);
});

test('client.launch passes the fields on; a trial’s copy has the lead’s model', async () => {
  const wisp = await WispClient.connect({ port: Number(new URL(base).port), start: false });
  const out = await wisp.launch({ prompt: 'through the client', cwd: makeRepo(), agent: 'claude', mode: 'auto', model: 'claude-opus-5-5', compare: [{ agent: 'claude', skills: 'off' }], trial: true });
  const [a, b] = await Promise.all(out.group.map((x) => ended(x.id)));
  assert.deepEqual(a.trial.differs, [{ key: 'skills', values: ['on', 'off'] }], 'the same model on both');
  assert.equal(b.skills, 'off');
  const lone = await wisp.launch({ prompt: 'one run clientsub', cwd: makeRepo(), agent: 'claude', mode: 'auto', model: '', worktree: false, subagentModel: 'haiku', skills: 'off' });
  assert.equal(lone.subagentModel, 'haiku');
  assert.equal(lone.skills, 'off');
  await ended(lone.id);
});
