// The ship loop, through a real wisp server, real git and a fake `gh`: worktree sessions, Ship it
// (commit → push → PR → checks → merge → local main synced), compare runs, recipes, triggers,
// usage, and answering from a phone (fake ntfy and Telegram servers).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { installFakeBins, makeClone, makeRepo, records, tmp, until } from './helpers.js';

const RECORD = tmp('ship-record');
const GH_STATE = path.join(tmp('gh'), 'state.json');
process.env.FAKE_RECORD = RECORD;
process.env.FAKE_GH_STATE = GH_STATE;
process.env.WISP_HOME = tmp('ship-home');
process.env.WISP_UPDATE_CHECK = '0';
installFakeBins();

const { startServer } = await import('../server/index.js');
const { parseCron, nextRun, cronMatches } = await import('../server/triggers.js');
const { fill, params, positional } = await import('../server/recipes.js');
const { usage, toolStats, toolStatsText } = await import('../server/usage.js');
const { adapters } = await import('../server/adapters/index.js');

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

let srv;
let base;
async function api(p, { method, body } = {}) {
  const r = await fetch(`${base}/api${p}`, {
    method: method || (body ? 'POST' : 'GET'),
    headers: body || (method && method !== 'GET') ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : method && method !== 'GET' ? '{}' : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(`${p}: ${j.error}`), { status: r.status });
  return j;
}
const session = (id) => api(`/sessions/${id}`);
const settled = (id) => until(async () => ((await session(id)).state === 'review' ? session(id) : null));
const ghState = () => (fs.existsSync(GH_STATE) ? JSON.parse(fs.readFileSync(GH_STATE, 'utf8')) : {});
const setGh = (patch) => fs.writeFileSync(GH_STATE, JSON.stringify({ ...ghState(), ...patch }));

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

test('a launch in a git repo runs in its own worktree on a branch from origin/main', async () => {
  const repo = makeClone();
  const s = await api('/sessions', { body: { prompt: 'Fix add() in math.js', cwd: repo.dir, agent: 'claude' } });
  assert.match(s.branch, /^wisp\/fix-add-in-math-js-[a-f0-9]{6}$/);
  const done = await settled(s.id);
  const wt = done.worktree;
  assert.equal(wt.base, 'main');
  assert.equal(wt.baseRef, 'origin/main');
  assert.equal(wt.cwd, wt.path);
  // The agent ran (and edited) inside the worktree; the user's checkout is untouched.
  const run = records(RECORD, 'claude').at(-1);
  assert.equal(fs.realpathSync(run.cwd), fs.realpathSync(wt.path));
  assert.match(fs.readFileSync(path.join(wt.path, 'math.js'), 'utf8'), /a \+ b/);
  assert.match(fs.readFileSync(path.join(repo.dir, 'math.js'), 'utf8'), /a - b/);
  assert.match(run.argv[run.argv.indexOf('--append-system-prompt') + 1], new RegExp(`isolated git worktree .* branch \`${wt.branch}\``));
  // Captured diffs are relative to the worktree, and take over opens there.
  assert.deepEqual(done.turns[0].changes.map((c) => c.file), ['math.js']);
  const { command } = await api(`/sessions/${s.id}/takeover`);
  assert.ok(command.includes(wt.path), command);
  // The presentation tells API callers where the changes are.
  const p = await api(`/sessions/${s.id}/presentation`);
  assert.match(p.markdown, new RegExp(`branch \`${wt.branch}\``));
});

test('worktree: false, plan mode, and folders that are not repos run in place', async () => {
  const repo = makeClone();
  const a = await api('/sessions', { body: { prompt: 'in place', cwd: repo.dir, agent: 'claude', worktree: false } });
  const b = await api('/sessions', { body: { prompt: 'just look', cwd: repo.dir, agent: 'claude', mode: 'plan' } });
  const plain = tmp('plain');
  const c = await api('/sessions', { body: { prompt: 'no git here', cwd: plain, agent: 'claude' } });
  for (const x of [a, b, c]) assert.equal(x.branch, '');
  await Promise.all([a, b, c].map((x) => settled(x.id)));
  await assert.rejects(api('/sessions', { body: { prompt: 'x', cwd: plain, agent: 'claude', worktree: true } }), /Not a git repo/);
});

test('ship it: commit, push, PR; checks are followed; merge syncs local main and cleans up', async () => {
  const repo = makeClone();
  const s = await api('/sessions', { body: { prompt: 'Fix add() so it adds', cwd: repo.dir, agent: 'claude' } });
  const done = await settled(s.id);
  const wt = done.worktree;
  // The card learns there is something to ship, so it shows Ship it.
  const toShip = async () => (await api('/sessions')).find((x) => x.id === s.id).toShip;
  await until(async () => (await toShip())?.dirty === 1);
  assert.deepEqual(await toShip(), { dirty: 1, ahead: 0, unpushed: 0 });

  const draft = await api(`/sessions/${s.id}/ship`);
  assert.equal(draft.branch, wt.branch);
  assert.equal(draft.dirty, 1);
  assert.equal(draft.ahead, 0);
  assert.equal(draft.title, 'fix: fake claude finished'); // conventional, from the hero title
  assert.match(draft.body, /No question asked/);

  setGh({ checks: [{ __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '' }] });
  // The card follows the ship live: each stage arrives as `shipping` on the session's summary.
  const events = new AbortController();
  const stream = await fetch(`${base}/api/events`, { signal: events.signal });
  const stages = [];
  const reading = (async () => {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of stream.body) {
        buf += dec.decode(chunk, { stream: true });
        for (let i; (i = buf.indexOf('\n\n')) >= 0; buf = buf.slice(i + 2)) {
          const msg = buf.slice(0, i);
          if (!/^event: summary$/m.test(msg)) continue;
          const sum = JSON.parse(msg.match(/^data: (.*)$/m)[1]);
          if (sum.id === s.id && stages.at(-1) !== (sum.shipping?.step || null)) stages.push(sum.shipping?.step || null);
        }
      }
    } catch {}
  })();
  const pr = await api(`/sessions/${s.id}/ship`, { body: { title: 'fix(math): add adds', body: 'It subtracted.' } });
  await until(() => stages.at(-1) === null && stages.length > 1);
  events.abort();
  await reading;
  assert.deepEqual(stages.slice(stages.indexOf('start')), ['start', 'commit', 'push', 'pr', null]);
  assert.equal((await api('/sessions')).find((x) => x.id === s.id).shipping, null);
  assert.equal(pr.number, 1);
  assert.equal(pr.state, 'OPEN');
  assert.deepEqual(pr.checks, { pass: 0, fail: 0, pending: 1 });
  // A real commit on the branch, pushed to origin.
  const remoteLog = repo.git('--git-dir', repo.remote, 'log', '--format=%s%n%b', wt.branch);
  assert.match(remoteLog, /fix\(math\): add adds\n+It subtracted\./);
  const create = records(RECORD, 'gh').find((r) => r.argv[1] === 'create').argv;
  assert.deepEqual([create[create.indexOf('--base') + 1], create[create.indexOf('--head') + 1]], ['main', wt.branch]);
  assert.equal((await api('/sessions')).find((x) => x.id === s.id).pr.number, 1);
  // Everything is on the PR now: nothing left to push, so Ship it hides.
  await until(async () => (await toShip())?.dirty === 0);
  assert.deepEqual(await toShip(), { dirty: 0, ahead: 1, unpushed: 0 });

  // CI goes green and the review lands: the card comes back unread.
  await api(`/sessions/${s.id}`, { method: 'PATCH', body: { unread: false } });
  setGh({ checks: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }, { __typename: 'StatusContext', state: 'SUCCESS' }], review: 'APPROVED' });
  const fresh = await api(`/sessions/${s.id}/pr`, { body: {} });
  assert.deepEqual(fresh.checks, { pass: 2, fail: 0, pending: 0 });
  assert.equal(fresh.review, 'APPROVED');
  assert.equal((await api('/sessions')).find((x) => x.id === s.id).unread, true);

  const r = await api(`/sessions/${s.id}/merge`, { body: {} });
  assert.equal(r.pr.state, 'MERGED');
  assert.equal(r.sync.ok, true, r.sync.text);
  const merge = records(RECORD, 'gh').find((x) => x.argv[1] === 'merge').argv;
  assert.deepEqual(merge.slice(2), ['1', '--squash', '--match-head-commit', fresh.head]);
  // The user's checkout fast-forwarded to the merged fix; the worktree and branch are gone.
  assert.match(fs.readFileSync(path.join(repo.dir, 'math.js'), 'utf8'), /a \+ b/);
  assert.equal(fs.existsSync(wt.path), false);
  assert.equal(repo.git('branch', '--list', wt.branch), '');
  assert.equal((await session(s.id)).state, 'done');
});

