// A failed run's screen (server/runner.js, R.terminal in web/js/blocks.js): the hero gives the real
// reason, it reads at once, and wisp's own failure blocks offer no Run for a command that was never
// run. Run on those started the harness in the task's folder, maybe a billed run with the prompt `run`.

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { installFakeBins, makeRepo, tmp, until } from './helpers.js';
import { haltOf, STATUS_LABEL, statusKey } from '../web/js/core/format.js';

process.env.WISP_HOME = tmp('failure-wisp');
process.env.WISP_UPDATE_CHECK = '0';
process.env.CLAUDE_CONFIG_DIR = tmp('failure-claude-home');
process.env.CODEX_HOME = tmp('failure-codex-home');
installFakeBins();

// The stub DOM's own: each template's markup, and the classes the renderer sets on it.
const made = [];
const stub = () => {
  const n = {
    classes: new Set(), dataset: {}, style: { setProperty() {} }, textContent: '',
    classList: { add: (c) => n.classes.add(c), contains: (c) => n.classes.has(c), toggle() {} },
    append() {}, prepend() {}, before() {}, addEventListener() {},
    querySelector: (q) => (n.html?.includes(q.slice(1)) ? (n[q] ||= stub()) : null),
    querySelectorAll: () => [],
  };
  return n;
};
const body = stub();
globalThis.document = {
  body, documentElement: stub(), activeElement: body, querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
  createElement: () => {
    const first = stub();
    return { ...stub(), set innerHTML(html) { first.html = html; made.push(first); }, content: { firstElementChild: first } };
  },
};
globalThis.addEventListener = () => {};
globalThis.location = new URL('http://localhost/');
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
if (!globalThis.navigator) globalThis.navigator = { platform: '', userAgent: '' }; // Node 20

const { renderPresentation } = await import('../web/js/blocks.js');
const { blocksToMarkdown } = await import('../server/render.js');
const { startServer } = await import('../server/index.js');

const terminal = (block, ctx = {}) => {
  made.length = 0;
  renderPresentation({ blocks: [block] }, { exec: async () => {}, ...ctx });
  return made.find((n) => n.html.includes('b-term'));
};
const RUN = 'term-run';

test('a real command keeps Run, and still types itself out', () => {
  const n = terminal({ type: 'terminal', command: 'npm test', output: '1 failing', exitCode: 1 }, { session: { agent: 'claude' }, turn: { agent: 'claude' } });
  assert.match(n.html, new RegExp(RUN));
  assert.equal(n.classes.has('ran'), false);
});

test('a block with no command has no Run, no empty prompt, and its output shows at once', () => {
  const n = terminal({ type: 'terminal', output: 'fake: not logged in (401)', exitCode: 1 });
  assert.doesNotMatch(n.html, new RegExp(RUN));
  assert.doesNotMatch(n.html, /class="ps"/);
  assert.equal(n.classes.has('ran'), true);
});

test('a failure stored before this has no Run for its made-up command either', () => {
  const stored = { type: 'terminal', command: 'claude run', output: 'fake: not logged in (401)', exitCode: 1 };
  const n = terminal(stored, { session: { agent: 'claude' }, turn: {} });
  assert.doesNotMatch(n.html, new RegExp(RUN));
  assert.equal(n.classes.has('ran'), true);
  // A turn handed to another harness made up that harness's name.
  assert.doesNotMatch(terminal({ ...stored, command: 'codex run' }, { session: { agent: 'claude' }, turn: { agent: 'codex' } }).html, new RegExp(RUN));
  assert.match(terminal({ ...stored, command: 'codex run' }, { session: { agent: 'claude' }, turn: { agent: 'claude' } }).html, new RegExp(RUN), 'not that task’s harness');
});

test('a report in text has no empty prompt for a block with no command', () => {
  assert.doesNotMatch(blocksToMarkdown([{ type: 'terminal', output: 'fake: not logged in (401)', exitCode: 1 }]), /\$/);
  assert.match(blocksToMarkdown([{ type: 'terminal', command: 'npm test', output: 'ok', exitCode: 0 }]), /\$ npm test/);
});

