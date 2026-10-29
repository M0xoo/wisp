// Auto's steps around a run (server/pipeline.js): escalation to a stronger pick, moving on at a
// limit, best-of-2 with a judge, and the scout. server/check.js is what a goal check runs.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { installFakeBins, records, tmp, until } from './helpers.js';

const { parseResults, detectTests, check } = await import('../server/check.js');
const { readJson } = await import('../server/quick.js');
const { tierOf } = await import('../server/router.js');
const { scoutNote } = await import('../server/scout.js');

test('parseResults reads failing tests and counts from the usual reporters', () => {
  const node = parseResults('▶ math\n  ✔ adds (0.4ms)\n  ✖ subtracts (1.2ms)\n✖ keeps order (2ms)\nℹ tests 3\nℹ pass 1\nℹ fail 2\n✖ failing tests:\n');
  assert.deepEqual(node.failed, ['subtracts', 'keeps order']);
  assert.equal(node.passed, 1);
  assert.equal(node.failedCount, 2);
  assert.deepEqual(parseResults('ok 1 - a\nnot ok 2 - b # TODO\n# pass 1\n# fail 1').failed, ['b']);
  const py = parseResults('FAILED tests/test_x.py::test_a - assert 1 == 2\nERROR tests/test_y.py::test_b\n===== 2 failed, 40 passed, 1 skipped in 1.20s =====');
  assert.deepEqual(py.failed, ['tests/test_x.py::test_a', 'tests/test_y.py::test_b']);
  assert.deepEqual([py.passed, py.failedCount, py.skipped], [40, 2, 1]);
  assert.deepEqual(parseResults('  ✕ renders the button (12 ms)\nTests:       1 failed, 12 passed, 13 total').failed, ['renders the button']);
  assert.deepEqual(parseResults('--- FAIL: TestAdd (0.00s)\nFAIL').failed, ['TestAdd']);
  assert.deepEqual(parseResults('test math::adds ... FAILED\ntest result: FAILED. 3 passed; 1 failed;').failed, ['math::adds']);
});

test('detectTests finds the command, and a project can override or turn it off', () => {
  const dir = tmp('detect');
  assert.equal(detectTests(dir), null);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
  assert.equal(detectTests(dir), null, 'npm init placeholder is not a test suite');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  assert.equal(detectTests(dir).command, 'npm test');
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
  assert.equal(detectTests(dir).command, 'pnpm test');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' }, devDependencies: { jest: '1' } }));
  assert.match(detectTests(dir).skip, /not installed/);
  assert.equal(detectTests(dir, { testCommand: 'make check' }).command, 'make check');
  assert.match(detectTests(dir, { testCommand: 'off' }).skip, /off/);
  const go = tmp('detect-go');
  fs.writeFileSync(path.join(go, 'go.mod'), 'module x');
  assert.equal(detectTests(go).command, 'go test ./...');
  const py = tmp('detect-py');
  fs.writeFileSync(path.join(py, 'pyproject.toml'), '[tool.pytest.ini_options]\n');
  assert.match(detectTests(py).command, /-m pytest/);
});

// A repo whose tests run with node --test: `adds` fails on the base (the add bug), `stays negative`
// passes on the base and fails once add is fixed.
function testRepo({ keepsBug = false } = {}) {
  const dir = tmp('check-repo');
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'wisp test');
  fs.writeFileSync(path.join(dir, 'math.js'), 'export function add(a, b) {\n  return a - b;\n}\n');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test --test-reporter=spec' } }));
  fs.mkdirSync(path.join(dir, 'test'));
  fs.writeFileSync(
    path.join(dir, 'test', 'math.test.js'),
    `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../math.js';\ntest('adds', () => assert.equal(add(2, 3), 5));\n${keepsBug ? "test('stays negative', () => assert.equal(add(2, 3), -1));\n" : ''}`,
  );
  git('add', '.');
  git('commit', '-qm', 'init');
  return dir;
}

test('check: only failures that are new count; a base that fails the same way is fine', async () => {
  const dir = testRepo({ keepsBug: true });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
  const wt = { root: dir, head, path: dir, cwd: dir };
  // Untouched: `adds` fails, but it failed on the base too.
  let r = await check({ dir, worktree: wt });
  assert.equal(r.verdict, 'pass', JSON.stringify(r));
  assert.match(r.note, /base commit too/);
  // Fixing add breaks `stays negative`, which passed before: that's on the change.
  fs.writeFileSync(path.join(dir, 'math.js'), 'export function add(a, b) {\n  return a + b;\n}\n');
  r = await check({ dir, worktree: wt });
  assert.equal(r.verdict, 'fail');
  assert.deepEqual(r.newFailures, ['stays negative']);
  assert.equal(r.command, 'npm test');
  assert.equal((await check({ dir: tmp('empty') })).verdict, 'skip');
});

