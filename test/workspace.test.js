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
const { generatedPath, git, isBot, parseDiff, prDetailOf, threadsOf } = await import('../server/git.js');
const { hunkKey, hunksOf } = await import('../server/hunks.js');

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

test('changes: what the task changed since the base, committed or not, new files whole', async () => {
  const repo = makeClone();
  const s = await api('/sessions', { body: { prompt: 'Fix add() so it adds', cwd: repo.dir, agent: 'claude' } });
  const done = await settled(s.id);
  const dir = done.worktree.cwd || done.worktree.path;
  fs.writeFileSync(path.join(dir, 'notes.md'), 'one\ntwo\n');
  const c = await api(`/sessions/${s.id}/changes`);
  assert.equal(c.base, 'main');
  assert.match(c.at, /^[0-9a-f]{40}$/);
  assert.deepEqual(c.files.map((f) => [f.path, f.status, f.add, f.del]), [['math.js', 'M', 1, 1], ['notes.md', 'A', 2, 0]]);
  const math = c.files[0];
  assert.deepEqual(math.rows.filter((r) => r.op !== ' ').map((r) => r.op + r.text.trim()), ['-return a - b;', '+return a + b;']);
  assert.deepEqual(c.files[1].rows, [{ op: '+', text: 'one', b: 1 }, { op: '+', text: 'two', b: 2 }]);
  await assert.rejects(api('/sessions/nope/changes'), (e) => e.status === 404);
  // Without a worktree, a git diff of the project would hold the user's own work: the page shows the captured edits.
  const plain = await api('/sessions', { body: { prompt: 'Fix add() so it adds', cwd: makeClone().dir, agent: 'claude', worktree: false } });
  await settled(plain.id);
  assert.deepEqual(await api(`/sessions/${plain.id}/changes`), { files: null });
});

test('revert: one hunk or a whole file back to the base, Undo, and refused while the agent works or once the hunk moved', async () => {
  const repo = makeClone();
  const s = await api('/sessions', { body: { prompt: 'Fix add() so it adds', cwd: repo.dir, agent: 'claude' } });
  const done = await settled(s.id);
  const root = done.worktree.path;
  const at = (p) => path.join(root, p);
  // Two hunks in math.js: the agent's fix, and a line far below it that the base has too.
  const fixed = fs.readFileSync(at('math.js'), 'utf8');
  const tail = Array.from({ length: 12 }, (_, i) => `// line ${i + 1}`).join('\n');
  await git(root, ['checkout', '--', 'math.js']);
  fs.writeFileSync(at('math.js'), `${fs.readFileSync(at('math.js'), 'utf8')}${tail}\n`);
  await git(root, ['commit', '-qam', 'a longer base', '--no-verify']);
  await git(root, ['push', '-q', done.worktree.remote || 'origin', 'HEAD:main']); // the base moves on to it: the fix stays the task's
  fs.writeFileSync(at('math.js'), `${fixed}${tail.replace('line 12', 'line twelve')}\n`);
  fs.writeFileSync(at('notes.md'), 'one\n');
  let c = await api(`/sessions/${s.id}/changes`);
  const math = c.files.find((f) => f.path === 'math.js');
  const hs = hunksOf(math.rows);
  assert.equal(hs.length, 2, 'the fix and the last line, a gap between');
  // A hunk the page showed before the file moved on is refused.
  await assert.rejects(api(`/sessions/${s.id}/changes/revert`, { body: { path: 'math.js', hunk: 1, key: 'stale' } }), (e) => e.status === 409 && /changed since you looked/.test(e.message));
  const before = await api(`/sessions/${s.id}/source?path=math.js`);
  const r = await api(`/sessions/${s.id}/changes/revert`, { body: { path: 'math.js', hunk: 1, key: hunkKey(hs[1].rows) } });
  const now = fs.readFileSync(at('math.js'), 'utf8');
  assert.match(now, /\/\/ line 12\n$/);
  assert.match(now, /return a \+ b;/, 'the other hunk stays');
  c = await api(`/sessions/${s.id}/changes`);
  assert.equal(hunksOf(c.files.find((f) => f.path === 'math.js').rows).length, 1);
  // Undo: the text from before, saved over the reverted file (its hash from the revert).
  await api(`/sessions/${s.id}/source`, { method: 'PUT', body: { path: 'math.js', text: before.text, hash: r.hash } });
  assert.equal(fs.readFileSync(at('math.js'), 'utf8'), before.text);
  // The whole file: back to the merge-base; an added file goes, and restore brings it back.
  await api(`/sessions/${s.id}/changes/revert`, { body: { path: 'math.js' } });
  assert.match(fs.readFileSync(at('math.js'), 'utf8'), /return a - b;/);
  const gone = await api(`/sessions/${s.id}/changes/revert`, { body: { path: 'notes.md' } });
  assert.equal(gone.hash, null);
  assert.equal(fs.existsSync(at('notes.md')), false);
  assert.deepEqual((await api(`/sessions/${s.id}/changes`)).files, []);
  await api(`/sessions/${s.id}/changes/revert`, { body: { path: 'notes.md', restore: 'one\n', hash: null } });
  assert.equal(fs.readFileSync(at('notes.md'), 'utf8'), 'one\n');
  // Paths out of the folder, and files the task didn't change.
  for (const bad of ['../outside.txt', '/etc/hosts', '.git/config'])
    await assert.rejects(api(`/sessions/${s.id}/changes/revert`, { body: { path: bad, restore: 'x' } }), (e) => e.status === 404, bad);
  await assert.rejects(api(`/sessions/${s.id}/changes/revert`, { body: { path: 'README.md' } }), (e) => e.status === 409);
  await assert.rejects(api(`/sessions/${s.id}/changes/revert`, { body: {} }), (e) => e.status === 400);
  // While the agent works, nothing is reverted under it.
  process.env.FAKE_DELAY = '1500';
  await api(`/sessions/${s.id}/reply`, { body: { text: 'and again' } });
  delete process.env.FAKE_DELAY;
  await assert.rejects(api(`/sessions/${s.id}/changes/revert`, { body: { path: 'notes.md' } }), (e) => e.status === 409 && /agent is working/.test(e.message));
  await settled(s.id);
});