// A shipped task whose PR now conflicts: main moved on the same line the task changed.
async function conflictedPr(prompt) {
  const repo = makeClone();
  const s = await api('/sessions', { body: { prompt, cwd: repo.dir, agent: 'claude' } });
  await settled(s.id);
  const pr = await api(`/sessions/${s.id}/ship`, { body: { title: 'fix: add adds' } });
  fs.writeFileSync(path.join(repo.dir, 'math.js'), 'export function add(a, b) {\n  return b - a;\n}\n');
  repo.git('commit', '-qam', 'meanwhile on main');
  repo.git('push', '-q', 'origin', 'main');
  setGh({ mergeable: 'CONFLICTING' });
  return { repo, s, pr };
}
const summaryOf = async (id) => (await api('/sessions')).find((x) => x.id === id);
// Closed, so the minute poll stops running the fake gh (which rewrites its state file) under later tests.
async function closePrs(...ids) {
  const { prs } = ghState();
  for (const id of ids) {
    const n = (await summaryOf(id))?.pr?.number;
    if (n) prs[n].state = 'CLOSED';
  }
  setGh({ prs, mergeable: undefined });
  for (const id of ids) await api(`/sessions/${id}/pr`, { body: {} }).catch(() => {});
}

test('a conflicting PR is left alone by default; with Auto-fix on, a follow-up merges main in and wisp pushes it', async () => {
  const { repo, s, pr } = await conflictedPr('Fix add() before main moves');
  try {
    // By default nothing happens until the user clicks Fix conflicts.
    const seen = await api(`/sessions/${s.id}/pr`, { body: {} });
    assert.equal(seen.conflict, true);
    assert.equal((await session(s.id)).turns.length, 1);
    assert.equal((await summaryOf(s.id)).conflictFix, null);
    await api('/config', { method: 'PATCH', body: { defaults: { fixConflicts: 'on' } } });
    await api(`/sessions/${s.id}/pr`, { body: {} });
    // The task got a follow-up asking for the merge, without anyone sending it.
    const fix = await until(async () => ((await session(s.id)).turns.length === 2 ? session(s.id) : null));
    assert.match(fix.turns[1].prompt, new RegExp(`PR #${pr.number} .* can no longer merge into \`main\``));
    assert.match(fix.turns[1].prompt, /`git merge origin\/main`/);
    // When the run ends, the merge is pushed to the PR's branch.
    await until(async () => (await summaryOf(s.id)).conflictFix?.step === 'done');
    const wt = fix.worktree;
    repo.git('--git-dir', repo.remote, 'merge-base', '--is-ancestor', 'main', wt.branch); // throws if main isn't in
    assert.equal(repo.git('--git-dir', repo.remote, 'rev-parse', wt.branch), repo.git('-C', wt.path, 'rev-parse', 'HEAD'));
    // Still CONFLICTING on the (stale) GitHub side: the new head was handled, so no second follow-up.
    await api(`/sessions/${s.id}/pr`, { body: {} });
    assert.equal((await session(s.id)).turns.length, 2);
    // GitHub agrees it merges now: the PR row goes back to normal.
    setGh({ mergeable: 'MERGEABLE' });
    const clean = await api(`/sessions/${s.id}/pr`, { body: {} });
    assert.equal(clean.conflict, false);
    assert.equal((await summaryOf(s.id)).conflictFix, null);
  } finally {
    await api('/config', { method: 'PATCH', body: { defaults: { fixConflicts: 'off' } } });
    await closePrs(s.id);
  }
});

