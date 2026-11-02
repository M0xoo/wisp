// .env masking (server/env-mask.js): what a task shows of a .env file reaches the page as KEY=••••
// (GET /sessions/:id, the activity stream, /changes) until Reveal (/unmasked, /changes?reveal=).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { installFakeBins, isolateAgentConfigs, makeClone, tmp, until } from './helpers.js';
import { DOTS, isEnvFile, maskChangesFile, maskEdit, maskLine, maskSession, maskStep, maskText, namesEnvFile, unmasked } from '../server/env-mask.js';
import { hunkKey, hunksOf } from '../server/hunks.js';

process.env.WISP_HOME = tmp('envmask-home');
process.env.WISP_UPDATE_CHECK = '0';
installFakeBins();
isolateAgentConfigs();
const { startServer } = await import('../server/index.js');

test('isEnvFile: .env and .env.*, not the templates', () => {
  for (const f of ['.env', '.env.local', 'apps/web/.env.production', 'C:\\app\\.env.test', '/abs/.env.development.local']) assert.ok(isEnvFile(f), f);
  for (const f of ['.env.example', '.env.sample', 'web/.env.local.example', '.ENV.SAMPLE', 'env', 'my.env', '.envrc', '.environment', 'src/env.js', '', undefined]) assert.ok(!isEnvFile(f), String(f));
});

test('maskText: values go, keys, comments and blank lines stay', () => {
  const text = '# db\nDATABASE_URL=postgres://me:pw@db/app\nexport TOKEN="ghp_x" # mine\nEMPTY=\nyaml_like: value\n\n  INDENTED = 3';
  assert.equal(maskText(text), `# db\nDATABASE_URL=${DOTS}\nexport TOKEN=${DOTS}\nEMPTY=\nyaml_like: ${DOTS}\n\n  INDENTED = ${DOTS}`);
  assert.equal(maskLine('sk-live-bare-value'), DOTS, 'a line with no key goes whole (an edit snippet)');
  assert.equal(maskLine('  # a comment'), '  # a comment');
  assert.equal(maskText(undefined), undefined);
});

test('maskEdit: a changed value still makes a line of the diff, without showing either value', () => {
  const e = maskEdit({ before: 'A=1\nB=old\n', after: 'A=1\nB=new\nC=added\n' });
  assert.equal(e.before, `A=${DOTS}\nB=${DOTS}\n`);
  assert.equal(e.after, `A=${DOTS}\nB=${DOTS} (changed)\nC=${DOTS}\n`);
  assert.ok(!/old|new|added|=1/.test(e.before + e.after));
});

test('namesEnvFile and maskStep: output of a command that read a .env file', () => {
  for (const c of ['cat .env', 'head -5 apps/web/.env.local', "Get-Content '.env'", 'grep KEY .env|sort', 'cat <.env.production']) assert.ok(namesEnvFile(c), c);
  for (const c of ['cat .env.example', 'cp .env.sample .env.sample2.example', 'echo env', 'cat my.env', 'ls .envrc']) assert.ok(!namesEnvFile(c), c);
  const a = { t: 5, kind: 'run', label: 'Show the env', detail: 'cat .env', output: 'API_KEY=sk-123\nPORT=3000', call: 'c1' };
  const m = maskStep(a, 'T1');
  assert.equal(m.output, `API_KEY=${DOTS}\nPORT=${DOTS}`);
  assert.equal(m.masked, 'turn=T1&call=c1');
  assert.equal(a.output, 'API_KEY=sk-123\nPORT=3000', 'the stored step is untouched');
  assert.equal(maskStep({ t: 6, kind: 'run', detail: 'ls', output: 'A=1' }, 'T1').output, 'A=1', 'other commands as they are');
  assert.equal(maskStep({ t: 7, kind: 'run', detail: 'cat .env', output: 'A=1' }, 'T1').masked, 'turn=T1&step=7');
});