test('stage: a hunk or a file in and out of the index, then a commit of what is staged; refused while the agent works', async () => {
  const repo = makeClone();
  const s = await api('/sessions', { body: { prompt: 'Fix add() so it adds', cwd: repo.dir, agent: 'claude' } });
  const done = await settled(s.id);
  const root = done.worktree.path;
  const at = (p) => path.join(root, p);
  // Two hunks in math.js, as in revert: the agent's fix and a line far below that the base has too.
  const fixed = fs.readFileSync(at('math.js'), 'utf8');
  const tail = Array.from({ length: 12 }, (_, i) => `// line ${i + 1}`).join('\n');
  await git(root, ['checkout', '--', 'math.js']);
  fs.writeFileSync(at('math.js'), `${fs.readFileSync(at('math.js'), 'utf8')}${tail}\n`);
  await git(root, ['commit', '-qam', 'a longer base', '--no-verify']);
  await git(root, ['push', '-q', done.worktree.remote || 'origin', 'HEAD:main']);
  fs.writeFileSync(at('math.js'), `${fixed}${tail.replace('line 12', 'line twelve')}\n`);
  fs.writeFileSync(at('notes.md'), 'one\n');
  let c = await api(`/sessions/${s.id}/changes`);
  let math = c.files.find((f) => f.path === 'math.js');
  assert.deepEqual([math.staged, math.unstaged], [false, true]);
  assert.deepEqual(math.hunkStage, [{ staged: false, unstaged: true }, { staged: false, unstaged: true }]);
  assert.deepEqual(c.files.find((f) => f.path === 'notes.md'), { ...c.files.find((f) => f.path === 'notes.md'), staged: false, unstaged: true });
  const hs = hunksOf(math.rows);
  // A hunk the page showed before it moved is refused, as Revert does.
  await assert.rejects(api(`/sessions/${s.id}/changes/stage`, { body: { path: 'math.js', hunk: 1, key: 'stale' } }), (e) => e.status === 409 && /changed since you looked/.test(e.message));
  await api(`/sessions/${s.id}/changes/stage`, { body: { path: 'math.js', hunk: 1, key: hunkKey(hs[1].rows) } });
  const cached = await git(root, ['diff', '--cached']);
  assert.match(cached, /line twelve/);
  assert.doesNotMatch(cached, /return a \+ b/, 'only that hunk');
  c = await api(`/sessions/${s.id}/changes`);
  math = c.files.find((f) => f.path === 'math.js');
  assert.deepEqual([math.staged, math.unstaged, c.staged], [true, true, 1]);
  assert.deepEqual(math.hunkStage, [{ staged: false, unstaged: true }, { staged: true, unstaged: false }]);
  await assert.rejects(api(`/sessions/${s.id}/changes/stage`, { body: { path: 'math.js', hunk: 1, key: hunkKey(hs[1].rows) } }), (e) => e.status === 409 && /nothing left to stage/.test(e.message));
  await api(`/sessions/${s.id}/changes/stage`, { body: { path: 'math.js', hunk: 1, key: hunkKey(hs[1].rows), unstage: true } });
  assert.equal(await git(root, ['diff', '--cached']), '');
  // Whole files: a new one in and out, then both in.
  await api(`/sessions/${s.id}/changes/stage`, { body: { path: 'notes.md' } });
  assert.equal(await git(root, ['diff', '--cached', '--name-only']), 'notes.md');
  await api(`/sessions/${s.id}/changes/stage`, { body: { path: 'notes.md', unstage: true } });
  assert.equal(await git(root, ['diff', '--cached', '--name-only']), '');
  // Paths Changes doesn't list, or out of the folder; a bad hunk; a new file has no hunks to stage.
  for (const bad of ['../outside.txt', '/etc/hosts', '.git/config', 'README.md'])
    await assert.rejects(api(`/sessions/${s.id}/changes/stage`, { body: { path: bad } }), (e) => e.status === 409, bad);
  await assert.rejects(api(`/sessions/${s.id}/changes/stage`, { body: {} }), (e) => e.status === 400);
  await assert.rejects(api(`/sessions/${s.id}/changes/stage`, { body: { path: 'math.js', hunk: -1 } }), (e) => e.status === 400);
  await assert.rejects(api(`/sessions/${s.id}/changes/stage`, { body: { path: 'notes.md', hunk: 0 } }), (e) => e.status === 400 && /whole file/.test(e.message));
  // Commit: a message, and something staged.
  await assert.rejects(api(`/sessions/${s.id}/changes/commit`, { body: { message: '  ' } }), (e) => e.status === 400 && /message/.test(e.message));
  await assert.rejects(api(`/sessions/${s.id}/changes/commit`, { body: { message: 'Fix add' } }), (e) => e.status === 400 && /Nothing is staged/.test(e.message));
  await api(`/sessions/${s.id}/changes/stage`, { body: { path: 'math.js' } });
  const r = await api(`/sessions/${s.id}/changes/commit`, { body: { message: 'Fix add' } });
  assert.match(r.sha, /^[0-9a-f]{7,}$/);
  assert.equal(await git(root, ['log', '-1', '--format=%s']), 'Fix add');
  assert.equal(await git(root, ['status', '--porcelain']), '?? notes.md', 'the untracked file stays out');
  c = await api(`/sessions/${s.id}/changes`);
  math = c.files.find((f) => f.path === 'math.js');
  assert.deepEqual([math.staged, math.unstaged, math.hunkStage], [false, false, undefined], 'committed: still the task’s, nothing to stage');
  const all = await api(`/sessions/${s.id}/changes/commit`, { body: { message: 'Add notes', all: true } });
  assert.match(all.sha, /^[0-9a-f]{7,}$/);
  assert.equal(await git(root, ['status', '--porcelain']), '');
  // While the agent works, nothing is staged or committed under it.
  fs.writeFileSync(at('notes.md'), 'two\n');
  process.env.FAKE_DELAY = '1500';
  await api(`/sessions/${s.id}/reply`, { body: { text: 'and again' } });
  delete process.env.FAKE_DELAY;
  await assert.rejects(api(`/sessions/${s.id}/changes/stage`, { body: { path: 'notes.md' } }), (e) => e.status === 409 && /agent is working/.test(e.message));
  await assert.rejects(api(`/sessions/${s.id}/changes/commit`, { body: { message: 'x', all: true } }), (e) => e.status === 409 && /agent is working/.test(e.message));
  await settled(s.id);
});