test('a conflict fix that leaves conflicts is not pushed; Fix conflicts retries; the setting turns it off', async () => {
  process.env.FAKE_LEAVE_CONFLICTS = '1';
  await api('/config', { method: 'PATCH', body: { defaults: { fixConflicts: 'on' } } });
  const { repo, s } = await conflictedPr('Fix add() and race main');
  let other;
  try {
    const head = repo.git('--git-dir', repo.remote, 'rev-parse', (await session(s.id)).worktree.branch);
    await api(`/sessions/${s.id}/pr`, { body: {} });
    const failed = await until(async () => ((await summaryOf(s.id)).conflictFix?.step === 'failed' ? summaryOf(s.id) : null));
    assert.match(failed.conflictFix.why, /Still conflicted: math\.js/);
    assert.equal(failed.unread, true);
    assert.equal(repo.git('--git-dir', repo.remote, 'rev-parse', (await session(s.id)).worktree.branch), head, 'nothing pushed');
    // The poll doesn't try again on the same head...
    await api(`/sessions/${s.id}/pr`, { body: {} });
    assert.equal((await session(s.id)).turns.length, 2);
    // ...but the PR row's Fix conflicts does (here: the agent clears up the half-done merge).
    delete process.env.FAKE_LEAVE_CONFLICTS;
    repo.git('-C', (await session(s.id)).worktree.path, 'merge', '--abort');
    assert.equal((await api(`/sessions/${s.id}/fix-conflicts`, { body: {} })).conflictFix.step, 'fixing');
    await until(async () => (await summaryOf(s.id)).conflictFix?.step === 'done');

    // Off in Settings: a conflicting PR is left alone.
    await api('/config', { method: 'PATCH', body: { defaults: { fixConflicts: 'off' } } });
    other = await conflictedPr('Fix add() with the fixer off');
    await api(`/sessions/${other.s.id}/pr`, { body: {} });
    assert.equal((await session(other.s.id)).turns.length, 1);
    assert.equal((await summaryOf(other.s.id)).conflictFix, null);
    // ...until the user clicks Fix conflicts on its PR row: that sends the follow-up anyway.
    assert.equal((await api(`/sessions/${other.s.id}/fix-conflicts`, { body: {} })).conflictFix.step, 'fixing');
    assert.match((await until(async () => ((await session(other.s.id)).turns.length === 2 ? session(other.s.id) : null))).turns[1].prompt, /can no longer merge/);
    await until(async () => (await summaryOf(other.s.id)).conflictFix?.step === 'done');
  } finally {
    delete process.env.FAKE_LEAVE_CONFLICTS;
    await api('/config', { method: 'PATCH', body: { defaults: { fixConflicts: 'off' } } });
    await closePrs(s.id, ...(other ? [other.s.id] : []));
  }
});

test('ship it refuses an empty branch and sessions without a worktree', async () => {
  const repo = makeClone();
  const s = await api('/sessions', { body: { prompt: 'look around', cwd: repo.dir, agent: 'claude' } });
  const done = await settled(s.id);
  fs.writeFileSync(path.join(done.worktree.path, 'math.js'), fs.readFileSync(path.join(repo.dir, 'math.js'))); // undo the edit
  await assert.rejects(api(`/sessions/${s.id}/ship`, { body: { title: 'nothing' } }), /no changes/);
  const flat = await api('/sessions', { body: { prompt: 'x', cwd: repo.dir, agent: 'claude', worktree: false } });
  await settled(flat.id);
  await assert.rejects(api(`/sessions/${flat.id}/ship`), /worktree sessions/);
});

// One task across two repos (also): the agent gets the second as an extra dir, each repo its own
// worktree; Ship it opens a PR in each, and Merge merges both and syncs both checkouts.
test('one task across two repos: a worktree each, a PR each, merged together', async () => {
  const api1 = makeClone();
  const web = makeClone();
  const s = await api('/sessions', { body: { prompt: 'ALSO fix add() in both repos', cwd: api1.dir, also: [web.dir, api1.dir, path.join(api1.dir, '.')], agent: 'claude' } });
  assert.equal(s.also.length, 1, 'cwd itself is dropped from also');
  assert.equal(fs.realpathSync(s.also[0].cwd), fs.realpathSync(web.dir));
  assert.match(s.also[0].branch, /^wisp\/also-fix-add-in-both-repos-/);
  const done = await settled(s.id);
  const [extra] = done.also;
  // The agent ran in the first repo's worktree with the second's worktree as an extra dir, and was told about it.
  const run = records(RECORD, 'claude').findLast((r) => fs.realpathSync(r.cwd) === fs.realpathSync(done.worktree.path));
  assert.ok(run.argv.slice(run.argv.indexOf('--add-dir')).includes(extra.worktree.cwd), run.argv.join(' '));
  assert.match(run.argv[run.argv.indexOf('--append-system-prompt') + 1], /This task spans 2 folders/);
  for (const dir of [done.worktree.path, extra.worktree.path]) assert.match(fs.readFileSync(path.join(dir, 'math.js'), 'utf8'), /a \+ b/);
  for (const dir of [api1.dir, web.dir]) assert.match(fs.readFileSync(path.join(dir, 'math.js'), 'utf8'), /a - b/);
  // Both folders are projects, and the task lists under either one.
  const projects = (await api('/config')).projects;
  const webProject = projects.find((p) => fs.realpathSync(p.path) === fs.realpathSync(web.dir));
  assert.ok(webProject);
  assert.ok((await api(`/sessions?project=${webProject.id}`)).some((x) => x.id === s.id));
  assert.ok((await api(`/sessions?cwd=${encodeURIComponent(web.dir)}`)).some((x) => x.id === s.id));

  const toShip = async () => (await api('/sessions')).find((x) => x.id === s.id).toShip;
  await until(async () => (await toShip())?.repos === 2);
  const draft = await api(`/sessions/${s.id}/ship`);
  assert.equal(draft.repos.length, 2);
  assert.equal(draft.dirty, 2);
  setGh({ checks: [], review: '' });
  const pr = await api(`/sessions/${s.id}/ship`, { body: { title: 'fix: add adds' } });
  assert.equal(pr.prs.length, 2);
  for (const [repo, wt] of [[api1, done.worktree], [web, extra.worktree]]) assert.match(repo.git('--git-dir', repo.remote, 'log', '--format=%s%n%b', wt.branch), /fix: add adds\n[\s\S]*Part of one task across/);
  const sum = (await api('/sessions')).find((x) => x.id === s.id);
  assert.equal(sum.also[0].pr.number, pr.prs[1].number);
  await until(async () => (await toShip())?.repos === 0);
  await assert.rejects(api(`/sessions/${s.id}/ship`, { body: { title: 'again' } }), /none of the task’s repos have new changes/);

  const r = await api(`/sessions/${s.id}/merge`, { body: {} });
  assert.deepEqual(r.prs.map((x) => x.state), ['MERGED', 'MERGED']);
  for (const repo of [api1, web]) assert.match(fs.readFileSync(path.join(repo.dir, 'math.js'), 'utf8'), /a \+ b/);
  assert.equal(fs.existsSync(extra.worktree.path), false);
  assert.equal((await session(s.id)).state, 'done');
});

