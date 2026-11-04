// /side side discussions (server/side.js, server/side-gate.js, services/fork.js side) through a real
// wisp server: a task of its own in the main task's folder, that hears the main task's latest state
// with every message and is linked both ways. It runs commands and edits behind a clash check, or
// stays read-only on a harness that can't ask before a write. Plus the command in the page.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { installFakeBins, makeRepo, records, same, tmp, until } from './helpers.js';

const RECORD = tmp('side-record');
process.env.FAKE_RECORD = RECORD;
process.env.WISP_HOME = tmp('side-home');
process.env.WISP_UPDATE_CHECK = '0';
installFakeBins();

const { startServer } = await import('../server/index.js');
const { sideAsk, sidePrompt, parseHunks, editLines, mainChanges, clashCheck, commandClash, addOwn, SIDE_APPLY, SIDE_KEEP } = await import('../server/side.js');
const { adapters } = await import('../server/adapters/index.js');
const page = await import('../web/js/slash-text.js');

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
  return { status: r.status, json: await r.json() };
}
async function api(p, body, method) {
  const { status, json } = await call(p, body, method);
  if (status >= 400) throw new Error(`${p}: ${json.error}`);
  return json;
}
const settled = (id, n) =>
  until(async () => {
    const x = await api(`/sessions/${id}`);
    return x.turns.length === n && x.state === 'review' && x;
  });
const runs = () => records(RECORD, 'claude').filter((r) => !r.stdin.startsWith('# wisp retro'));
const flag = (r, f) => r.argv[r.argv.indexOf(f) + 1];

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  srv = await startServer({ port, handleSignals: false });
});
after(() => {
  srv.shutdown();
  srv.server.closeAllConnections?.();
  srv.server.close();
});

test('sideAsk reads "/side …" on the server and in the page alike; the / menu offers it in a follow-up only', () => {
  for (const f of [sideAsk, page.sideAsk]) {
    assert.equal(f('/side why sqlite?'), 'why sqlite?');
    assert.equal(f('  /SIDE  review it\n'), 'review it');
    assert.equal(f('/side'), '');
    assert.equal(f('/sidebar'), null);
    assert.equal(f('a /side'), null);
  }
  assert.deepEqual(page.slashMatches('/si').map((c) => c.name), ['side']);
  assert.ok(!page.HOME_SLASH.some((c) => c.name === 'side'), 'the new-task box has no task to talk over');
});

