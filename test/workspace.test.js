// The panel beside a task, through a real wisp server, real git and a fake `gh`: the folder the
// task was built in, a shell there (on a real pty), opening it in a terminal app, and its PRs in
// full (each check, reviewers, comments with the bots marked, inline threads).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { installFakeBins, makeClone, tmp, until } from './helpers.js';

const win = process.platform === 'win32';
const GH_STATE = path.join(tmp('gh'), 'state.json');
process.env.FAKE_GH_STATE = GH_STATE;
process.env.WISP_HOME = tmp('workspace-home');
process.env.WISP_UPDATE_CHECK = '0';
process.env.WISP_NO_OPEN = '1';
process.env.SHELL = '/bin/sh'; // the same shell everywhere, whatever the developer's is
installFakeBins();

const { startServer } = await import('../server/index.js');
const { python } = await import('../server/pty.js');
const { isBot, prDetailOf, threadsOf } = await import('../server/git.js');

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
  const r = await fetch(`${base}/api${p}`, { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : method && method !== 'GET' ? '{}' : undefined });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(`${p}: ${j.error}`), { status: r.status });
  return j;
}
const settled = (id) => until(async () => ((await api(`/sessions/${id}`)).state === 'review' ? api(`/sessions/${id}`) : null));
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

test('workspace: the worktree, its branch and what is not shipped yet', async () => {
  const repo = makeClone();
  const s = await api('/sessions', { body: { prompt: 'Fix add() so it adds', cwd: repo.dir, agent: 'claude' } });
  const done = await settled(s.id);
  const w = await api(`/sessions/${s.id}/workspace`);
  assert.equal(w.dir, done.worktree.cwd || done.worktree.path);
  assert.equal(w.gone, false);
  assert.equal(w.worktree.branch, done.worktree.branch);
  assert.equal(w.worktree.base, 'main');
  assert.deepEqual(w.status, { dirty: 1, ahead: 0, unpushed: 0 });
  assert.equal(w.shell.supported, !win);
  assert.equal(w.shell.open, false);
  // A desktop at this computer: its terminal app can open the folder.
  assert.equal(w.shell.app, process.platform === 'darwin' || process.platform === 'win32' || !!process.env.DISPLAY || !!process.env.WAYLAND_DISPLAY);
  if (w.shell.app) assert.equal((await api(`/sessions/${s.id}/open-shell`, { method: 'POST' })).dir, w.dir);
  else await assert.rejects(api(`/sessions/${s.id}/open-shell`, { method: 'POST' }), (e) => e.status === 409 && /use the one in the panel/.test(e.message));
  await assert.rejects(api('/sessions/nope/workspace'), (e) => e.status === 404);
});