test('readJson pulls the object out of chatty replies; scoutNote tells the agent what was found', () => {
  assert.deepEqual(readJson('Sure! {"winner": "B", "why": "smaller {diff}"} hope that helps'), { winner: 'B', why: 'smaller {diff}' });
  assert.equal(readJson('no json'), null);
  const note = scoutNote({ files: ['src/a.js'], testCommand: 'npm test', notes: 'Uses ESM.' });
  assert.match(note, /Scouted by wisp[\s\S]*`src\/a.js`[\s\S]*`npm test`[\s\S]*Uses ESM/);
  assert.equal(scoutNote(null), '');
});

// --- through the server, with the fake harnesses ---------------------------------------------

const RECORD = tmp('pipe-record');
process.env.FAKE_RECORD = RECORD;
process.env.WISP_HOME = tmp('pipe-home');
process.env.WISP_UPDATE_CHECK = '0';
installFakeBins();
const { startServer } = await import('../server/index.js');
let srv;
let base;
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
async function api(p, body, method) {
  const r = await fetch(`${base}/api${p}`, { method: method || (body ? 'POST' : 'GET'), headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(`${p}: ${j.error}`);
  return j;
}
const settledAll = (ids) =>
  until(
    async () => {
      const all = await Promise.all(ids.map((id) => api(`/sessions/${id}`)));
      return all.every((x) => x.state === 'review' && !x.auto?.busy) && all;
    },
    { timeout: 60_000 },
  );
before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  srv = await startServer({ port, handleSignals: false });
  await api('/router', { allowed: ['claude'], scout: 'off' }, 'PATCH');
});
after(() => {
  srv.shutdown();
  srv.server.closeAllConnections?.();
  srv.server.close();
});

test('the agent finishes: wisp runs no tests of its own, and the task lands in review', async () => {
  const cwd = testRepo({ keepsBug: true });
  const s = await api('/sessions', { prompt: 'fix the add bug', cwd, agent: 'auto', mode: 'edits' });
  const [done] = await settledAll([s.id]);
  assert.equal(done.turns.length, 1, 'no repair round');
  assert.equal(done.auto.escalatedTo, undefined, 'failing tests are not a hand-over');
  assert.equal(done.auto.checks, undefined);
  assert.ok(!done.turns[0].presentation.blocks.some((b) => b.by === 'wisp'), 'no tests block or callout from wisp');
  assert.ok(!done.turns[0].activity.some((a) => a.by === 'wisp'));
  const sum = (await api('/sessions')).find((x) => x.id === s.id);
  assert.equal(sum.auto.check, undefined);
  assert.equal(sum.auto.repairs, undefined);
});

test('a run that errors goes to a stronger pick, next to the first run', async () => {
  process.env.FAKE_FAIL = '1';
  try {
    const s = await api('/sessions', { prompt: 'fix the add bug', cwd: testRepo(), agent: 'auto', mode: 'edits' });
    const first = await until(async () => {
      const x = await api(`/sessions/${s.id}`);
      return x.auto?.escalatedTo && x.state === 'review' && !x.auto.busy && x;
    }, { timeout: 60_000 });
    assert.equal(first.auto.reason, 'error');
    const [sib] = await settledAll([first.auto.escalatedTo]);
    assert.equal(sib.groupId, first.groupId);
    assert.equal(sib.auto.escalatedFrom, s.id);
    assert.notEqual(sib.worktree.path, first.worktree.path);
    assert.notEqual(`${sib.agent}:${sib.model}:${sib.effort}`, `${first.agent}:${first.model}:${first.effort}`);
    assert.equal(sib.auto.escalatedTo, undefined, 'escalates once');
    assert.equal((await api('/router')).recent.find((x) => x.id === s.id).r, 0);
  } finally {
    delete process.env.FAKE_FAIL;
  }
});

test('Best of two is off by default: the Best goal runs once', async () => {
  assert.equal((await api('/router')).settings.best2, false);
  const s = await api('/sessions', { prompt: 'fix the add bug', cwd: testRepo(), agent: 'auto', model: 'best', mode: 'edits' });
  assert.equal(s.group, undefined);
  await settledAll([s.id]);
});