test('sidePrompt: the main task as it stands now, then the message; a deleted one says so', () => {
  const main = { title: 'Fix login', agent: 'claude', turns: [{ id: 'a', prompt: 'fix the login bug', status: 'running', startedAt: Date.now(), activity: [{ kind: 'edit', label: 'Edited auth.js' }], changes: [{ file: 'auth.js' }] }] };
  const p = sidePrompt(main, 'why that way?', () => 'Claude');
  assert.match(p, /## The main task now: “Fix login”[\s\S]*still running[\s\S]*Edited auth\.js[\s\S]*`auth\.js`[\s\S]*## The user, in this side discussion\n\nwhy that way\?/);
  assert.match(sidePrompt(null, 'hi'), /main task was deleted/);
});

test('a side discussion works in the main task’s folder behind the gate, hears its latest state every message, and is linked both ways', async () => {
  const repo = makeRepo();
  const s = await api('/sessions', { prompt: 'fix add() please', cwd: repo, agent: 'claude', mode: 'auto', worktree: true });
  const main = await settled(s.id, 1);

  const side = await api(`/sessions/${s.id}/side`, { text: '/side why did it do it that way?' });
  assert.equal(side.sideOf.id, s.id);
  assert.equal(side.sideOf.title, main.title);
  assert.equal(side.mode, 'edits');
  assert.equal(side.sideOf.edits, true);
  let full = await settled(side.id, 1);
  assert.equal(full.worktree, undefined, 'no work of its own');
  assert.equal(full.turns[0].checkpoint, null);
  assert.equal(full.turns[0].prompt, 'why did it do it that way?');
  let r = runs().at(-1);
  assert.ok(same(r.cwd, main.worktree.path), 'it works in the main task’s folder');
  assert.equal(flag(r, '--permission-mode'), 'default', 'acceptEdits would write without asking the gate');
  assert.equal(flag(r, '--permission-prompt-tool'), 'mcp__wisp__approve');
  assert.match(flag(r, '--settings'), /"ask":\[[^\]]*"Edit"/, 'your allow rules can’t skip the gate');
  assert.match(flag(r, '--append-system-prompt'), /# wisp side discussion[\s\S]*clash/);
  assert.match(flag(r, '--mcp-config'), /"WISP_READONLY":"1"/, 'wisp’s tools that act are left out');
  assert.match(r.stdin, /## The main task now: “[^”]+”[\s\S]*fix add\(\) please[\s\S]*## The user, in this side discussion\n\nwhy did it do it that way\?/);
  assert.deepEqual((await api(`/sessions/${s.id}`)).sides, [side.id]);
  assert.deepEqual((await api('/sessions')).find((x) => x.id === s.id).sides, [side.id]);
  assert.ok(!(await api('/projects').catch(() => [])).some?.((p) => same(p.path, main.worktree.path)), 'the worktree isn’t made a project');

  // The main task moves on: the side discussion's next message hears it. A mode switch is ignored.
  await api(`/sessions/${s.id}/reply`, { text: 'now add tests too' });
  await settled(s.id, 2);
  await api(`/sessions/${side.id}/reply`, { text: 'and the tests?', mode: 'auto' });
  full = await settled(side.id, 2);
  assert.equal(full.mode, 'edits');
  r = runs().at(-1);
  assert.equal(flag(r, '--permission-mode'), 'default');
  assert.match(r.stdin, /now add tests too[\s\S]*## The user, in this side discussion\n\nand the tests\?/);

  // /side in the main task's follow-up box starts another; in a side discussion it's refused.
  const again = await api(`/sessions/${s.id}/reply`, { text: '/side review the tests' });
  assert.equal(again.side.sideOf.id, s.id);
  await settled(again.side.id, 1);
  assert.equal((await call(`/sessions/${side.id}/side`, { text: 'deeper' })).status, 409);
  assert.equal((await call(`/sessions/${side.id}/fork`, { prompt: 'x' })).status, 409, 'no work of its own to fork');
  assert.equal((await call(`/sessions/${side.id}/reply`, { text: '/goal tests pass' })).status, 409, 'a goal belongs on the main task');
  assert.equal((await call(`/sessions/${s.id}/side`, { text: '/side' })).status, 400);
});

test('every lean setting keeps a side discussion behind the gate, with its tools', async () => {
  const gated = (r) => {
    assert.equal(flag(r, '--permission-mode'), 'default', 'acceptEdits would write without asking the gate');
    assert.equal(flag(r, '--permission-prompt-tool'), 'mcp__wisp__approve');
    assert.deepEqual(JSON.parse(flag(r, '--settings')).permissions.ask, ['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash']);
    assert.match(flag(r, '--append-system-prompt'), /# wisp side discussion/, 'Claude Code’s prompt stays: this isn’t the retro’s --system-prompt');
    assert.match(flag(r, '--mcp-config'), /"wisp"/, 'the approve tool’s server');
    for (const dropped of ['--tools', '--strict-mcp-config', '--disable-slash-commands', '--system-prompt']) assert.ok(!r.argv.includes(dropped), `${dropped} would disarm the side`);
  };
  const repo = makeRepo();
  const s = await api('/sessions', { prompt: 'fix add() please', cwd: repo, agent: 'claude', mode: 'auto' });
  await settled(s.id, 1);
  try {
    for (const [leanRuns, nonessential] of [['off', undefined], ['on', undefined], ['all', '1']]) {
      await api('/config', { defaults: { leanRuns } }, 'PATCH');
      const side = await api(`/sessions/${s.id}/side`, { text: `/side lean ${leanRuns}?` });
      assert.equal(side.mode, 'edits');
      await settled(side.id, 1);
      const r = runs().at(-1);
      gated(r);
      assert.equal(r.nonessential, nonessential, `leanRuns ${leanRuns}`);
    }
    // A task's own choice wins over the setting, and is no way round the gate either.
    await api('/config', { defaults: { leanRuns: 'off' } }, 'PATCH');
    const side = await api(`/sessions/${s.id}/side`, { text: '/side my own lean?' });
    await settled(side.id, 1);
    await api(`/sessions/${side.id}`, { lean: 'on' }, 'PATCH');
    await api(`/sessions/${side.id}/reply`, { text: 'again' });
    await settled(side.id, 2);
    gated(runs().at(-1));
    assert.equal(runs().at(-1).nonessential, '1');

    // And the gate still decides on a lean run: a clash is a card, and nothing is written.
    await api('/config', { defaults: { leanRuns: 'all' } }, 'PATCH');
    const { id, dir } = await mainTask();
    const was = edited(dir, 'math.js');
    const clash = await api(`/sessions/${id}/side`, { text: 'SIDEEDIT math.js|return a + b;|return b + a;' });
    const held = await asking(clash.id);
    assert.equal(runs().at(-1).nonessential, '1');
    await api(`/sessions/${clash.id}/clash`, { askId: held.ask.id, action: 'keep' });
    await settled(clash.id, 1);
    assert.equal(edited(dir, 'math.js'), was, 'nothing written');
  } finally {
    await api('/config', { defaults: { leanRuns: 'on' } }, 'PATCH');
  }
});

test('the tour, unknown harnesses and bare messages are refused', async () => {
  const repo = makeRepo();
  const s = await api('/sessions', { prompt: 'hi', cwd: repo, agent: 'claude' });
  await settled(s.id, 1);
  assert.equal((await call(`/sessions/${s.id}/side`, { text: '  ' })).status, 400);
  assert.equal((await call(`/sessions/${s.id}/side`, { text: 'x', agent: 'nope' })).status, 400);
  assert.equal((await call('/sessions/nope/side', { text: 'x' })).status, 404);
});

test('wisp’s MCP server in a side discussion offers only the tools that read, and refuses the rest', async () => {
  const { spawn } = await import('node:child_process');
  const ask = (env, lines) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, ['server/mcp-ask.js'], { env: { ...process.env, WISP_URL: 'http://127.0.0.1:9', WISP_TOKEN: 't', WISP_SESSION: 's', ...env } });
      // stdout arrives in chunks that can split a line (macOS, Node 20): parse only whole lines,
      // and only once, since more chunks can land after the kill.
      let out = '';
      let done = false;
      p.stdout.on('data', (d) => {
        if (done) return;
        out += d;
        const whole = out.split('\n').slice(0, -1).filter((l) => l.trim());
        if (whole.length < lines.length) return;
        done = true;
        p.kill();
        resolve(whole.map((l) => JSON.parse(l)));
      });
      p.stdin.write(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    });
  const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  const launch = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'wisp_launch', arguments: { prompt: 'x' } } };
  const [ro, refused] = await ask({ WISP_READONLY: '1' }, [list, launch]);
  const names = ro.result.tools.map((t) => t.name);
  for (const n of ['ask_user', 'wisp_session', 'wisp_sessions', 'wisp_blocks']) assert.ok(names.includes(n), n);
  for (const n of ['wisp_launch', 'wisp_task', 'delegate', 'wisp_crew_edit', 'wisp_save', 'wisp_pr', 'wisp_connector_add']) assert.ok(!names.includes(n), n);
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.content[0].text, /side discussion/);
  const [all] = await ask({}, [list]);
  assert.ok(all.result.tools.some((t) => t.name === 'wisp_launch'), 'other tasks keep every tool');
});

test('what the main task owns stays refused on a side discussion; queued follow-ups stay behind the gate', async () => {
  const repo = makeRepo();
  const s = await api('/sessions', { prompt: 'fix add() please', cwd: repo, agent: 'claude', mode: 'auto', worktree: true });
  await settled(s.id, 1);
  const side = await api(`/sessions/${s.id}/side`, { text: 'what changed?' });
  await settled(side.id, 1);
  for (const [p, body, method] of [
    [`/sessions/${side.id}/changes/revert`, { path: 'math.js' }],
    [`/sessions/${side.id}/changes/stage`, { path: 'math.js' }],
    [`/sessions/${side.id}/changes/commit`, { message: 'x' }],
    [`/sessions/${side.id}/source`, { path: 'math.js', text: 'x' }, 'PUT'],
    [`/sessions/${side.id}/ship`, {}],
    [`/sessions/${side.id}/merge`, {}],
    [`/sessions/${side.id}/exec`, { command: 'touch nope' }],
    [`/sessions/${side.id}/rollback`, { restore: false }],
    [`/sessions/${side.id}/takeover`, { inline: true }],
  ]) {
    const r = await call(p, body, method);
    assert.equal(r.status, 409, p);
    assert.match(r.json.error, /Do it on the main task/, p);
  }
  // A follow-up queued behind a running turn, with a mode, still runs behind the gate.
  process.env.FAKE_DELAY = '600';
  await api(`/sessions/${side.id}/reply`, { text: 'first' });
  await api(`/sessions/${side.id}/reply`, { text: 'second', queue: true, mode: 'auto' });
  delete process.env.FAKE_DELAY;
  await settled(side.id, 3);
  assert.deepEqual(runs().slice(-2).map((r) => flag(r, '--permission-mode')), ['default', 'default']);
  assert.equal((await api(`/sessions/${side.id}`)).turns.at(-1).mode, 'edits');
});