test('maskSession: changes, steps and blocks about a .env file, in childSessions too; .env.example as it is', () => {
  const turn = (id) => ({
    id,
    activity: [{ t: 1, kind: 'run', detail: 'cat .env', output: 'S=1' }],
    changes: [
      { file: '.env', op: 'edit', beforeFile: 'S=0\n', edits: [{ before: 'S=0', after: 'S=1' }] },
      { file: '.env.example', op: 'edit', edits: [{ before: 'S=', after: 'S=changeme' }] },
    ],
    presentation: { blocks: [{ type: 'hero', title: 'x' }, { type: 'diff', file: 'cfg/.env.local', before: 'K=a', after: 'K=b' }, { type: 'code', file: '.env', code: 'K=v' }, { type: 'diff', file: '.env' }] },
  });
  const s = { id: 's', turns: [turn('t1'), { id: 't0', stub: true, prompt: 'p' }], childSessions: { k: { id: 'k', turns: [turn('t2')] } } };
  const m = maskSession(s);
  const [t] = m.turns;
  assert.equal(t.activity[0].output, `S=${DOTS}`);
  assert.deepEqual(t.changes[0].edits, [{ before: `S=${DOTS}`, after: `S=${DOTS} (changed)` }]);
  assert.equal(t.changes[0].beforeFile, `S=${DOTS}\n`);
  assert.equal(t.changes[0].masked, 'turn=t1&file=.env');
  assert.deepEqual(t.changes[1], s.turns[0].changes[1], '.env.example as it is');
  assert.equal(t.presentation.blocks[1].after, `K=${DOTS} (changed)`);
  assert.equal(t.presentation.blocks[1].masked, 'turn=t1&block=1');
  assert.equal(t.presentation.blocks[2].code, `K=${DOTS}`);
  assert.deepEqual(t.presentation.blocks[3], { type: 'diff', file: '.env' }, 'a diff block of the captured change: masked there');
  assert.deepEqual(m.turns[1], s.turns[1], 'a stub as it is');
  assert.equal(m.childSessions.k.turns[0].changes[0].masked, 'turn=t2&file=.env');
  assert.equal(s.turns[0].changes[0].edits[0].after, 'S=1', 'the stored session is untouched');
  // Reveal gives the stored thing back, named by its masked query.
  assert.equal(unmasked(s, new URLSearchParams(t.changes[0].masked)).edits[0].after, 'S=1');
  assert.equal(unmasked(s, new URLSearchParams(t.changes[0].masked)).beforeFile, undefined, 'not the file from before');
  assert.equal(unmasked(s, new URLSearchParams('turn=t1&step=1')).output, 'S=1');
  assert.equal(unmasked(s, new URLSearchParams(t.presentation.blocks[1].masked)).after, 'K=b');
  assert.equal(unmasked(s, new URLSearchParams('turn=nope&step=1')), null);
});

test('maskChangesFile: git rows masked, a revealed path and other files as they are', () => {
  const f = { path: 'app/.env', status: 'M', rows: [{ op: '-', text: 'K=old', a: 1 }, { op: '+', text: 'K=new', b: 1 }, { op: ' ', text: '# c', a: 2, b: 2 }] };
  const m = maskChangesFile(f, new Set());
  assert.deepEqual(m.rows.map((r) => r.text), [`K=${DOTS}`, `K=${DOTS}`, '# c']);
  assert.equal(m.masked, true);
  assert.equal(maskChangesFile(f, new Set(['app/.env'])), f);
  const other = { path: 'math.js', rows: [{ op: '+', text: 'K=1' }] };
  assert.equal(maskChangesFile(other, new Set()), other);
});

// --- through a server ------------------------------------------------------------------------