test('also: a folder that is not there is refused; one that is not a repo is used in place', async () => {
  const repo = makeClone();
  await assert.rejects(api('/sessions', { body: { prompt: 'x', cwd: repo.dir, also: [path.join(repo.dir, 'nope')], agent: 'claude' } }), /Not a directory/);
  const plain = tmp('plain-also');
  const s = await api('/sessions', { body: { prompt: 'ALSO look', cwd: repo.dir, also: [plain], agent: 'claude' } });
  assert.equal(s.also[0].branch, '');
  const done = await settled(s.id);
  assert.equal(done.also[0].worktree, undefined);
  const run = records(RECORD, 'claude').findLast((r) => fs.realpathSync(r.cwd) === fs.realpathSync(done.worktree.path));
  assert.ok(run.argv.includes(done.also[0].cwd));
  // Deleting the task removes its worktrees and leaves the plain folder alone.
  await api(`/sessions/${s.id}`, { method: 'DELETE' });
  assert.equal(fs.existsSync(plain), true);
});

test('archive drops a clean worktree and a follow-up brings it back; delete removes it', async () => {
  const repo = makeClone();
  const s = await api('/sessions', { body: { prompt: 'Tidy math.js', cwd: repo.dir, agent: 'claude' } });
  const { worktree: wt } = await settled(s.id);
  // Dirty: archiving keeps it, so nothing is lost.
  await api(`/sessions/${s.id}`, { method: 'PATCH', body: { archived: true } });
  assert.equal(fs.existsSync(wt.path), true);
  // Committed: archiving removes the checkout but keeps the branch.
  repo.git('-C', wt.path, 'commit', '-qam', 'wip');
  await api(`/sessions/${s.id}`, { method: 'PATCH', body: { archived: false } });
  await api(`/sessions/${s.id}`, { method: 'PATCH', body: { archived: true } });
  assert.equal(fs.existsSync(wt.path), false);
  assert.notEqual(repo.git('branch', '--list', wt.branch), '');
  await api(`/sessions/${s.id}/reply`, { body: { text: 'one more thing' } });
  await until(() => fs.existsSync(wt.path));
  await settled(s.id);
  assert.equal(repo.git('-C', wt.path, 'log', '-1', '--format=%s'), 'wip');
  await api(`/sessions/${s.id}`, { method: 'DELETE' });
  assert.equal(fs.existsSync(wt.path), false);
  assert.notEqual(repo.git('branch', '--list', wt.branch), '', 'a branch with commits survives');
});

test('compare: one task on two harnesses, each in its own worktree; discard the loser', async () => {
  const repo = makeClone();
  const s = await api('/sessions', { body: { prompt: 'Fix add()', cwd: repo.dir, agent: 'claude', compare: [{ agent: 'codex' }] } });
  assert.equal(s.group.length, 2);
  const [a, b] = s.group;
  assert.deepEqual([a.agent, b.agent], ['claude', 'codex']);
  assert.ok(a.groupId && a.groupId === b.groupId);
  assert.notEqual(a.branch, b.branch);
  const [fa, fb] = await Promise.all([settled(a.id), settled(b.id)]);
  for (const f of [fa, fb]) assert.match(fs.readFileSync(path.join(f.worktree.path, 'math.js'), 'utf8'), /a \+ b/);
  // Both branch from the same fetched commit, and that commit is the first turn's checkpoint.
  const head = repo.git('rev-parse', 'origin/main');
  for (const f of [fa, fb]) {
    assert.equal(f.worktree.head, head);
    assert.equal(f.turns[0].checkpoint.commit, head);
    assert.equal(f.turns[0].checkpoint.dirty, false);
    const math = f.turns[0].changes.find((c) => c.file === 'math.js');
    assert.match(math.beforeFile, /a - b/, 'diffs read the base from the checkpoint');
  }
  // One task: the runs keep the prompt's title instead of each taking its own headline.
  assert.deepEqual([fa.title, fb.title], ['Fix add()', 'Fix add()']);
  await api(`/sessions/${b.id}`, { method: 'PATCH', body: { archived: true, discardWorktree: true } });
  assert.equal(fs.existsSync(fb.worktree.path), false);
  assert.equal(repo.git('branch', '--list', fb.worktree.branch), '');
  assert.equal(fs.existsSync(fa.worktree.path), true);
  // Comparing needs worktrees.
  await assert.rejects(api('/sessions', { body: { prompt: 'x', cwd: tmp('nogit'), agent: 'claude', compare: [{ agent: 'codex' }] } }), /Compare needs a git repo/);
});