test('deleting a side discussion takes it off its main task; deleting the main task leaves it to read what was said', async () => {
  const repo = makeRepo();
  const s = await api('/sessions', { prompt: 'fix add() please', cwd: repo, agent: 'claude', worktree: true });
  await settled(s.id, 1);
  const a = await api(`/sessions/${s.id}/side`, { text: 'one' });
  const b = await api(`/sessions/${s.id}/side`, { text: 'two' });
  await settled(a.id, 1);
  await settled(b.id, 1);
  await api(`/sessions/${a.id}`, {}, 'DELETE');
  assert.deepEqual((await api(`/sessions/${s.id}`)).sides, [b.id]);
  await api(`/sessions/${s.id}`, {}, 'DELETE');
  const left = await api(`/sessions/${b.id}`);
  assert.equal(left.sideOf.id, s.id);
  const r = await call(`/sessions/${b.id}/reply`, { text: 'still there?' });
  assert.equal(r.status, 409, 'its folder went with the main task');
  assert.match(r.json.error, /folder is gone/);
});

// --- the clash check -----------------------------------------------------------------------------

const file = 'one\ntwo\nthree\nfour\nfive\nsix\n';
const hunk = (from, to, gone = []) => ({ from, to, gone });

test('parseHunks reads git diff -U0 in the file as it is now; a pure deletion is a gap', () => {
  const diff = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -2 +2 @@ fn\n-two\n+TWO\n@@ -4,2 +3,0 @@\n-gone1\n-gone2\n@@ -9,0 +8,3 @@\n+a\n+b\n+c\n';
  assert.deepEqual(parseHunks(diff), [hunk(2, 2, ['two']), hunk(4, 3, ['gone1', 'gone2']), hunk(8, 10)]);
  assert.deepEqual(parseHunks(''), []);
});

test('editLines finds the lines an Edit touches, every match; not found is null', () => {
  assert.deepEqual(editLines(file, 'three'), [[3, 3]]);
  assert.deepEqual(editLines(file, 'two\nthree\n'), [[2, 3]]);
  assert.deepEqual(editLines('a\nb\na\n', 'a'), [[1, 1], [3, 3]]);
  assert.equal(editLines(file, 'nope'), null);
  assert.equal(editLines(file, ''), null);
  assert.equal(editLines(null, 'one'), null);
  assert.deepEqual(editLines('one\r\ntwo\r\n', 'two'), [[2, 2]]);
});

test('clashCheck: none when main hasn’t touched the file, overlap on other lines, clash on the same lines', () => {
  const check = (main, edit) => clashCheck({ content: file, main, tool: 'Edit', ...edit });
  assert.equal(check(null, { old: 'nope' }).level, 'none', 'main never touched it: applies silently');
  const c = check({ lines: [{ from: 5, to: 5 }] }, { old: 'two' });
  assert.equal(c.level, 'overlap');
  assert.deepEqual(c.lines, [[2, 2]]);
  const hit = check({ lines: [{ from: 2, to: 3 }] }, { old: 'three\nfour' });
  assert.equal(hit.level, 'clash');
  assert.equal(hit.why, 'lines');
  assert.deepEqual(hit.hits, [{ from: 2, to: 3 }]);
});

test('clashCheck: adjacent lines are an overlap, not a clash (±0)', () => {
  const check = (lines, old) => clashCheck({ content: file, main: { lines }, tool: 'Edit', old }).level;
  assert.equal(check([{ from: 3, to: 3 }], 'two'), 'overlap');
  assert.equal(check([{ from: 3, to: 3 }], 'four'), 'overlap');
  assert.equal(check([{ from: 3, to: 3 }], 'three'), 'clash');
  // A deletion between lines 3 and 4 (a gap: from 4, to 3): spanned is a clash, beside it isn't.
  assert.equal(check([{ from: 4, to: 3 }], 'three\nfour'), 'clash');
  assert.equal(check([{ from: 4, to: 3 }], 'three'), 'overlap');
  assert.equal(check([{ from: 4, to: 3 }], 'four'), 'overlap');
});

test('clashCheck fails towards clash: lines it can’t locate, a Write or deletion over main’s work, unknown main lines', () => {
  const none = clashCheck({ content: file, main: { lines: [{ from: 1, to: 1 }] }, tool: 'Edit', old: 'not in the file' });
  assert.equal(none.level, 'clash');
  assert.equal(none.why, 'unlocated');
  const gone = clashCheck({ content: null, main: { lines: [{ from: 1, to: 1 }] }, tool: 'Edit', old: 'two' });
  assert.equal(gone.level, 'clash');
  assert.equal(clashCheck({ content: file, main: { lines: [{ from: 1, to: 1 }] }, tool: 'Write' }).why, 'write');
  assert.equal(clashCheck({ content: file, main: null, tool: 'Write' }).level, 'none');
  assert.equal(clashCheck({ content: file, main: { lines: [], unknown: true }, tool: 'Edit', old: 'two' }).why, 'unlocated');
});

test('mainChanges: the diff and the running turn, minus what the side itself made', () => {
  const diff = '@@ -2 +2 @@\n-two\n+two!\n@@ -5 +5 @@\n-five\n+five!\n';
  const now = 'one\ntwo!\nthree\nfour\nfive!\nsix\n';
  assert.equal(mainChanges({ content: file }), null, 'nothing changed');
  assert.deepEqual(mainChanges({ diff, content: now }).lines, [{ from: 2, to: 2 }, { from: 5, to: 5 }]);
  // The side made line 5: it's no longer main's, so editing it again can't clash with itself.
  assert.deepEqual(mainChanges({ diff, content: now, own: [{ text: 'five!', gone: 'five', at: 5 }] }).lines, [{ from: 2, to: 2 }]);
  assert.equal(mainChanges({ diff, content: now, own: [{ text: 'five!', at: 5 }, { text: 'two!', at: 2 }] }), null, 'all of it was the side’s');
  // The closest match only: the same text elsewhere stays main's.
  const twice = 'x\nsame\ny\nsame\n';
  assert.deepEqual(mainChanges({ diff: '@@ -2 +2 @@\n-a\n+same\n@@ -4 +4 @@\n-b\n+same\n', content: twice, own: [{ text: 'same', at: 4 }] }).lines, [{ from: 2, to: 2 }]);
  // A running turn's edit git no longer shows (it committed): located by its text, else unknown.
  assert.deepEqual(mainChanges({ content: file, running: [{ after: 'three' }] }).lines, [{ from: 3, to: 3 }]);
  assert.equal(mainChanges({ content: file, running: [{ after: 'gone now' }] }).unknown, true);
  assert.equal(mainChanges({ content: file, running: [{ after: '' }] }).unknown, true);
  // A file git doesn't track that main made: every line.
  assert.deepEqual(mainChanges({ whole: true, content: 'a\nb\n' }).lines, [{ from: 1, to: 2 }]);
  assert.equal(mainChanges({ whole: true, content: 'a\nb\n', own: [{ text: 'a\nb\n', at: 1 }] }), null, 'the side made that file');
});