let srv, base, repo;
const api = async (p, b) => (await fetch(`${base}/api${p}`, { method: b ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: b && JSON.stringify(b) })).json();
const failed = async (agent = 'claude') => {
  const s = await api('/sessions', { prompt: 'fix the add bug please', cwd: repo, agent, worktree: false });
  return until(async () => {
    const x = await api(`/sessions/${s.id}`);
    return x.state === 'review' && x.turns.at(-1).status !== 'running' && x;
  }, { timeout: 30_000 });
};
const { shareTurn } = await import('../server/services/share.js');
const block = (s, type) => s.turns.at(-1).presentation.blocks.find((b) => b.type === type);
const rowOf = async (s) => (await api('/sessions')).find((x) => x.id === s.id);

before(async () => {
  repo = makeRepo();
  const port = await new Promise((resolve) => {
    const n = net.createServer();
    n.listen(0, () => {
      const { port: free } = n.address();
      n.close(() => resolve(free));
    });
  });
  srv = await startServer({ port, handleSignals: false });
  base = srv.url;
});
after(() => {
  srv.shutdown();
  srv.server.closeAllConnections?.();
  srv.server.close();
});
afterEach(() => {
  for (const k of ['FAKE_FAIL', 'FAKE_LIMIT_ONCE', 'FAKE_LIMIT_TEXT']) delete process.env[k];
});

test('a failed run: the hero gives the first line of the error, and the terminal invents no command', async () => {
  process.env.FAKE_FAIL = '1';
  const s = await failed();
  const hero = block(s, 'hero');
  assert.equal(hero.title, 'Claude Code failed');
  assert.equal(hero.summary, 'fake: not logged in (401)');
  const t = block(s, 'terminal');
  assert.equal(t.command, undefined);
  assert.match(t.output, /not logged in/);
  assert.deepEqual(block(s, 'next').items.slice(0, 1), ['Try again']);
  const row = await rowOf(s);
  assert.equal(row.status, 'blocked', 'spells and panes keep reading status');
  assert.equal(row.halt, 'failed');
});

test('the limit and device-limit cards invent no command', async () => {
  process.env.FAKE_LIMIT_ONCE = path.join(tmp('failure-limit'), 'hit');
  const limited = await failed();
  assert.ok(limited.turns.at(-1).limit, 'a limit card');
  assert.equal((await rowOf(limited)).halt, 'limit');
  assert.equal(block(limited, 'terminal').command, undefined);

  process.env.FAKE_LIMIT_ONCE = path.join(tmp('failure-devices'), 'hit');
  process.env.FAKE_LIMIT_TEXT = 'Too many active sessions: you are signed in on too many devices.';
  const devices = await failed('codex');
  assert.match(block(devices, 'hero').title, /too many devices/);
  assert.equal((await rowOf(devices)).halt, 'refused');
  assert.equal(block(devices, 'terminal').command, undefined);
});

test('a blocked row says which: Failed, At limit, Refused, and Blocked only for the agent\'s own', () => {
  const word = (turn) => {
    const key = statusKey({ status: 'blocked', halt: haltOf(turn) });
    return [key, STATUS_LABEL[key]];
  };
  assert.deepEqual(word({ status: 'error' }), ['failed', 'Failed']);
  assert.deepEqual(word({ status: 'error', limit: { until: 1 } }), ['limit', 'At limit']);
  assert.deepEqual(word({ status: 'done', refusal: { kind: 'policy' } }), ['refused', 'Refused']);
  assert.deepEqual(word({ status: 'error', devices: true }), ['refused', 'Refused']);
  assert.deepEqual(word({ status: 'done' }), ['blocked', 'Blocked']);
  assert.equal(statusKey({ status: 'done', halt: 'failed' }), 'done', 'a word only ever replaces Blocked');
});

test('a shared turn keeps the word', () => {
  assert.equal(shareTurn({ id: 't', prompt: 'x', status: 'error', limit: { until: 1 } }).halt, 'limit');
  assert.equal(shareTurn({ id: 't', prompt: 'x', status: 'done' }).halt, undefined);
});