test('recipes: params, CRUD, run by id or name, positional words', async () => {
  assert.deepEqual(params('Release {version} on {branch}, then {version} again; JSON {"a": 1} and {x y} stay'), ['version', 'branch']);
  assert.equal(fill('v{version}', { version: '1.2' }), 'v1.2');
  assert.throws(() => fill('v{version}', {}), /Missing \{version\}/);
  assert.equal(fill('a{x}b', { x: '{y}' , y: 'no' }), 'a{y}b', 'values are not re-expanded');
  assert.equal(fill('#{n} {body}', { n: 3 }, { strict: false }), '#3 ');
  assert.deepEqual(positional('{a} {b}', ['1', '2', '3']), { a: '1', b: '2' });

  const repo = makeRepo();
  const r = await api('/recipes', { body: { name: 'Release', prompt: 'Prepare release {version}', mode: 'plan', agent: 'codex' } });
  assert.deepEqual(r.params, ['version']);
  await assert.rejects(api('/recipes', { body: { name: '', prompt: 'x' } }), /needs a name/);
  await assert.rejects(api(`/recipes/${r.id}/run`, { body: { cwd: repo } }), /Missing \{version\}/);
  const s = await api('/recipes/release/run', { body: { words: ['0.8.0'], cwd: repo } });
  assert.equal(s.agent, 'codex');
  assert.equal(s.mode, 'plan');
  assert.deepEqual(s.origin, { kind: 'recipe', id: r.id, name: 'Release' });
  assert.equal((await session(s.id)).turns[0].prompt, 'Prepare release 0.8.0');
  await settled(s.id);
  assert.equal((await api(`/recipes/${r.id}`)).runs, 1);
  await api(`/recipes/${r.id}`, { method: 'PATCH', body: { prompt: 'Release {version} to {channel}' } });
  assert.deepEqual((await api('/recipes')).find((x) => x.id === r.id).params, ['version', 'channel']);
  await api(`/recipes/${r.id}`, { method: 'DELETE' });
  assert.equal((await api('/recipes')).length, 0);
});

test('cron: fields, ranges, steps, day-of-week/month OR rule, next run', () => {
  const at = (s) => new Date(s);
  const weekdays9 = parseCron('0 9 * * 1-5');
  assert.equal(cronMatches(weekdays9, at('2026-10-19T09:00:00')), true); // Monday
  assert.equal(cronMatches(weekdays9, at('2026-10-18T09:00:00')), false); // Sunday
  assert.equal(new Date(nextRun(weekdays9, at('2026-10-17T10:00:00').getTime())).toString(), at('2026-10-19T09:00:00').toString());
  assert.equal(new Date(nextRun(parseCron('*/15 * * * *'), at('2026-10-17T10:07:30').getTime())).getMinutes(), 15);
  const either = parseCron('0 0 1 * 0'); // the 1st, or any Sunday
  assert.equal(cronMatches(either, at('2026-10-18T00:00:00')), true);
  assert.equal(cronMatches(either, at('2026-11-01T00:00:00')), true);
  assert.equal(cronMatches(parseCron('@weekly'), at('2026-10-18T00:00:00')), true);
  assert.equal(cronMatches(parseCron('0 0 * * 7'), at('2026-10-18T00:00:00')), true, '7 is Sunday');
  assert.throws(() => parseCron('61 * * * *'), /minute/);
  assert.throws(() => parseCron('* * *'), /5 fields/);
});