test('addOwn keeps one block through a later edit inside it', () => {
  let own = addOwn([], { text: 'a\nb\nc\n', at: 1 });
  own = addOwn(own, { old: 'b', text: 'B', at: 2 });
  assert.deepEqual(own, [{ text: 'a\nB\nc\n', at: 1 }]);
  own = addOwn(own, { old: 'zzz', text: 'new', at: 9 });
  assert.equal(own.length, 2);
});

test('commandClash: commands that rewrite shared work are clashes, reads and other files aren’t', () => {
  const at = (command, files = ['src/a.js', 'b.txt']) => commandClash(command, { files, cwd: '/repo' });
  for (const c of ['git reset --hard', 'git checkout main', 'git checkout -- a.js', 'git restore .', 'git clean -fd', 'git stash', 'git stash push -m x', 'git rebase main', 'git merge x', 'git commit -m x', 'git push', 'git -C /repo reset --hard', 'cd sub && git commit -am x', 'npm test; git reset HEAD~1', 'sudo git push', 'FOO=1 git commit -m y', 'bash -c "git reset --hard"', '(git stash)', 'rm b.txt', 'rm -f src/a.js', 'rm -rf src', 'mv b.txt c.txt', 'rm ./b.txt', 'rm /repo/b.txt', 'rm *.txt', 'unlink b.txt']) assert.equal(at(c).level, 'clash', c);
  for (const c of ['git status', 'git diff HEAD', 'git log --oneline', 'git show HEAD', 'git stash list', 'git stash show', 'git clean -n', 'git merge-base a b', 'ls -la', 'npm test', 'rm other.txt', 'mv c.txt d.txt', 'echo git reset', 'grep -r "git push" .']) assert.equal(at(c).level, 'none', c);
  assert.deepEqual(at('rm b.txt').files, ['b.txt']);
  assert.equal(at('git commit -m x', []).level, 'clash', 'shared work whatever main changed');
  assert.equal(at('rm *.txt', []).level, 'none', 'nothing of main’s to remove');
});

test('commandClash: git commands that destroy or move work count, listing and creating don’t', () => {
  const at = (command, files = ['src/a.js']) => commandClash(command, { files, cwd: '/repo' });
  for (const c of ['git rm -f src/a.js', 'git rm --cached src/a.js', 'git mv src/a.js src/b.js', 'git apply fix.patch', 'git branch -f main HEAD~1', 'git branch -D old', 'git branch -d old', 'git branch -M main2', 'git branch -m main2', 'git branch --delete old', 'git branch --force main HEAD~1', 'git worktree remove ../x', 'git worktree move ../x ../y', 'git update-ref refs/heads/main HEAD~1']) {
    const v = at(c);
    assert.equal(v.level, 'clash', c);
    assert.equal(v.why, 'shared', c);
  }
  assert.deepEqual(at('git rm -f src/a.js').files, ['src/a.js'], 'names what it destroys');
  assert.equal(at('git commit -m x', []).why, 'shared', 'whatever main changed');
  for (const c of ['git branch', 'git branch -a', 'git branch -vv', 'git branch --list', 'git branch --show-current', 'git branch new', 'git branch new HEAD~1', 'git branch --merged', 'git worktree list', 'git worktree add ../x', 'git rm -n src/a.js', 'git rm --dry-run src/a.js', 'git mv -n src/a.js b.js', 'git apply --check fix.patch', 'git apply --stat fix.patch']) assert.equal(at(c).level, 'none', c);
});

test('commandClash: a write to one of main’s files is a clash that names it, before it runs', () => {
  const at = (command, files = ['src/a.js']) => commandClash(command, { files, cwd: '/repo' });
  for (const c of [
    'echo x > src/a.js', 'echo x >src/a.js', 'echo x>src/a.js', 'echo x >> src/a.js', 'echo x >>src/a.js', 'npm test 2> src/a.js', 'npm test 2>src/a.js', 'echo x >| src/a.js', 'echo x >|src/a.js', 'npm test &> src/a.js', 'npm test &>> src/a.js', 'npm test >& src/a.js', '> src/a.js', ': > src/a.js', 'cat y 1> "src/a.js"', 'exec > src/a.js', 'FOO=1 > src/a.js', 'npm test 2>&1 > src/a.js', 'bash -c "echo x > src/a.js"', 'bash -lc "echo x > src/a.js"', 'sh run.sh > src/a.js', 'echo x > ./src/a.js', 'echo x > /repo/src/a.js',
    'sed -i "" s/a/b/ src/a.js', 'sed -i s/a/b/ src/a.js', 'sed -i.bak s/a/b/ src/a.js', 'sed -i .bak s/a/b/ src/a.js', 'sed -Ei s/a/b/ src/a.js', 'sed --in-place s/a/b/ src/a.js', 'sed --in-place=.bak s/a/b/ src/a.js', 'sed -i -e s/a/b/ src/a.js', 'sed -e s/a/b/ -i src/a.js', 'sed -i -f fix.sed src/a.js', 'gsed -i s/a/b/ src/a.js', 'sed -i \\\n  s/a/b/ \\\n  src/a.js',
    'perl -i -pe s/a/b/ src/a.js', 'perl -pi -e s/a/b/ src/a.js', 'perl -i.bak -pe s/a/b/ src/a.js', 'perl -0777 -pi -e s/a/b/ src/a.js',
    'cat y | tee src/a.js', 'cat y | tee -a src/a.js', 'cat y | tee other.txt src/a.js',
    'cp y src/a.js', 'cp -f y src/a.js', 'cp y a.js src/', 'cp a.js src', 'cp -r lib/src .', 'cp -t src a.js', 'cp --target-directory=src a.js', 'install y src/a.js', 'install -m 755 y src/a.js', 'rsync -a y src/a.js', 'rsync -a --delete y/ src/', 'dd if=y of=src/a.js', 'truncate -s0 src/a.js', 'truncate -s 0 src/a.js', 'truncate --size=0 src/a.js', 'truncate --size 0 src/a.js',
    'cd src && echo x > a.js', 'cd src && sed -i s/a/b/ a.js', 'cd src && rm a.js', 'cd src; cp y a.js',
    '{ echo x > src/a.js; }', 'if true; then echo x > src/a.js; fi', 'for f in a; do sed -i s/a/b/ src/a.js; done',
  ]) {
    const v = at(c);
    assert.equal(v.level, 'clash', c);
    assert.equal(v.why, c.includes('rm a.js') ? 'removes' : 'writes', c);
    assert.deepEqual(v.files, ['src/a.js'], c);
  }
});