let srv;
let base;
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
async function api(p, { method, body } = {}) {
  const r = await fetch(`${base}/api${p}`, { method: method || (body ? 'POST' : 'GET'), headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(`${p}: ${j.error}`), { status: r.status, body: j });
  return j;
}
const settled = (id) => until(async () => ((await api(`/sessions/${id}`)).state === 'review' ? api(`/sessions/${id}`) : null), { timeout: 30_000 });

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

test('the page gets .env values masked, Reveal gets one view as it is, and Settings turns it off', async () => {
  const repo = makeClone();
  fs.writeFileSync(path.join(repo.dir, '.env'), 'API_KEY=sk-live-one\nPORT=3000\n');
  repo.git('add', '.env');
  repo.git('commit', '-qm', 'env');
  repo.git('push', '-q', 'origin', 'main');
  const s = await api('/sessions', { body: { prompt: 'fix the add bug', cwd: repo.dir, agent: 'claude' } });
  const done = await settled(s.id);
  assert.ok(done.worktree?.path, 'ran in a worktree');

  // What the agent did to .env, as the runner keeps it.
  const stored = srv.store.get(s.id);
  const t = stored.turns.at(-1);
  t.activity.push({ t: 42, kind: 'run', label: 'Read the env', detail: 'cat .env', output: 'API_KEY=sk-live-one\nPORT=3000' });
  t.changes.push({ file: '.env', op: 'edit', edits: [{ before: 'API_KEY=sk-live-one', after: 'API_KEY=sk-live-two' }] });
  srv.store.save(stored);
  fs.writeFileSync(path.join(done.worktree.path, '.env'), 'API_KEY=sk-live-two\nPORT=3000\n');

  for (const q of ['', '?lean=1&turns=2']) {
    const page = JSON.stringify(await api(`/sessions/${s.id}${q}`));
    assert.ok(!page.includes('sk-live'), `no value in GET /sessions/:id${q}`);
    assert.ok(page.includes(`API_KEY=${DOTS}`));
  }
  const pt = (await api(`/sessions/${s.id}`)).turns.at(-1);
  const step = pt.activity.find((a) => a.t === 42);
  const change = pt.changes.find((c) => c.file === '.env');
  assert.equal((await api(`/sessions/${s.id}/unmasked?${step.masked}`)).value.output, 'API_KEY=sk-live-one\nPORT=3000');
  assert.equal((await api(`/sessions/${s.id}/unmasked?${change.masked}`)).value.edits[0].after, 'API_KEY=sk-live-two');
  await assert.rejects(api(`/sessions/${s.id}/unmasked?turn=${t.id}&step=1`), { status: 404 });

  // Changes: the git diff's rows masked; ?reveal=<path> sends that file as it is.
  const cx = await api(`/sessions/${s.id}/changes`);
  const f = cx.files.find((x) => x.path === '.env');
  assert.equal(f.masked, true);
  assert.ok(!JSON.stringify(cx).includes('sk-live'));
  const shown = (await api(`/sessions/${s.id}/changes?reveal=.env`)).files.find((x) => x.path === '.env');
  assert.ok(!shown.masked && shown.rows.some((r) => r.text === 'API_KEY=sk-live-two'));

  // A hunk Revert from the masked view: its key is the masked rows', and it still reverts.
  const [h] = hunksOf(f.rows);
  assert.notEqual(hunkKey(h.rows), hunkKey(hunksOf(shown.rows)[0].rows), 'the page saw other rows than the server has');
  await api(`/sessions/${s.id}/changes/revert`, { body: { path: '.env', hunk: 0, key: hunkKey(h.rows) } });
  assert.equal(fs.readFileSync(path.join(done.worktree.path, '.env'), 'utf8'), 'API_KEY=sk-live-one\nPORT=3000\n');

  // The activity stream masks too.
  const ctl = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: ctl.signal });
  const reader = res.body.getReader();
  let seen = '';
  const reading = (async () => {
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) return;
      seen += new TextDecoder().decode(value);
    }
  })().catch(() => {});
  await until(() => seen.length > 0, { what: 'the stream says hello' });
  const live = srv.store.get(s.id);
  srv.runner.emit('activity', { sessionId: s.id, turnId: live.turns.at(-1).id, item: { t: 43, kind: 'run', detail: 'cat .env.local', output: 'SECRET=hunter2' } });
  await until(() => seen.includes('cat .env.local'), { what: 'the activity event' });
  assert.ok(!seen.includes('hunter2') && seen.includes(`SECRET=${DOTS}`), seen.slice(-400));

  // Off in Settings: as it is everywhere.
  await assert.rejects(api('/config', { method: 'PATCH', body: { defaults: { maskEnvFiles: 'maybe' } } }), { status: 400 });
  await api('/config', { method: 'PATCH', body: { defaults: { maskEnvFiles: 'off' } } });
  try {
    assert.ok(JSON.stringify(await api(`/sessions/${s.id}`)).includes('sk-live-one'));
    assert.ok(!(await api(`/sessions/${s.id}/changes`)).files?.some((x) => x.masked));
    srv.runner.emit('activity', { sessionId: s.id, turnId: live.turns.at(-1).id, item: { t: 44, kind: 'run', detail: 'cat .env', output: 'SECRET=plain' } });
    await until(() => seen.includes('SECRET=plain'), { what: 'the unmasked event' });
  } finally {
    await api('/config', { method: 'PATCH', body: { defaults: { maskEnvFiles: 'on' } } });
    ctl.abort();
    await reading;
  }
});

test('a run that reads and edits .env (the real adapter path): masked on the page, Reveal shows the edit', async () => {
  const repo = makeClone();
  const s = await api('/sessions', { body: { prompt: 'ENVFILE fix the add bug', cwd: repo.dir, agent: 'claude' } });
  const done = await settled(s.id);
  const t = done.turns.at(-1);
  { const j = JSON.stringify(done); const i = j.indexOf('sk-live'); assert.ok(i < 0, j.slice(Math.max(0, i - 300), i + 50)); }
  const step = t.activity.find((a) => a.detail === 'cat .env');
  assert.ok(step?.masked && step.output.includes(`API_KEY=${DOTS}`), JSON.stringify(step));
  const change = t.changes.find((c) => c.file.endsWith('.env'));
  assert.ok(change?.masked, JSON.stringify(t.changes));
  assert.ok(change.edits.some((e) => e.after.includes(`${DOTS} (changed)`) || e.after === DOTS), JSON.stringify(change.edits));
  const raw = (await api(`/sessions/${s.id}/unmasked?${change.masked}`)).value;
  assert.ok(raw.edits.some((e) => e.after.includes('sk-live-two')), JSON.stringify(raw.edits));
});

test('maskEdit: a bare value snippet (Claude Edit old_string/new_string) masks and still shows as changed', () => {
  assert.deepEqual(maskEdit({ before: 'sk-live-one', after: 'sk-live-two' }), { before: DOTS, after: `${DOTS} (changed)` });
  assert.deepEqual(maskEdit({ before: '# keep', after: '# keep\nNEW=1' }), { before: '# keep', after: `# keep\nNEW=${DOTS}` });
});