test('source: the panel’s editor reads a file of the task, saves it, and refuses a stale copy or a path out of the folder', async () => {
  const repo = makeClone();
  const s = await api('/sessions', { body: { prompt: 'Fix add() so it adds', cwd: repo.dir, agent: 'claude' } });
  const done = await settled(s.id);
  const root = done.worktree.path;
  const f = await api(`/sessions/${s.id}/source?path=math.js`);
  assert.equal(f.path, 'math.js');
  assert.match(f.text, /return a \+ b;/);
  assert.match(f.hash, /^[0-9a-f]{40}$/);
  const saved = await api(`/sessions/${s.id}/source`, { method: 'PUT', body: { path: 'math.js', text: '// mine\n' + f.text, hash: f.hash } });
  assert.equal(fs.readFileSync(path.join(root, 'math.js'), 'utf8'), '// mine\n' + f.text);
  assert.notEqual(saved.hash, f.hash);
  // The copy it opened is old now: saving it again would drop the line above.
  await assert.rejects(api(`/sessions/${s.id}/source`, { method: 'PUT', body: { path: 'math.js', text: f.text, hash: f.hash } }), (e) => e.status === 409);
  for (const bad of ['../outside.txt', '/etc/hosts', '.git/config', 'gone.js'])
    await assert.rejects(api(`/sessions/${s.id}/source?path=${encodeURIComponent(bad)}`), (e) => e.status === 404, bad);
  await assert.rejects(api(`/sessions/${s.id}/source`, { method: 'PUT', body: { path: '../x.js', text: 'x' } }), (e) => e.status === 404);
  const { files } = await api(`/sessions/${s.id}/files`);
  assert.ok(files.includes('math.js'), 'Open file… lists the folder’s files');
  await assert.rejects(api('/files?project=nope'), (e) => e.status === 404, '@ in New task: only a project here');
  // Search across the files, and Go to definition
  fs.writeFileSync(path.join(root, 'use.js'), "import { add } from './math.js';\nconst twice = (x) => add(x, x);\nexport class Calc {}\n");
  const found = await api(`/sessions/${s.id}/grep?q=${encodeURIComponent('ADD(X')}`);
  assert.deepEqual(found.hits.map((h) => [h.path, h.line]), [['use.js', 2]], 'case-insensitive text, new files too');
  const def = await api(`/sessions/${s.id}/grep?def=add`);
  assert.deepEqual(def.hits.map((h) => [h.path, h.line]), [['math.js', 2]], 'the function, not its uses');
  assert.deepEqual((await api(`/sessions/${s.id}/grep?def=twice`)).hits.map((h) => [h.path, h.line]), [['use.js', 2]], 'a function assigned to a name');
  assert.deepEqual((await api(`/sessions/${s.id}/grep?def=Calc`)).hits.map((h) => h.path), ['use.js']);
  assert.deepEqual((await api(`/sessions/${s.id}/grep?q=nothing-like-this`)).hits, []);
  await assert.rejects(api(`/sessions/${s.id}/grep?def=${encodeURIComponent('a b')}`), (e) => e.status === 400);
  fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([1, 0, 2]));
  await assert.rejects(api(`/sessions/${s.id}/source?path=blob.bin`), (e) => e.status === 415);
});