test('commandClash: a target the shell would expand counts when main has work, and only then', () => {
  const at = (command, files = ['src/a.js']) => commandClash(command, { files, cwd: '/repo' });
  for (const c of ['echo x > src/*.js', 'echo x > "$F"', 'echo x > $F', 'echo x > $(pick)', 'echo x > `pick`', 'echo x > src/$(pick).js', 'rm $(git ls-files)', 'sed -i s/a/b/ src/*.js', 'sed -i s/a/b/ $(git ls-files)', 'perl -pi -e s/a/b/ src/*', 'cat y | tee $F', 'cp y $F', 'cp y src/*', 'cp src2/* src/', 'dd if=y of=$F', 'truncate -s0 *', 'for f in src/*.js; do sed -i s/a/b/ "$f"; done', 'cd "$D" && echo x > a.js', 'cd "$D" && rm a.js']) {
    assert.equal(at(c).level, 'clash', c);
    assert.deepEqual(at(c).files, ['src/a.js'], c);
    assert.equal(at(c, []).level, 'none', `${c}: main has no work`);
  }
});

test('commandClash: what doesn’t touch main’s files stays free, with no card', () => {
  const at = (command, files = ['src/a.js']) => commandClash(command, { files, cwd: '/repo' });
  for (const c of [
    'echo x > new.txt', 'echo x >> new.txt', 'echo x >new.txt', 'echo x>new.txt', 'npm test 2> err.log', 'npm test &> out.log', 'echo x >| new.txt', 'npm test > /dev/null', 'npm test >/dev/null 2>&1', 'npm test 2>/dev/null', 'npm test &>/dev/null', 'npm test 2>&1 | tail -5', 'npm test 2>&-', 'echo x > /tmp/y', 'echo x > ../other/a.js', 'cat < src/a.js', 'wc -l < src/a.js > /tmp/n', 'cat src/a.js > copy.js',
    'sed -i "" s/a/b/ new.txt', 'sed -i s/a/b/ new.txt', 'sed -i "" "s/a*/b/" new.txt', 'sed -i .bak "s/a*$/b/" new.txt', 'sed -i -e "s/a*/b/" new.txt', 'sed -Ei "s/[a-z]+/b/" new.txt', 'sed -n 1,5p src/a.js', 'sed s/a/b/ src/a.js', 'sed "s/a/b/" src/a.js > out.js',
    'perl -i -pe "s/a*/b/" new.txt', 'perl -pi -e "s/a*/b/" new.txt', 'perl -Mstrict -ne "print" src/a.js', 'perl -pe s/a/b/ src/a.js',
    'cat y | tee new.txt', 'cat src/a.js | tee -a log.txt', 'tee >(cat) < src/a.js', 'cat y | tee /dev/null',
    'cp y new.txt', 'cp src/a.js /tmp/keep.js', 'cp src/a.js src/b.js', 'cp src/*.js /tmp/keep/', 'cp y src/', 'cp -r y lib', 'install y bin/y', 'rsync -a src/ /tmp/keep/', 'dd if=src/a.js of=/tmp/y', 'truncate -s0 new.txt', 'truncate -s 0 new.txt',
    'cd /tmp && echo x > src/a.js', 'cd /tmp && rm src/a.js', 'cd src && echo x > new.txt',
    'cat > new.txt <<EOF\nrm src/a.js\necho x > src/a.js\ndon\'t\nEOF', 'cat <<-\'EOF\' > new.txt\n\techo x > $F\n\tEOF', 'echo ok # rm src/a.js > src/a.js', 'echo "a > src/a.js"', 'grep -r ">" src', 'echo \'x\' \\> src/a.js', 'git log --format=">%h"',
  ]) assert.equal(at(c).level, 'none', c);
});

test('commandClash: what follows a heredoc, an apostrophe in a comment or a chain is still read', () => {
  const at = (command) => commandClash(command, { files: ['src/a.js'], cwd: '/repo' });
  assert.equal(at('cat > new.txt <<EOF\ndon\'t\nEOF\nrm src/a.js').why, 'removes');
  assert.equal(at('# don\'t\nrm src/a.js').why, 'removes');
  assert.equal(at('cat <<EOF > src/a.js\nx\nEOF').why, 'writes');
  assert.equal(at('npm test && echo done > new.txt; echo x > src/a.js').why, 'writes');
  assert.equal(at('rm src/a.js; git reset --hard').why, 'shared', 'the worst one');
  assert.deepEqual(at('echo x > src/a.js; git stash').files, ['src/a.js']);
  assert.equal(commandClash('rm a.js; echo x > b.js', { files: ['a.js', 'b.js'], cwd: '/repo' }).why, 'removes');
  assert.deepEqual(commandClash('rm a.js; echo x > b.js', { files: ['a.js', 'b.js'], cwd: '/repo' }).files, ['a.js', 'b.js']);
});

// --- through a real server -----------------------------------------------------------------------

const edited = (dir, f = 'math.js') => fs.readFileSync(path.join(dir, f), 'utf8');
const repoGit = (dir, ...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });

// A finished main task in its own worktree, with math.js changed (uncommitted: `return a + b;`).
async function mainTask() {
  const repo = makeRepo();
  const s = await api('/sessions', { prompt: 'fix add() please', cwd: repo, agent: 'claude', mode: 'auto', worktree: true });
  const main = await settled(s.id, 1);
  return { id: s.id, dir: main.worktree.path, main };
}
const asking = (id) => until(async () => (await api(`/sessions/${id}`)).ask?.clash && (await api(`/sessions/${id}`)));

test('none: a file main hasn’t touched is edited with no card, no row, and shows in the turn’s files', async () => {
  const { id, dir } = await mainTask();
  fs.writeFileSync(path.join(dir, 'notes.md'), 'hello\nworld\n');
  repoGit(dir, 'add', 'notes.md');
  repoGit(dir, 'commit', '-qm', 'notes', '--only', 'notes.md');
  const side = await api(`/sessions/${id}/side`, { text: 'SIDEEDIT notes.md|world|there' });
  const full = await settled(side.id, 1);
  assert.equal(edited(dir, 'notes.md'), 'hello\nthere\n');
  assert.equal(full.turns[0].sideWarn, undefined);
  assert.deepEqual(full.turns[0].changes.map((c) => c.file), ['notes.md']);
  assert.equal((await api(`/sessions/${id}`)).turns.length, 1, 'nothing reached the main task');
});

test('overlap: main changed the file but not these lines: it applies with a warning row, no card, no message to main', async () => {
  const { id, dir, main } = await mainTask();
  const side = await api(`/sessions/${id}/side`, { text: 'SIDEEDIT math.js|export function add|export function plus' });
  const full = await settled(side.id, 1);
  assert.match(edited(dir), /export function plus/);
  assert.match(edited(dir), /a \+ b/, 'main’s line is kept');
  assert.deepEqual(full.turns[0].sideWarn.map((w) => [w.kind, w.file, w.main]), [['overlap', 'math.js', main.title]]);
  assert.equal((await api(`/sessions/${id}`)).turns.length, 1);
  assert.equal((await api(`/sessions/${id}`)).queue?.length || 0, 0);
});

