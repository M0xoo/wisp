// What the CLI was, per turn (stats.cli), and what moved between turns (web/js/what-changed.js):
// the pure comparison, then real runs of the fake claude and codex.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { installFakeBins, makeRepo, records, sleep, tmp, until } from './helpers.js';

const { whatChanged } = await import('../web/js/what-changed.js');
const { whatChangedLine } = await import('../web/js/what-changed-line.js');
const { shareTurn } = await import('../server/services/share.js');

const RECORD = tmp('wc-record');
process.env.FAKE_RECORD = RECORD;
process.env.WISP_HOME = tmp('wc-home');
process.env.WISP_UPDATE_CHECK = '0'; // no registry calls from tests
installFakeBins();

const { startServer } = await import('../server/index.js');
const { adapters } = await import('../server/adapters/index.js');

// --- whatChanged ------------------------------------------------------------------------------

const turn = (cli, more = {}) => ({ id: Math.random().toString(36).slice(2), stats: cli ? { durationMs: 1, cli } : { durationMs: 1 }, ...more });
const said = (...turns) => whatChanged({ agent: 'claude', turns }, turns.at(-1));

test('a first turn, or nothing to read, says nothing', () => {
  assert.equal(said(turn({ version: '1.0.0' })), null);
  assert.equal(whatChanged({ agent: 'claude', turns: [] }, turn({ version: '1.0.0' })), null, 'a turn that is not in the task');
  assert.equal(whatChanged({ agent: 'claude', turns: [turn({ version: '1.0.0' })] }, null), null);
  assert.equal(said(turn({ version: '1.0.0' }), { id: 'x', stats: null }), null, 'this turn has no stats');
});

test('nothing moved: null', () => {
  const cli = { version: '1.0.0', tools: 'aaa', catalog: 'ccc', account: 'b' };
  assert.equal(said(turn(cli), turn({ ...cli })), null);
});

test('the version moved', () => {
  assert.deepEqual(said(turn({ version: '1.0.0' }), turn({ version: '1.1.0' })), { version: ['1.0.0', '1.1.0'] });
});

test('tools: the names added and removed, from the list stored once per task', () => {
  const a = turn({ tools: 'aaa' }, { details: { tools: { hash: 'aaa', list: ['Edit', 'Read', 'WebFetch'] } } });
  const again = turn({ tools: 'aaa' }, { details: { tools: { hash: 'aaa' } } });
  const b = turn({ tools: 'bbb' }, { details: { tools: { hash: 'bbb', list: ['Edit', 'Read', 'WebSearch'] } } });
  assert.deepEqual(said(a, again, b), { tools: { added: ['WebSearch'], removed: ['WebFetch'] } });
  const back = turn({ tools: 'aaa' }, { details: { tools: { hash: 'aaa' } } });
  assert.deepEqual(said(a, b, back), { tools: { added: ['WebFetch'], removed: ['WebSearch'] } }, 'an older list, found by its hash');
});

test('tools: a list that is not there is true, not a guess', () => {
  const a = turn({ tools: 'aaa' }, { details: { tools: { hash: 'aaa' } } });
  const b = turn({ tools: 'bbb' }, { details: { tools: { hash: 'bbb', list: ['Read'] } } });
  assert.deepEqual(said(a, b), { tools: true });
  assert.deepEqual(said(turn({ tools: 'aaa' }), turn({ tools: 'bbb' })), { tools: true }, 'no details at all');
});

test('the catalog moved, with the version beside it', () => {
  assert.deepEqual(said(turn({ version: '1', catalog: 'a' }), turn({ version: '2', catalog: 'b' })), { version: ['1', '2'], catalog: true });
});

test('a field is compared only when both turns have it', () => {
  assert.equal(said(turn({ version: '1.0.0' }), turn({ catalog: 'a' })), null);
  assert.equal(said(turn({ catalog: 'a', version: '1' }), turn({ version: '1' })), null, 'a probe that failed');
});