test('shell: a login shell in the worktree the page streams, types into and ends; the task stays free', { skip: win || !python() }, async () => {
  const repo = makeClone();
  const s = await api('/sessions', { body: { prompt: 'Fix add() so it adds', cwd: repo.dir, agent: 'claude' } });
  await settled(s.id);
  const { dir } = await api(`/sessions/${s.id}/workspace`);
  const start = await api(`/sessions/${s.id}/shell`, { body: { cols: 90, rows: 20 } });
  assert.equal(start.started, true);
  assert.equal(start.dir, dir);
  assert.equal((await api(`/sessions/${s.id}/shell`, { body: { cols: 90, rows: 20 } })).started, false, 'opening it again shows the same shell');
  assert.equal((await api(`/sessions/${s.id}/workspace`)).shell.open, true);
  // Not a take over: the card doesn't say "In terminal" and follow-ups still go to the agent.
  assert.equal((await api('/sessions')).find((x) => x.id === s.id).term, undefined);

  const ctl = new AbortController();
  const r = await fetch(`${base}/api/sessions/${s.id}/shell`, { signal: ctl.signal });
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const reader = r.body.getReader();
  let text = '';
  const read = async (re) => {
    const end = Date.now() + 15_000;
    while (!re.test(text)) {
      let timer;
      const quiet = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`no ${re} in: ${JSON.stringify(text)}`)), end - Date.now())));
      const { value, done } = await Promise.race([reader.read(), quiet]).finally(() => clearTimeout(timer));
      if (done) throw new Error(`the stream ended without ${re}: ${JSON.stringify(text)}`);
      text += new TextDecoder().decode(value);
    }
  };
  await read(/event: hello/);
  await api(`/sessions/${s.id}/shell`, { body: { data: 'echo "at:$(pwd)" && git rev-parse --abbrev-ref HEAD\r' } });
  const real = fs.realpathSync(dir);
  await read(new RegExp(`at:(${dir}|${real})`.replace(/\//g, '\\/')));
  await read(/wisp\//); // the task's branch
  assert.equal((await api('/status')).terms, 1, 'a shell in use keeps a cloud computer awake');
  await api(`/sessions/${s.id}/shell`, { body: { data: 'exit\r' } });
  await read(/event: exit\ndata: \{"code":0\}/);
  ctl.abort();
  await assert.rejects(api(`/sessions/${s.id}/shell`, { body: { data: 'x' } }), (e) => e.status === 404 && /ended/.test(e.message));
  // Start again: a fresh one.
  assert.equal((await api(`/sessions/${s.id}/shell`, { body: { restart: true } })).started, true);
  assert.equal((await api(`/sessions/${s.id}/shell`, { method: 'DELETE' })).ok, true);
  assert.equal((await api(`/sessions/${s.id}/workspace`)).shell.open, false);
});

test('prs: each check failing first, reviewers where they stand, comments with bots marked, inline threads', async () => {
  const repo = makeClone();
  const s = await api('/sessions', { body: { prompt: 'Fix add() so it adds', cwd: repo.dir, agent: 'claude' } });
  await settled(s.id);
  await api(`/sessions/${s.id}/ship`, { body: { title: 'fix: add adds' } });
  const st = ghState();
  const pr = Object.values(st.prs).at(-1);
  Object.assign(pr, {
    body: 'Fixes add().',
    author: { login: 'M0xoo' },
    additions: 3,
    deletions: 1,
    changedFiles: 1,
    files: [{ path: 'add.js', additions: 3, deletions: 1 }],
    reviews: [
      { author: { login: 'lena' }, state: 'COMMENTED', body: '', submittedAt: '2026-10-28T10:00:00Z' },
      { author: { login: 'lena' }, state: 'APPROVED', body: 'Looks right.', submittedAt: '2026-10-28T11:00:00Z' },
    ],
    comments: [
      { author: { login: 'vercel' }, body: 'Preview ready', createdAt: '2026-10-28T09:00:00Z', url: 'https://github.com/acme/repo/pull/1#c1' },
      { author: { login: 'sam' }, body: 'Does it handle negatives?', createdAt: '2026-10-28T09:30:00Z', url: 'https://github.com/acme/repo/pull/1#c2' },
    ],
  });
  setGh({
    prs: st.prs,
    checks: [
      { __typename: 'CheckRun', name: 'test (22)', workflowName: 'PR', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-10-28T09:00:00Z', completedAt: '2026-10-28T09:01:05Z', detailsUrl: 'https://github.com/acme/repo/actions/runs/1/job/1' },
      { __typename: 'CheckRun', name: 'lint', workflowName: 'PR', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2026-10-28T09:00:00Z', completedAt: '2026-10-28T09:00:20Z', detailsUrl: 'https://github.com/acme/repo/actions/runs/1/job/2' },
      { __typename: 'StatusContext', context: 'deploy/preview', state: 'PENDING', targetUrl: 'https://vercel.com/x' },
    ],
    reviewComments: [
      { id: 10, user: { login: 'lena', type: 'User' }, body: 'Name this sum?', path: 'add.js', line: 2, position: 2, created_at: '2026-10-28T10:30:00Z', html_url: 'https://github.com/acme/repo/pull/1#r10' },
      { id: 11, in_reply_to_id: 10, user: { login: 'M0xoo', type: 'User' }, body: 'Done', path: 'add.js', line: 2, position: 2, created_at: '2026-10-28T10:40:00Z' },
    ],
  });
  const { prs } = await api(`/sessions/${s.id}/prs`);
  assert.equal(prs.length, 1);
  const d = prs[0];
  assert.equal(d.number, pr.number);
  assert.equal(d.summary, undefined, 'the card’s copy stays on the server');
  assert.deepEqual(d.checkList.map((c) => [c.name, c.state]), [['lint', 'fail'], ['deploy/preview', 'pending'], ['test (22)', 'pass']]);
  assert.equal(d.checkList[2].ms, 65_000);
  assert.deepEqual(d.checks, { pass: 1, fail: 1, pending: 1 });
  assert.deepEqual(d.reviewers, [{ author: 'lena', state: 'APPROVED' }]);
  assert.deepEqual(d.notes.map((n) => [n.author, n.bot, n.kind]), [['vercel', true, 'comment'], ['sam', false, 'comment'], ['lena', false, 'review']]);
  assert.equal(d.threads.length, 1);
  assert.deepEqual(d.threads[0].notes.map((n) => n.author), ['lena', 'M0xoo']);
  assert.deepEqual([d.additions, d.deletions, d.changedFiles, d.files[0].path], [3, 1, 1, 'add.js']);
  // Reading it refreshes the card: its checks counts follow.
  assert.deepEqual((await api('/sessions')).find((x) => x.id === s.id).pr.checks, { pass: 1, fail: 1, pending: 1 });
  // Ask to fix: the failing job's log, just its text (no job, step or timestamp columns).
  setGh({ runLog: 'lint\tRun lint\t2026-10-28T09:00:01.000Z > eslint .\nlint\tRun lint\t2026-10-28T09:00:02.000Z \x1b[31merror\x1b[0m x is unused' });
  assert.equal((await api(`/sessions/${s.id}/check-log?url=${encodeURIComponent(d.checkList[0].url)}`)).log, '> eslint .\nerror x is unused');
  assert.equal((await api(`/sessions/${s.id}/check-log?url=${encodeURIComponent('https://vercel.com/x')}`)).log, '');
  // No PR: an empty list, not an error.
  const t = await api('/sessions', { body: { prompt: 'Something else', cwd: repo.dir, agent: 'claude' } });
  await settled(t.id);
  assert.deepEqual((await api(`/sessions/${t.id}/prs`)).prs, []);
});

test('prDetailOf / threadsOf: bots by name or type, outdated threads, dismissed reviews drop out', () => {
  assert.equal(isBot('dependabot[bot]'), true);
  assert.equal(isBot('codecov'), true);
  assert.equal(isBot('someone', 'Bot'), true);
  assert.equal(isBot('lena'), false);
  const th = threadsOf([{ id: 1, user: { login: 'a' }, body: 'x', path: 'f.js', line: null, original_line: 4, position: null }]);
  assert.deepEqual([th[0].line, th[0].outdated], [4, true]);
  const d = prDetailOf({ number: 1, state: 'OPEN', reviews: [{ author: { login: 'a' }, state: 'CHANGES_REQUESTED', body: '' }, { author: { login: 'a' }, state: 'DISMISSED', body: '' }, { author: { login: 'b' }, state: 'PENDING', body: 'draft' }] });
  assert.deepEqual(d.reviewers, []);
  assert.deepEqual(d.notes, []);
  assert.deepEqual(d.checkList, []);
});