test('Best goal: two frontier picks side by side, and wisp marks the better one', async () => {
  await api('/router', { best2: true }, 'PATCH');
  // Claude alone has one frontier model (Opus): Best runs it alone rather than add Sonnet.
  const solo = await api('/sessions', { prompt: 'fix the add bug', cwd: testRepo(), agent: 'auto', model: 'best', mode: 'edits' });
  assert.equal(solo.group, undefined);
  assert.equal(`${solo.agent}:${solo.model}`, 'claude:opus');
  await settledAll([solo.id]);
  await api('/router', { allowed: ['claude', 'codex'] }, 'PATCH');
  try {
    const cwd = testRepo();
    const s = await api('/sessions', { prompt: 'fix the add bug', cwd, agent: 'auto', model: 'best', mode: 'edits' });
    const runs = s.group;
    assert.equal(runs?.length, 2);
    assert.notEqual(`${runs[0].agent}:${runs[0].model}`, `${runs[1].agent}:${runs[1].model}`);
    for (const r of runs) assert.equal(tierOf(`${r.agent}:${r.model}`), 3, `${r.agent}:${r.model} is frontier`);
    const done = await until(async () => {
      const all = await Promise.all(runs.map((r) => api(`/sessions/${r.id}`)));
      return all.every((x) => typeof x.auto.pick?.winner === 'boolean') && all;
    }, { timeout: 60_000 });
    assert.deepEqual(done.map((x) => x.auto.strategy), ['best2', 'best2']);
    assert.equal(done.filter((x) => x.auto.pick.winner).length, 1);
    assert.ok(done[0].auto.pick.why);
  } finally {
    await api('/router', { allowed: ['claude'], best2: false }, 'PATCH');
  }
});

test('the scout: the project scan reaches the agent, and settings round-trip', async () => {
  const r = await api('/router', { scout: 'big' }, 'PATCH');
  assert.equal(r.settings.scout, 'big');
  assert.equal(r.settings.check, undefined);
  const cwd = testRepo();
  await api('/projects', { path: cwd });
  const p = (await api('/router')).projects.find((x) => x.name === path.basename(cwd));
  assert.ok(p, 'detected test command listed per project');
  await api(`/projects/${p.id}`, { testCommand: 'npm test -- --test-name-pattern=adds' }, 'PATCH');
  assert.equal((await api('/router')).projects.find((x) => x.id === p.id).testCommand, 'npm test -- --test-name-pattern=adds');
  const s = await api('/sessions', { prompt: 'fix the add bug', cwd, agent: 'auto', mode: 'edits' });
  const [done] = await settledAll([s.id]);
  assert.equal(done.scout.testCommand, 'npm test -- --test-name-pattern=adds');
  const sys = records(RECORD, 'claude').map((x) => x.argv[x.argv.indexOf('--append-system-prompt') + 1]).filter(Boolean);
  assert.ok(sys.some((x) => /Scouted by wisp[\s\S]*test-name-pattern=adds/.test(x)), 'the agent is told how to test');
});

test('a usage limit moves the task: the harness cools down, the run is not held against it', async () => {
  const marker = path.join(tmp('limit'), 'hit');
  process.env.FAKE_LIMIT_ONCE = marker;
  await api('/router', { allowed: ['claude', 'codex'], scout: 'off' }, 'PATCH');
  try {
    const s = await api('/sessions', { prompt: 'fix the add bug', cwd: testRepo(), agent: 'auto', mode: 'edits' });
    const first = await until(async () => {
      const x = await api(`/sessions/${s.id}`);
      return x.auto?.escalatedTo && x.state === 'review' && !x.auto.busy && x;
    }, { timeout: 60_000 });
    assert.equal(first.auto.reason, 'limit');
    assert.equal(first.unread, false, 'the moved run settles quietly; the new one will notify');
    const [moved] = await settledAll([first.auto.escalatedTo]);
    assert.notEqual(moved.agent, first.agent, 'the whole harness is at its limit, not just one model');
    assert.equal(moved.auto.reason, 'limit');
    const r = await api('/router');
    assert.equal(r.recent.find((x) => x.id === s.id).r, null, 'not counted as a failure');
    assert.ok(r.arms.filter((a) => a.agent === first.agent).every((a) => a.state === 'cooling'));
    // While it cools down, Auto doesn't pick it.
    const next = await api('/sessions', { prompt: 'fix the add bug', cwd: testRepo(), agent: 'auto', mode: 'edits' });
    assert.notEqual(next.agent, first.agent);
    await settledAll([next.id]);
  } finally {
    delete process.env.FAKE_LIMIT_ONCE;
    await api('/router', { allowed: ['claude'] }, 'PATCH');
  }
});