test('search: GET /search finds a task by the words of its prompt', async () => {
  const s = await api('/sessions', { body: { prompt: 'Teach the zebracorn parser to add', cwd: makeClone().dir, agent: 'claude' } });
  await settled(s.id);
  // Named apart from its prompt (a task is named after it otherwise, and the title hit comes first).
  await api(`/sessions/${s.id}`, { method: 'PATCH', body: { title: 'Parser work' } });
  const { hits } = await api(`/search?q=${encodeURIComponent('zebracorn parser')}`);
  assert.deepEqual(hits.map((h) => [h.id, h.where]), [[s.id, 'prompt']]);
  assert.match(hits[0].snippet, /zebracorn parser/);
  assert.deepEqual((await api('/search?q=')).hits, []);
});

test('parseDiff: hunks with the unchanged gaps between them, renames, deletions, binaries', () => {
  const out = [
    'diff --git a/a.js b/a.js',
    'index 1..2 100644',
    '--- a/a.js',
    '+++ b/a.js',
    '@@ -3,2 +3,2 @@ x',
    ' keep',
    '-old',
    '+new',
    '@@ -20,1 +20,2 @@',
    ' tail',
    '+more',
    'diff --git a/old.js b/new.js',
    'similarity index 100%',
    'rename from old.js',
    'rename to new.js',
    'diff --git a/gone.js b/gone.js',
    'deleted file mode 100644',
    '--- a/gone.js',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-bye',
    'diff --git a/logo.png b/logo.png',
    'Binary files a/logo.png and b/logo.png differ',
  ].join('\n');
  const [a, r, d, b] = parseDiff(out);
  assert.deepEqual(a.rows, [{ op: '…', count: 2 }, { op: ' ', text: 'keep', a: 3, b: 3 }, { op: '-', text: 'old', a: 4 }, { op: '+', text: 'new', b: 4 }, { op: '…', count: 15 }, { op: ' ', text: 'tail', a: 20, b: 20 }, { op: '+', text: 'more', b: 21 }]);
  assert.deepEqual([a.add, a.del], [2, 1]);
  assert.deepEqual([r.path, r.from, r.status, r.rows.length], ['new.js', 'old.js', 'R', 0]);
  assert.deepEqual([d.status, d.del, d.rows], ['D', 1, [{ op: '-', text: 'bye', a: 1 }]]);
  assert.equal(b.binary, true);
  assert.ok(generatedPath('web/package-lock.json') && generatedPath('dist/app.js') && generatedPath('x.min.css'));
  assert.ok(!generatedPath('server/git.js') && !generatedPath('distance.js'));
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