test('a turn on another harness is skipped past, not compared', () => {
  const s = { agent: 'codex', turns: [turn({ version: '1.0.0' }, { agent: 'codex' }), turn({ version: '7.0.0' }, { agent: 'claude' }), turn({ version: '1.0.0' }, { agent: 'codex' })] };
  assert.equal(whatChanged(s, s.turns[2]), null);
  s.turns[2].stats.cli.version = '1.1.0';
  assert.deepEqual(whatChanged(s, s.turns[2]), { version: ['1.0.0', '1.1.0'] });
  assert.equal(whatChanged(s, s.turns[1]), null, 'the first of its harness');
});

test('a turn on another account is skipped past, and the default account has no name', () => {
  const home = { catalog: 'aaa' };
  assert.equal(said(turn(home), turn({ catalog: 'bbb', account: 'pers' }), turn(home)), null);
  assert.deepEqual(said(turn({ catalog: 'bbb', account: 'pers' }), turn(home), turn({ catalog: 'ccc', account: 'pers' })), { catalog: true });
  assert.equal(said(turn({ catalog: 'aaa' }), turn({ catalog: 'aaa', account: 'default' })), null);
  assert.deepEqual(said(turn({ catalog: 'aaa' }), turn({ catalog: 'bbb', account: 'default' })), { catalog: true });
});

test('a turn with null stats, or an old turn without cli, between two is skipped past', () => {
  const nulled = { id: 'n', stats: null };
  const old = turn(null);
  assert.deepEqual(said(turn({ version: '1' }), nulled, old, turn({ version: '2' })), { version: ['1', '2'] });
  assert.equal(said(old, nulled, turn({ version: '2' })), null, 'only old turns before it');
});

// --- the line ------------------------------------------------------------------------------------

const line = (moved, more) => whatChangedLine(moved, { name: 'Claude Code', ...more });
const ONE = 'Possible cause, not proof; a server-side change won’t show.';
const MANY = 'Possible causes, not proof; a server-side change won’t show.';

test('the line: each thing that moved, and the limit that goes with it', () => {
  assert.equal(line(null), null);
  assert.deepEqual(line({ version: ['2.1.316', '2.1.318'] }), { said: 'Since the last turn: Claude Code 2.1.316 → 2.1.318.', limit: ONE });
  assert.deepEqual(line({ tools: true }), { said: 'Since the last turn: tool set changed.', limit: ONE });
  assert.deepEqual(whatChangedLine({ catalog: true }, { name: 'Codex' }), { said: 'Since the last turn: Codex model catalog changed.', limit: ONE });
  assert.deepEqual(line({ version: ['1', '2'], tools: { added: ['WebFetch'], removed: [] }, catalog: true }), { said: 'Since the last turn: Claude Code 1 → 2, WebFetch added, Claude Code model catalog changed.', limit: MANY });
});

test('the line: up to 3 tools by name, then a count', () => {
  const tools = (added, removed = []) => line({ tools: { added, removed } }).said.replace('Since the last turn: ', '');
  assert.equal(tools(['A', 'B', 'C']), 'A, B and C added.');
  assert.equal(tools(['A', 'B', 'C', 'D', 'E']), 'A, B, C and 2 more added.');
  assert.equal(tools(['A'], ['B', 'C']), 'A added, B and C removed.');
  assert.equal(tools(['A', 'B', 'C', 'D'], ['E', 'F']), 'A, B, C and 1 more added, 2 tools removed.');
  assert.equal(tools(['A', 'B', 'C'], ['E']), 'A, B and C added, 1 tool removed.');
  assert.equal(tools([], ['A', 'B', 'C', 'D']), 'A, B, C and 1 more removed.');
});

test('the line: an MCP tool reads as a tool on its server', () => {
  const said = (name) => line({ tools: { added: [name], removed: [] } }).said;
  assert.match(said('mcp__github__create_issue'), /: create issue \(github\) added/);
  assert.match(said('mcp__claude_ai_Linear__list-issues'), /: list issues \(claude ai Linear\) added/);
  assert.match(said('mcp__github'), /: github added/);
  assert.match(said('WebFetch'), /: WebFetch added/);
});

test('the line: the harness note already gave the version', () => {
  assert.equal(line({ version: ['1', '2'] }, { noted: true }), null, 'nothing else moved');
  assert.deepEqual(line({ version: ['1', '2'], tools: true }, { noted: true }), { said: 'Since the last turn: tool set changed.', limit: ONE });
});

// --- real runs --------------------------------------------------------------------------------