test('a side’s second edit of its own line isn’t a clash with itself', async () => {
  const { id, dir } = await mainTask();
  const side = await api(`/sessions/${id}/side`, { text: 'SIDEEDIT math.js|export function add|export function plus' });
  await settled(side.id, 1);
  await api(`/sessions/${side.id}/reply`, { text: 'SIDEEDIT math.js|export function plus|export function sum' });
  const full = await settled(side.id, 2);
  assert.match(edited(dir), /export function sum/);
  assert.equal(full.ask, undefined);
});

test('clash: a card in the side before the write; the main task gets none; Apply tells an idle main as a follow-up', async () => {
  const { id, dir, main } = await mainTask();
  const side = await api(`/sessions/${id}/side`, { text: 'SIDEEDIT math.js|return a + b;|return b + a;' });
  const waiting = await asking(side.id);
  assert.equal(waiting.state, 'waiting');
  const c = waiting.ask.clash;
  assert.deepEqual([c.kind, c.file, c.mainTitle], ['lines', 'math.js', main.title]);
  assert.deepEqual(c.proposed, { before: 'return a + b;', after: 'return b + a;' });
  assert.match(c.main[0].text, /a \+ b/);
  assert.deepEqual(waiting.ask.options, [SIDE_APPLY, SIDE_KEEP]);
  assert.match(edited(dir), /a \+ b/, 'nothing written yet');
  assert.equal((await api(`/sessions/${id}`)).ask, undefined, 'the main task gets no card');
  assert.equal((await api('/sessions')).find((x) => x.id === side.id).options, undefined, 'no one-tap Apply on a phone’s row: it’s read first');

  await api(`/sessions/${side.id}/clash`, { askId: waiting.ask.id, action: 'apply', sig: c.sig });
  await settled(side.id, 1);
  assert.match(edited(dir), /b \+ a/);
  const told = await until(async () => {
    const m = await api(`/sessions/${id}`);
    return m.turns.length === 2 && m;
  });
  assert.match(told.turns[1].prompt, /side discussion[\s\S]*math\.js[\s\S]*return b \+ a/);
  assert.equal(told.turns[1].side.id, side.id);
  assert.equal(told.turns[1].by, 'wisp');
  await settled(id, 2);
  // Accepted: it's the side's now, so editing it again is no clash.
  await api(`/sessions/${side.id}/reply`, { text: 'SIDEEDIT math.js|return b + a;|return b + a + 0;' });
  const again = await settled(side.id, 2);
  assert.equal(again.ask, undefined);
  assert.match(edited(dir), /b \+ a \+ 0/);
});

test('clash: Apply while main runs goes in its follow-up queue, and Stop doesn’t lose it', async () => {
  const { id, dir } = await mainTask();
  const side = await api(`/sessions/${id}/side`, { text: 'SIDEEDIT math.js|return a + b;|return b + a;' });
  const waiting = await asking(side.id);
  process.env.FAKE_HANG = '1';
  await api(`/sessions/${id}/reply`, { text: 'keep going' });
  await until(async () => (await api(`/sessions/${id}`)).turns.at(-1).status === 'running' && (await api(`/sessions/${id}`)).turns.length === 2);
  delete process.env.FAKE_HANG;
  // Main moved on nothing: same lines, so the card still holds.
  await api(`/sessions/${side.id}/clash`, { askId: waiting.ask.id, action: 'apply', sig: waiting.ask.clash.sig });
  await settled(side.id, 1);
  const m = await until(async () => {
    const x = await api(`/sessions/${id}`);
    return x.queue?.length === 1 && x;
  });
  assert.match(m.queue[0].text, /side discussion[\s\S]*math\.js/);
  assert.equal(m.turns.length, 2, 'the run isn’t interrupted');
  assert.match(edited(dir), /b \+ a/);
  await api(`/sessions/${id}/stop`, {});
  const held = await until(async () => {
    const x = await api(`/sessions/${id}`);
    return x.turns.at(-1).status === 'stopped' && x;
  });
  assert.equal(held.queue.length, 1, 'Stop holds the queue, as for any queued follow-up');
  await api(`/sessions/${id}/reply`, { text: 'carry on' });
  await settled(id, 4);
  assert.match((await api(`/sessions/${id}`)).turns[3].prompt, /side discussion/, 'and it goes out after your next message');
});

test('clash: Keep main’s version: nothing is written, the agent hears why, main hears nothing', async () => {
  const { id, dir } = await mainTask();
  const side = await api(`/sessions/${id}/side`, { text: 'SIDEEDIT math.js|return a + b;|return b + a;' });
  const waiting = await asking(side.id);
  await api(`/sessions/${side.id}/clash`, { askId: waiting.ask.id, action: 'keep' });
  const full = await settled(side.id, 1);
  assert.match(edited(dir), /a \+ b/);
  assert.match(JSON.stringify(full.turns[0].presentation), /refused:.*kept the main task/);
  assert.deepEqual(full.turns[0].changes, [], 'a refused edit isn’t in its files');
  assert.equal(full.turns[0].blocked, undefined);
  assert.equal((await api(`/sessions/${id}`)).turns.length, 1);
});

test('a typed answer on the card keeps main’s version with the user’s words; Apply typed rechecks too', async () => {
  const { id, dir } = await mainTask();
  const side = await api(`/sessions/${id}/side`, { text: 'SIDEEDIT math.js|return a + b;|return b + a;' });
  await asking(side.id);
  await api(`/sessions/${side.id}/answer`, { text: 'no, rename it instead' });
  const full = await settled(side.id, 1);
  assert.match(edited(dir), /a \+ b/);
  assert.match(JSON.stringify(full.turns[0].presentation), /rename it instead/);
});

test('a Write over a file main changed is a clash; on another file it isn’t', async () => {
  const { id, dir } = await mainTask();
  const side = await api(`/sessions/${id}/side`, { text: 'SIDEWRITE new.txt|fresh\nSIDEWRITE math.js|replaced' });
  const waiting = await asking(side.id);
  assert.equal(waiting.ask.clash.kind, 'write');
  assert.equal(edited(dir, 'new.txt'), 'fresh');
  await api(`/sessions/${side.id}/clash`, { askId: waiting.ask.id, action: 'keep' });
  await settled(side.id, 1);
  assert.match(edited(dir), /a \+ b/);
});