test('triggers: a schedule fires once per matching minute; CI and issue watchers fire for new items only', async () => {
  const repo = makeRepo();
  const t = srv.triggers;
  const sched = await api('/triggers', { body: { kind: 'schedule', cwd: repo, cron: '30 9 * * *', prompt: 'Morning triage', agent: 'claude' } });
  assert.ok(sched.nextAt > Date.now());
  await assert.rejects(api('/triggers', { body: { kind: 'schedule', cwd: repo, cron: 'nope', prompt: 'x' } }), /5 fields/);
  const realNow = t.now;
  t.now = () => new Date('2026-10-19T09:30:10').getTime();
  await t.tick();
  await t.tick(); // same minute: no second run
  t.now = realNow;
  let list = await api('/triggers');
  const fired = list.find((x) => x.id === sched.id);
  assert.equal(fired.runs, 1);
  const s = await session(fired.lastSessionId);
  assert.equal(s.turns[0].prompt, 'Morning triage');
  assert.deepEqual(s.origin, { kind: 'trigger', id: sched.id, name: 'Scheduled task' });
  await settled(s.id);

  // CI: the first poll only records what's already failing.
  setGh({ runs: [{ databaseId: 11, name: 'test', displayTitle: 'old', headBranch: 'main', headSha: 'aaaaaaa1', url: 'https://x/runs/11' }] });
  const ci = await api('/triggers', { body: { kind: 'ci', cwd: repo, branch: 'main', agent: 'claude' } });
  let r = await api(`/triggers/${ci.id}/run`, { body: {} });
  assert.equal(r.started.length, 1, 'Check now acts on what it finds'); // forced
  setGh({ runs: [{ databaseId: 12, name: 'lint', headBranch: 'main', headSha: 'bbbbbbb2', url: 'https://x/runs/12' }, ...ghState().runs] });
  const tr = srv.store.config.triggers.find((x) => x.id === ci.id);
  tr.lastPolledAt = 0;
  await t.tick();
  list = await api('/triggers');
  assert.equal(list.find((x) => x.id === ci.id).runs, 2);
  const ciRun = await session(list.find((x) => x.id === ci.id).lastSessionId);
  assert.match(ciRun.turns[0].prompt, /"lint" failed on main \(https:\/\/x\/runs\/12\)[\s\S]*gh run view 12 --log-failed/);
  await settled(ciRun.id);
  tr.lastPolledAt = 0;
  await t.tick();
  assert.equal((await api('/triggers')).find((x) => x.id === ci.id).runs, 2, 'nothing new, nothing started');
  const runList = records(RECORD, 'gh').filter((x) => x.argv[0] === 'run').at(-1).argv;
  assert.deepEqual(runList.slice(runList.indexOf('--branch')), ['--branch', 'main']);

  // Issues: seeded on the first scheduled poll, then fires for a newly labelled one, in plan mode by default.
  setGh({ issues: [{ number: 1, title: 'old bug', body: '', url: 'u1', labels: ['wisp'] }] });
  const iss = await api('/triggers', { body: { kind: 'issues', cwd: repo, label: 'wisp', agent: 'claude' } });
  assert.equal(iss.mode, 'plan');
  const it = srv.store.config.triggers.find((x) => x.id === iss.id);
  await t.tick();
  assert.equal(it.runs, 0);
  assert.equal(it.seeded, true);
  setGh({ issues: [{ number: 2, title: 'Crash on {title}', body: 'Steps: {number}', url: 'u2', labels: ['wisp'], author: { login: 'octo' } }, ...ghState().issues] });
  it.lastPolledAt = 0;
  await t.tick();
  assert.equal(it.runs, 1);
  const issRun = await session(it.lastSessionId);
  assert.equal(issRun.mode, 'plan');
  assert.match(issRun.turns[0].prompt, /^GitHub issue #2: Crash on \{title\}\nu2\n\n<issue>\nSteps: \{number\}\n<\/issue>/);
  await settled(issRun.id);

  // A failing gh shows up on the trigger instead of throwing.
  await api(`/triggers/${iss.id}`, { method: 'PATCH', body: { cwd: tmp('elsewhere') } });
  setGh({ issues: 'not json' });
  it.lastPolledAt = 0;
  await t.tick();
  assert.match((await api('/triggers')).find((x) => x.id === iss.id).lastError, /JSON/);
  for (const x of await api('/triggers')) await api(`/triggers/${x.id}`, { method: 'DELETE' });
});

test('usage: spend, outcomes and questions per day, project and harness', () => {
  const now = new Date('2026-10-17T15:00:00').getTime();
  const day = 864e5;
  const turn = (o) => ({ startedAt: now - 1000, endedAt: now, status: 'done', activity: [], presentation: { blocks: [{ type: 'hero', status: 'done' }] }, ...o });
  const sessions = [
    { id: 'a', agent: 'claude', model: 'opus', cwd: '/p/one', turns: [turn({ stats: { costUsd: 0.5, inputTokens: 10 } }), turn({ stats: { costUsd: 0.25 }, presentation: { blocks: [{ type: 'hero', status: 'blocked' }] }, activity: [{ kind: 'ask' }] })] },
    { id: 'b', agent: 'codex', model: '', cwd: '/p/two', turns: [turn({ startedAt: now - 2 * day, stats: { inputTokens: 5 } }), turn({ status: 'error' })] },
    { id: 'c', agent: 'claude', cwd: '/p/one', turns: [turn({ startedAt: now - 40 * day, stats: { costUsd: 9 } })] }, // out of range
    { id: 'w', agent: 'wisp', cwd: '', turns: [turn({})] }, // the tour
  ];
  const u = usage(sessions, { days: 7, now, project: (s) => ({ id: s.cwd, name: s.cwd.split('/').pop(), color: 'teal' }) });
  assert.equal(u.total.turns, 4);
  assert.equal(u.total.sessions, 2);
  assert.equal(u.total.cost, 0.75);
  assert.equal(u.total.priced, 2);
  assert.equal(u.total.successRate, 0.5);
  assert.equal(u.total.questions, 1);
  assert.equal(u.daily.length, 7);
  assert.equal(u.daily.at(-1).turns, 3);
  assert.equal(u.daily.at(-3).turns, 1);
  assert.deepEqual(u.projects.map((p) => [p.name, p.turns, p.cost]), [['one', 2, 0.75], ['two', 2, 0]]);
  assert.deepEqual(u.runners.map((r) => [r.agent, r.model, r.successRate]), [['claude', 'opus', 0.5], ['codex', '', 0.5]]);
});

test('toolStats: tool calls by kind, harness, project and day, with spend and success; filters by harness and project', () => {
  const now = new Date('2026-10-17T15:00:00').getTime();
  const day = 864e5;
  const turn = (kinds, o) => ({ startedAt: now - 1000, endedAt: now, status: 'done', activity: kinds.map((kind) => ({ t: o?.startedAt ?? now - 500, kind })), presentation: { blocks: [{ type: 'hero', status: 'done' }] }, ...o });
  const sessions = [
    { id: 'a', agent: 'claude', cwd: '/p/one', turns: [turn(['read', 'read', 'edit', 'run', 'text', 'error'], { stats: { costUsd: 0.5 } }), turn(['run', 'ask', 'answer'], { agent: 'codex', status: 'error' })] },
    { id: 'b', agent: 'codex', cwd: '/p/two', turns: [turn(['search', 'run'], { startedAt: now - 2 * day })] },
    { id: 'c', agent: 'claude', cwd: '/p/one', turns: [turn(['run'], { startedAt: now - 40 * day })] }, // out of range
    { id: 'r', agent: 'claude', cwd: '/p/one', turns: [turn(['run'], { status: 'running' })] }, // still running
    { id: 'w', agent: 'wisp', cwd: '', turns: [turn(['read'])] }, // the tour
  ];
  const project = (s) => ({ id: `id-${s.cwd}`, name: s.cwd.split('/').pop() });
  const st = toolStats(sessions, { days: 7, now, project });
  assert.equal(st.total.calls, 8, 'text, error and answer are not tool calls');
  assert.deepEqual([st.total.turns, st.total.sessions, st.total.cost], [3, 2, 0.5]);
  assert.equal(Math.round(st.total.successRate * 100), 67);
  assert.deepEqual(st.kinds.map((k) => [k.kind, k.calls]), [['run', 3], ['read', 2], ['edit', 1], ['ask', 1], ['search', 1]]);
  assert.deepEqual(st.agents.map((a) => [a.agent, a.calls, a.turns, a.successRate]), [['claude', 4, 1, 1], ['codex', 4, 2, 0.5]], 'a turn counts for the harness that ran it');
  assert.deepEqual(st.projects.map((p) => [p.name, p.calls, p.turns, p.cost]), [['one', 6, 2, 0.5], ['two', 2, 1, 0]]);
  assert.equal(st.daily.length, 7);
  assert.deepEqual([st.daily.at(-1).calls, st.daily.at(-3).calls], [6, 2]);

  const codex = toolStats(sessions, { days: 7, now, project, filter: { agent: 'codex' } });
  assert.deepEqual([codex.total.calls, codex.total.turns, codex.agents.map((a) => a.agent)], [4, 2, ['codex']]);
  const two = toolStats(sessions, { days: 7, now, project, filter: { project: 'two' } });
  assert.deepEqual([two.total.calls, two.projects.map((p) => p.name)], [2, ['two']]);
  assert.equal(toolStats(sessions, { days: 7, now, project, filter: { project: 'id-/p/one' } }).total.calls, 6, 'matches a project id too');

  const text = toolStatsText(st);
  assert.match(text, /^## wisp tool stats — last 7 days\n8 tool calls in 3 turns across 2 sessions\. Success rate 67%, cost \$0\.50 \(1\/3 turns priced\)/);
  assert.match(text, /\| run \| 3 \| 38% \|/);
  assert.match(text, /\| codex \| 4 \| 2 \| 50% \| — \| run 2, ask 1, search 1 \|/);
  assert.match(toolStatsText(toolStats([], { days: 1, now })), /last 1 day\n0 tool calls[\s\S]*No finished turns/);
});

test('phone: ntfy buttons and Telegram replies answer the agent; forged taps are ignored; /new starts tasks', async () => {
  // One fake server plays both ntfy (publish + poll) and the Telegram Bot API.
  const ntfy = { published: [], replies: [] };
  const tg = { sent: [], updates: [], next: 1, msg: 100, calls: [] };
  const fake = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const u = new URL(req.url, 'http://x');
    const json = (o) => (res.writeHead(200, { 'content-type': 'application/json' }), res.end(JSON.stringify(o)));
    if (u.pathname.startsWith('/bot')) {
      const method = u.pathname.split('/').pop();
      const b = body ? JSON.parse(body) : {};
      tg.calls.push(method);
      if (method === 'getUpdates') {
        const out = tg.updates.filter((x) => x.update_id >= (b.offset || 0));
        if (!out.length) await new Promise((r) => setTimeout(r, 100));
        return json({ ok: true, result: out });
      }
      if (method === 'sendMessage') {
        tg.sent.push(b);
        return json({ ok: true, result: { message_id: ++tg.msg } });
      }
      return json({ ok: true, result: true });
    }
    if (req.method === 'POST' && u.pathname === '/') return ntfy.published.push(JSON.parse(body)), json({ id: 'p' });
    if (req.method === 'POST') return ntfy.replies.push({ id: `r${ntfy.replies.length + 1}`, event: 'message', time: Date.now() / 1000, message: body }), json({});
    if (u.pathname.endsWith('-reply/json')) {
      const since = u.searchParams.get('since');
      const at = ntfy.replies.findIndex((m) => m.id === since);
      const out = /^\d+$/.test(since) ? ntfy.replies : ntfy.replies.slice(at + 1);
      res.writeHead(200);
      return res.end(out.map((m) => JSON.stringify(m)).join('\n'));
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const fakeUrl = `http://127.0.0.1:${fake.address().port}`;
  process.env.WISP_TELEGRAM_API = fakeUrl;
  srv.remote.ntfyPollMs = 100;
  srv.remote.tgLongPoll = 0;
  const tgUpdate = (o) => tg.updates.push({ update_id: tg.next++, ...o });
  try {
    let view = await api('/remote', { method: 'PUT', body: { ntfy: { enabled: true, server: fakeUrl, topic: 'wisp-test-topic' }, telegram: { enabled: true, token: '123:abc' } } });
    assert.equal(view.telegram.token, '••••:abc');
    assert.equal(view.telegram.linked, false);
    assert.match(view.telegram.linkCode, /^\d{6}$/);
    assert.equal((await api('/config')).remote, undefined, 'secrets stay out of /api/config');

    // Linking: a stranger's message is ignored, the code links the chat.
    tgUpdate({ message: { message_id: 1, chat: { id: 666 }, text: 'hi' } });
    tgUpdate({ message: { message_id: 2, chat: { id: 42, first_name: 'Ada' }, text: `/link ${view.telegram.linkCode}` } });
    view = await until(async () => ((await api('/remote')).telegram.linked ? api('/remote') : null));
    assert.equal(view.telegram.chatName, 'Ada');

    // A question goes out on both channels with its options as buttons.
    const repo = makeRepo();
    const s = await api('/sessions', { body: { prompt: 'ASK before fixing', cwd: repo, agent: 'claude', worktree: false } });
    await until(async () => (await session(s.id)).state === 'waiting');
    const note = await until(() => ntfy.published.find((p) => p.title.includes('❓')));
    assert.equal(note.topic, 'wisp-test-topic');
    assert.match(note.message, /Proceed with the fix\?/);
    assert.deepEqual(note.actions.map((a) => a.label), ['Yes', 'No']);
    const tgQ = await until(() => tg.sent.find((m) => m.text.includes('Proceed with the fix?')));
    assert.equal(tgQ.chat_id, 42);
    assert.deepEqual(tgQ.reply_markup.inline_keyboard.map((r) => r[0].text), ['Yes', 'No']);

    // A forged tap (bad signature) does nothing; the real button answers.
    const yes = JSON.parse(note.actions[0].body);
    await fetch(note.actions[0].url, { method: 'POST', body: JSON.stringify({ ...yes, i: 1, sig: 'x'.repeat(22) }) });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal((await session(s.id)).state, 'waiting');
    await fetch(note.actions[0].url, { method: 'POST', body: note.actions[0].body });
    const done = await settled(s.id);
    assert.match(done.turns[0].presentation.blocks[0].summary, /Answer was: .*Yes/);

    // The finished notice offers Mark done; replying to it on Telegram sends a follow-up.
    const fin = await until(() => tg.sent.find((m) => m.text.startsWith('✅') && /Answer was: .*Yes/.test(m.text)));
    assert.deepEqual(fin.reply_markup.inline_keyboard.map((r) => r[0].text), ['Mark done']);
    const finId = tg.msg; // the message id our fake handed out for it
    tgUpdate({ message: { message_id: 3, chat: { id: 42 }, text: 'also add a test', reply_to_message: { message_id: finId } } });
    await until(async () => (await session(s.id)).turns.length === 2);
    assert.equal((await session(s.id)).turns[1].prompt, 'also add a test');
    await settled(s.id);
    // The Mark done button on the latest message closes it out.
    const last = await until(() => tg.sent.filter((m) => m.text.startsWith('✅')).at(1));
    tgUpdate({ callback_query: { id: 'cb1', data: last.reply_markup.inline_keyboard[0][0].callback_data, message: { message_id: tg.msg, chat: { id: 42 } } } });
    await until(async () => (await session(s.id)).state === 'done');
    await until(() => tg.calls.includes('answerCallbackQuery')); // answered after the task is marked done

    // Starting tasks: off by default, so /new is refused and nothing launches.
    assert.equal(view.telegram.allowStart, false);
    const count = (await api('/sessions')).length;
    tgUpdate({ message: { message_id: 10, chat: { id: 42 }, text: '/new add a README' } });
    await until(() => tg.sent.find((m) => /Starting tasks from Telegram is off/.test(m.text)));
    assert.equal((await api('/sessions')).length, count);

    // Switched on: /projects lists them, /new @name picks one, plain /new uses the default.
    const other = makeRepo();
    await api('/projects', { body: { path: other } });
    const projects = (await api('/config')).projects;
    const otherP = projects.find((p) => p.path === other);
    view = await api('/remote', { method: 'PUT', body: { telegram: { allowStart: true } } });
    assert.equal(view.telegram.allowStart, true);
    assert.equal(view.telegram.linked, true, 'switching it on keeps the chat linked');
    await assert.rejects(api('/remote', { method: 'PUT', body: { telegram: { project: 'nope' } } }), /Unknown project/);

    tgUpdate({ message: { message_id: 11, chat: { id: 42 }, text: '/projects' } });
    const list = await until(() => tg.sent.find((m) => m.text.startsWith('Projects:')));
    assert.match(list.text, new RegExp(`• ${otherP.name}`));

    tgUpdate({ message: { message_id: 12, chat: { id: 42 }, text: '/new@wispbot @nosuchproject do it' } });
    await until(() => tg.sent.find((m) => /No project matches “nosuchproject”/.test(m.text)));
    tgUpdate({ message: { message_id: 13, chat: { id: 666 }, text: '/new from a stranger' } });
    tgUpdate({ message: { message_id: 17, chat: { id: 42 }, date: Math.floor(Date.now() / 1000) - 3600, text: '/new sent while offline' } });
    await until(() => tg.sent.find((m) => m.reply_to_message_id === 17 && /arrived while wisp was offline/.test(m.text)));

    tgUpdate({ message: { message_id: 14, chat: { id: 42 }, text: `/new @${otherP.name.toUpperCase()} write the docs` } });
    const started = await until(() => tg.sent.find((m) => m.text.startsWith(`▶ Started in ${otherP.name}`)));
    assert.equal(started.reply_to_message_id, 14);
    const startedId = tg.msg;
    const byPrompt = async (text) => {
      for (const x of await api('/sessions')) if ((await session(x.id)).turns[0]?.prompt === text) return x;
      return null;
    };
    const t1 = await until(() => byPrompt('write the docs'));
    assert.equal(t1.projectId, otherP.id);
    assert.deepEqual(t1.origin, { kind: 'telegram', name: 'Telegram' });
    await settled(t1.id);
    // Replying to the Started message follows up on that task.
    tgUpdate({ message: { message_id: 15, chat: { id: 42 }, text: 'and a changelog', reply_to_message: { message_id: startedId } } });
    await until(async () => (await session(t1.id)).turns.length === 2);
    await settled(t1.id);
    // A /btw reply is a side question: no new turn, and its answer comes back as its own message.
    tgUpdate({ message: { message_id: 18, chat: { id: 42 }, text: '/btw what changed?', reply_to_message: { message_id: startedId } } });
    await until(() => tg.sent.find((m) => m.reply_to_message_id === 18 && /Asking on the side/.test(m.text)));
    const btwMsg = await until(() => tg.sent.find((m) => m.reply_to_message_id === 18 && m.text.startsWith('btw: ')));
    // /new is routed by Auto, so the harness varies: one that can't fork answers from wisp's record.
    assert.equal(btwMsg.text, `btw: Side answer (${adapters[t1.agent].fork ? 'forked' : 'digest'}): what changed?`);
    assert.equal((await session(t1.id)).turns.length, 2);

    // The default project from settings, for /new without @.
    await api('/remote', { method: 'PUT', body: { telegram: { project: otherP.id } } });
    tgUpdate({ message: { message_id: 16, chat: { id: 42 }, text: '/new tidy up' } });
    const t2 = await until(() => byPrompt('tidy up'));
    assert.equal(t2.projectId, otherP.id);
    await settled(t2.id);
    assert.equal(await byPrompt('from a stranger'), null);
    assert.equal(await byPrompt('sent while offline'), null);
    // Settings changes restart the poll; updates already handled don't run again.
    assert.equal((await api('/sessions')).length, count + 2);
  } finally {
    await api('/remote', { method: 'PUT', body: { ntfy: { enabled: false }, telegram: { enabled: false } } });
    delete process.env.WISP_TELEGRAM_API;
    fake.closeAllConnections?.();
    fake.close();
  }
});

// Worktrees made at once in one repo (compare runs) take turns: on Windows, git reading the
// other's half-made .git/worktrees entry failed the launch.
test('worktrees made side by side in one repo all come out whole', async () => {
  const { createWorktree, worktreeSource } = await import('../server/git.js');
  const cwd = makeRepo();
  const home = tmp('wt-home');
  const source = await worktreeSource(cwd);
  const trees = await Promise.all(['aaaaaa1', 'bbbbbb2', 'cccccc3', 'dddddd4'].map((id) => createWorktree({ cwd, home, id, title: 'same task', source })));
  assert.equal(new Set(trees.map((t) => t.branch)).size, 4);
  for (const t of trees) assert.ok(fs.existsSync(path.join(t.path, 'math.js')), t.path);
});