let srv;
let base;
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function api(p, body) {
  const r = await fetch(`${base}/api${p}`, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(`${p}: ${j.error}`);
  return j;
}
const turnsDone = (id, n) =>
  until(async () => {
    const s = await api(`/sessions/${id}`);
    return s.turns.length === n && s.turns.every((t) => t.status !== 'running') && s;
  }, { timeout: 30_000, what: `${n} turns of ${id}` });
const launch = (agent, more = {}) => api('/sessions', { prompt: 'fix the add bug please', cwd: makeRepo(), agent, worktree: false, ...more });
const followUp = (id, more = {}) => api(`/sessions/${id}/reply`, { text: 'and the docs please', ...more });
// The probe of a run on a fast harness may land just after the turn.
const landed = (id, i, key) =>
  until(async () => {
    const s = await api(`/sessions/${id}`);
    return s.turns[i]?.stats?.cli?.[key] && s;
  }, { timeout: 10_000, what: `${key} on turn ${i}` });
const FAKE = ['FAKE_CLI_VERSION', 'FAKE_TOOLS', 'FAKE_CODEX_CATALOG', 'FAKE_CODEX_DEBUG_WAIT', 'FAKE_CODEX_NO_DEBUG'];
const sha = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);

before(async () => {
  fs.writeFileSync(path.join(process.env.WISP_HOME, 'accounts.json'), JSON.stringify({ codex: [{ id: 'default', label: 'Work' }, { id: 'pers', label: 'Personal' }] }));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  srv = await startServer({ port, handleSignals: false });
  await api('/agents'); // detect, so harnesses without their own report have a version
});
after(() => {
  srv.shutdown();
  srv.server.closeAllConnections?.();
  srv.server.close();
});

test('claude: version and tools per turn, and they move when the CLI does', { concurrency: false }, async (t) => {
  t.after(() => FAKE.forEach((k) => delete process.env[k]));
  process.env.FAKE_CLI_VERSION = '2.1.0';
  process.env.FAKE_TOOLS = 'Read,Edit,WebFetch,mcp__wisp__ask_user';
  const s = await launch('claude');
  let x = await turnsDone(s.id, 1);
  assert.deepEqual(x.turns[0].stats.cli, { version: '2.1.0', tools: x.turns[0].details.tools.hash });
  assert.equal(whatChanged(x, x.turns[0]), null);

  await followUp(s.id);
  x = await turnsDone(s.id, 2);
  assert.deepEqual(x.turns[1].stats.cli, x.turns[0].stats.cli);
  assert.equal(whatChanged(x, x.turns[1]), null, 'same CLI, same tools');

  process.env.FAKE_CLI_VERSION = '2.2.0';
  process.env.FAKE_TOOLS = 'Read,Edit,WebSearch';
  await followUp(s.id);
  x = await turnsDone(s.id, 3);
  assert.deepEqual(whatChanged(x, x.turns[2]), { version: ['2.1.0', '2.2.0'], tools: { added: ['WebSearch'], removed: ['WebFetch'] } });
});

test('codex: version and catalog per turn, the hash over the parsed list, and it moves', { concurrency: false }, async (t) => {
  t.after(() => FAKE.forEach((k) => delete process.env[k]));
  process.env.FAKE_CLI_VERSION = '0.5.0';
  const s = await launch('codex');
  await turnsDone(s.id, 1);
  let x = await landed(s.id, 0, 'catalog');
  assert.deepEqual(Object.keys(x.turns[0].stats.cli).sort(), ['account', 'catalog', 'version'], 'this harness has accounts here');
  assert.equal(x.turns[0].stats.cli.version, '0.5.0', 'the bare version, not `fake-codex 0.5.0`');
  const models = JSON.parse(execFileSync(process.env.WISP_CODEX_BIN || 'codex', ['debug', 'models'], { encoding: 'utf8', shell: process.platform === 'win32' })).models;
  assert.equal(x.turns[0].stats.cli.catalog, sha(JSON.stringify(models)));

  process.env.FAKE_CODEX_CATALOG = 'gpt-11';
  await followUp(s.id);
  await turnsDone(s.id, 2);
  x = await landed(s.id, 1, 'catalog');
  assert.notEqual(x.turns[1].stats.cli.catalog, x.turns[0].stats.cli.catalog);
  assert.deepEqual(whatChanged(x, x.turns[1]), { catalog: true });
});