test('lines the check can’t locate are a clash, never a silent write', async () => {
  const { id } = await mainTask();
  const side = await api(`/sessions/${id}/side`, { text: 'SIDEEDIT math.js|not in this file|x' });
  const waiting = await asking(side.id);
  assert.equal(waiting.ask.clash.kind, 'unlocated');
  await api(`/sessions/${side.id}/clash`, { askId: waiting.ask.id, action: 'keep' });
  await settled(side.id, 1);
});

test('a stale card rechecks at Apply: it refuses, shows the new state, and writes nothing until Apply again', async () => {
  const { id, dir } = await mainTask();
  const side = await api(`/sessions/${id}/side`, { text: 'SIDEEDIT math.js|return a + b;|return b + a;' });
  const waiting = await asking(side.id);
  // Main moves on while the card sits there.
  fs.writeFileSync(path.join(dir, 'math.js'), edited(dir).replace('return a + b;', 'return a + b + 1;\n  // and more'));
  const r = await call(`/sessions/${side.id}/clash`, { askId: waiting.ask.id, action: 'apply', sig: waiting.ask.clash.sig });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /main task moved/i);
  const fresh = (await api(`/sessions/${side.id}`)).ask;
  assert.equal(fresh.id, waiting.ask.id, 'the same card, so the agent keeps waiting on it');
  assert.notEqual(fresh.clash.sig, waiting.ask.clash.sig);
  assert.equal(fresh.clash.moved, true);
  assert.match(fresh.clash.main[0].text, /a \+ b \+ 1/);
  assert.match(edited(dir), /a \+ b \+ 1/, 'not written');
  await api(`/sessions/${side.id}/clash`, { askId: fresh.id, action: 'keep' });
  await settled(side.id, 1);
  assert.equal((await call(`/sessions/${side.id}/clash`, { askId: fresh.id, action: 'apply' })).status, 409, 'no card left');
});

test('a card whose clash went away says so, and Apply then writes it', async () => {
  const { id, dir } = await mainTask();
  const side = await api(`/sessions/${id}/side`, { text: 'SIDEEDIT math.js|return a + b;|return b + a;' });
  const waiting = await asking(side.id);
  repoGit(dir, 'add', '.');
  repoGit(dir, 'commit', '-qm', 'main committed it');
  const r = await call(`/sessions/${side.id}/clash`, { askId: waiting.ask.id, action: 'apply', sig: waiting.ask.clash.sig });
  assert.equal(r.status, 409);
  const fresh = (await api(`/sessions/${side.id}`)).ask;
  assert.equal(fresh.clash.kind, 'cleared');
  assert.match(fresh.question, /no longer clashes/);
  await api(`/sessions/${side.id}/clash`, { askId: fresh.id, action: 'apply', sig: fresh.clash.sig });
  await settled(side.id, 1);
  assert.match(edited(dir), /b \+ a/);
});

test('a command card rechecks too: main’s files moved, so it shows them before it can run', async () => {
  const { id, dir } = await mainTask();
  const side = await api(`/sessions/${id}/side`, { text: 'SIDERUN git reset --hard' });
  const waiting = await asking(side.id);
  fs.writeFileSync(path.join(dir, 'more.txt'), 'main again\n');
  const r = await call(`/sessions/${side.id}/clash`, { askId: waiting.ask.id, action: 'apply', sig: waiting.ask.clash.sig });
  assert.equal(r.status, 409);
  assert.equal((await api(`/sessions/${side.id}`)).ask.clash.moved, true);
  assert.match(edited(dir), /a \+ b/, 'it didn’t run');
  await api(`/sessions/${side.id}/clash`, { askId: waiting.ask.id, action: 'keep' });
  await settled(side.id, 1);
});

test('commands: they run with no card; one that rewrites shared work is a clash, and Keep stops it', async () => {
  const { id, dir } = await mainTask();
  const side = await api(`/sessions/${id}/side`, { text: 'SIDERUN touch ran.txt\nSIDERUN git reset --hard' });
  const waiting = await asking(side.id);
  assert.ok(fs.existsSync(path.join(dir, 'ran.txt')), 'the plain command ran, no card');
  assert.equal(waiting.ask.clash.kind, 'command');
  assert.equal(waiting.ask.clash.command, 'git reset --hard');
  await api(`/sessions/${side.id}/clash`, { askId: waiting.ask.id, action: 'keep' });
  await settled(side.id, 1);
  assert.match(edited(dir), /a \+ b/, 'main’s work survived');
});

test('commands: rm of a file main changed is a clash; Apply tells main', async () => {
  const { id, dir } = await mainTask();
  const side = await api(`/sessions/${id}/side`, { text: 'SIDERUN rm math.js' });
  const waiting = await asking(side.id);
  assert.deepEqual(waiting.ask.clash.files, ['math.js']);
  await api(`/sessions/${side.id}/clash`, { askId: waiting.ask.id, action: 'apply', sig: waiting.ask.clash.sig });
  await settled(side.id, 1);
  assert.ok(!fs.existsSync(path.join(dir, 'math.js')));
  const m = await until(async () => {
    const x = await api(`/sessions/${id}`);
    return x.turns.length === 2 && x;
  });
  assert.match(m.turns[1].prompt, /rm math\.js/);
  await settled(id, 2);
});

test('commands: writing over a file main changed is a card that names it; Keep leaves it, Apply runs it and tells main', async () => {
  const { id, dir } = await mainTask();
  const before = edited(dir);
  const side = await api(`/sessions/${id}/side`, { text: 'SIDERUN echo gone > math.js' });
  const waiting = await asking(side.id);
  assert.equal(waiting.ask.clash.kind, 'command');
  assert.equal(waiting.ask.clash.why, 'writes');
  assert.deepEqual(waiting.ask.clash.files, ['math.js']);
  assert.match(waiting.ask.question, /math\.js/);
  assert.equal(edited(dir), before, 'nothing written before the answer');
  await api(`/sessions/${side.id}/clash`, { askId: waiting.ask.id, action: 'keep' });
  await settled(side.id, 1);
  assert.equal(edited(dir), before, 'main’s lines survived');

  const again = await api(`/sessions/${id}/side`, { text: 'SIDERUN sed -i.bak s/add/plus/ math.js' });
  const card = await asking(again.id);
  await api(`/sessions/${again.id}/clash`, { askId: card.ask.id, action: 'apply', sig: card.ask.clash.sig });
  await settled(again.id, 1);
  assert.match(edited(dir), /plus/);
  const m = await until(async () => {
    const x = await api(`/sessions/${id}`);
    return x.turns.length === 2 && x;
  });
  assert.match(m.turns[1].prompt, /math\.js[\s\S]*sed -i\.bak/);
  await settled(id, 2);
});

test('commands: git rm of main’s work waits on a card before anything is gone', async () => {
  const { id, dir } = await mainTask();
  const side = await api(`/sessions/${id}/side`, { text: 'SIDERUN git rm -f math.js' });
  const waiting = await asking(side.id);
  assert.equal(waiting.ask.clash.why, 'shared');
  assert.deepEqual(waiting.ask.clash.files, ['math.js']);
  assert.ok(fs.existsSync(path.join(dir, 'math.js')));
  await api(`/sessions/${side.id}/clash`, { askId: waiting.ask.id, action: 'keep' });
  await settled(side.id, 1);
  assert.match(edited(dir), /a \+ b/);
});

test('commands: a file the side’s own command made or changed stays the side’s, with no card next time', async () => {
  const { id, dir } = await mainTask();
  fs.writeFileSync(path.join(dir, 'notes.md'), 'hello\n');
  repoGit(dir, 'add', 'notes.md');
  repoGit(dir, 'commit', '-qm', 'notes', '--only', 'notes.md');
  const side = await api(`/sessions/${id}/side`, { text: 'SIDERUN echo one > fresh.txt\nSIDERUN sed -i.bak s/hello/hi/ notes.md' });
  await settled(side.id, 1);
  await api(`/sessions/${side.id}/reply`, { text: 'SIDERUN echo two >> fresh.txt\nSIDERUN sed -i.bak s/hi/hey/ notes.md' });
  const full = await settled(side.id, 2);
  assert.equal(full.ask ?? null, null);
  assert.equal(edited(dir, 'fresh.txt'), 'one\ntwo\n');
  assert.equal(edited(dir, 'notes.md'), 'hey\n');
  assert.equal(full.turns[0].sideWarn, undefined);
  assert.equal((await api(`/sessions/${id}`)).turns.length, 1, 'nothing reached the main task');
});

test('a write the check can’t read (a script) is caught after it ran: a warning row and the same message to main', async () => {
  const { id, dir } = await mainTask();
  const side = await api(`/sessions/${id}/side`, { text: `SIDERUN node -e "fs.appendFileSync('math.js', '// from a command\\n')"` });
  await settled(side.id, 1);
  assert.match(edited(dir), /from a command/);
  const full = await until(async () => {
    const x = await api(`/sessions/${side.id}`);
    return x.turns[0].sideWarn && x;
  });
  assert.deepEqual(full.turns[0].sideWarn.map((w) => [w.kind, w.file]), [['command', 'math.js']]);
  const m = await until(async () => {
    const x = await api(`/sessions/${id}`);
    return x.turns.length === 2 && x;
  });
  assert.match(m.turns[1].prompt, /side discussion[\s\S]*math\.js[\s\S]*from a command/);
  await settled(id, 2);
});

test('a harness with no way to ask before a write stays read-only, and says so', async () => {
  assert.ok(adapters.claude.sideGate, 'Claude Code asks through --permission-prompt-tool');
  assert.ok(!adapters.codex.sideGate, 'not checked on a real run: stays read-only');
  const repo = makeRepo();
  const s = await api('/sessions', { prompt: 'fix add() please', cwd: repo, agent: 'claude', mode: 'auto', worktree: true });
  await settled(s.id, 1);
  const side = await api(`/sessions/${s.id}/side`, { text: 'what changed?', agent: 'codex' });
  assert.equal(side.mode, 'plan');
  assert.equal(side.sideOf.edits, false);
  await settled(side.id, 1);
  const r = records(RECORD, 'codex').at(-1);
  assert.match(r.argv.join(' '), /sandbox_mode="read-only"/);
  assert.match(r.argv.join(' ') + r.stdin, /Change nothing/);
  assert.match(r.argv.join(' ') + r.stdin, /Codex can’t ask wisp before a write/);
});

test('OpenCode: a plugin holds each write until the gate answers, and a refusal stops the call', async () => {
  assert.ok(adapters.opencode.sideGate);
  const repo = makeRepo();
  const s = await api('/sessions', { prompt: 'fix add() please', cwd: repo, agent: 'claude', mode: 'auto', worktree: true });
  await settled(s.id, 1);
  const side = await api(`/sessions/${s.id}/side`, { text: 'what changed?', agent: 'opencode' });
  assert.equal(side.mode, 'edits');
  await settled(side.id, 1);
  const r = records(RECORD, 'opencode').at(-1);
  assert.ok(!r.argv.includes('plan') && !r.argv.includes('--auto'));
  const seen = [];
  const { gateCalls, WispGate } = await import('../server/opencode-gate.js');
  assert.deepEqual(gateCalls('edit', { filePath: 'a', oldString: 'x', newString: 'y' }), [{ tool: 'Edit', input: { file_path: 'a', old_string: 'x', new_string: 'y', replace_all: undefined } }]);
  assert.deepEqual(gateCalls('apply_patch', { patchText: '*** Update File: a.js\n*** Add File: b.js\n' }).map((c) => [c.tool, c.input.file_path]), [['Write', 'a.js'], ['Write', 'b.js']]);
  assert.deepEqual(gateCalls('read', { path: 'a' }), [], 'a read isn’t gated');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, o) => (seen.push(JSON.parse(o.body).tool), { ok: true, json: async () => ({ decision: 'deny', message: 'kept' }) });
  try {
    const hooks = await WispGate();
    await assert.rejects(hooks['tool.execute.before']({ tool: 'bash', callID: 'c' }, { args: { command: 'ls' } }), /kept/);
    await hooks['tool.execute.before']({ tool: 'read', callID: 'c' }, { args: { path: 'a' } });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(seen, ['Bash']);
});

test('a read-only side’s approval is still refused without asking', async () => {
  const { runner } = srv;
  const repo = makeRepo();
  const s = await api('/sessions', { prompt: 'x', cwd: repo, agent: 'claude', mode: 'auto', worktree: true });
  await settled(s.id, 1);
  const side = await api(`/sessions/${s.id}/side`, { text: 'hm', agent: 'codex' });
  await settled(side.id, 1);
  const out = await runner.requestApproval(runner.store.get(side.id), { tool: 'Edit', input: { file_path: 'x' } });
  assert.equal(out.decision, 'deny');
  assert.match(out.message, /read-only/);
});

test('main’s rollback after a side edit: no crash, it claims only main’s files, the edit goes with the restore and Undo brings it back', async () => {
  const { id, dir } = await mainTask();
  const side = await api(`/sessions/${id}/side`, { text: 'SIDEEDIT math.js|export function add|export function plus' });
  await settled(side.id, 1);
  const main = await api(`/sessions/${id}`);
  const r = await api(`/sessions/${id}/rollback`, { turnId: main.turns[0].id });
  assert.deepEqual(r.files, ['math.js']);
  assert.match(edited(dir), /export function add/, 'the restore takes the folder back, the side’s edit too');
  await api(`/sessions/${id}/rollback`, { turnId: main.turns[0].id, restore: true });
  assert.match(edited(dir), /export function plus/);
  assert.match(edited(dir), /a \+ b/);
});