test('codex: a probe that ends after the turn did still lands', { concurrency: false }, async (t) => {
  t.after(() => FAKE.forEach((k) => delete process.env[k]));
  const gate = path.join(tmp('wc-gate'), 'go');
  process.env.FAKE_CODEX_DEBUG_WAIT = gate;
  const s = await launch('codex');
  const ended = await turnsDone(s.id, 1);
  assert.equal(ended.turns[0].status, 'done');
  assert.equal(ended.turns[0].stats.cli?.catalog, undefined, 'the turn ended first');
  await sleep(100); // and the run has been let go of
  fs.writeFileSync(gate, '');
  const x = await landed(s.id, 0, 'catalog');
  assert.equal(x.turns[0].status, 'done');
  assert.equal(typeof x.turns[0].stats.durationMs, 'number', 'the rest of its stats are as they were');
  // It's on disk too, not only in memory.
  await until(() => JSON.parse(fs.readFileSync(path.join(process.env.WISP_HOME, 'sessions', `${s.id}.json`), 'utf8')).turns[0].stats.cli?.catalog === x.turns[0].stats.cli.catalog, { what: 'saved' });
});

test('codex without `debug models`, or with garbage from it: no catalog, no error, no line', { concurrency: false }, async (t) => {
  t.after(() => FAKE.forEach((k) => delete process.env[k]));
  for (const [key, value] of [['FAKE_CODEX_NO_DEBUG', '1'], ['FAKE_CODEX_CATALOG', 'bad']]) {
    process.env[key] = value;
    const s = await launch('codex');
    await turnsDone(s.id, 1);
    const x = await landed(s.id, 0, 'version'); // the probe is over: the version came in the same event
    assert.equal(x.turns[0].status, 'done');
    assert.equal(x.turns[0].stats.cli.catalog, undefined);
    assert.deepEqual(x.turns[0].activity.filter((a) => /debug|catalog/i.test(a.label || '')), [], 'not a line in the task');
    delete process.env[key];
  }
});

test('the account reaches the probe: its CODEX_HOME, and stats.cli names it', { concurrency: false }, async () => {
  const s = await launch('codex', { account: 'pers' });
  await turnsDone(s.id, 1);
  const x = await landed(s.id, 0, 'catalog');
  assert.equal(x.turns[0].stats.cli.account, 'pers');
  const run = records(RECORD, 'codex').at(-1);
  assert.ok(run.codexHome, 'the run has its account folder');
  assert.ok(records(RECORD, 'codex-debug').some((r) => r.codexHome === run.codexHome), 'the probe ran in the same one');
});

test('a late probe on a turn with no stats does nothing', { concurrency: false }, async (t) => {
  const real = adapters.codex.run;
  t.after(() => (adapters.codex.run = real));
  let late;
  adapters.codex.run = ({ onEvent }) => {
    late = () => onEvent({ type: 'cli', version: '1.0.0', catalog: 'abc' });
    onEvent({ type: 'result', isError: true, text: 'it died' }); // no stats, as a run that never reported
    return { done: Promise.resolve(), stop() {} };
  };
  const s = await launch('codex');
  await turnsDone(s.id, 1);
  await sleep(50); // the run has been let go of
  late();
  assert.equal((await api(`/sessions/${s.id}`)).turns[0].stats, null);
});

test('another harness: the version detect saw, nothing else', { concurrency: false }, async () => {
  const s = await launch('opencode');
  const x = await turnsDone(s.id, 1);
  assert.deepEqual(x.turns[0].stats.cli, { version: '1.99.0' });
});

test('a shared task keeps what the CLI was, not which of your logins ran it', () => {
  const stats = (cli) => shareTurn({ id: 't', prompt: 'x', stats: { costUsd: 1, cli } }).stats;
  assert.deepEqual(stats({ version: '2.1.3', account: 'pers' }), { costUsd: 1, cli: { version: '2.1.3' } });
  assert.deepEqual(stats({ account: 'pers' }), { costUsd: 1 });
  assert.deepEqual(stats(undefined), { costUsd: 1 });
});
