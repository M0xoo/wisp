// Sharing a task (server/services/share.js → grid/shares.js) end to end: Pia shares a task with a
// delegate, a secret in it and a passkey; the link opens in a browser only with the passkey, its
// delegate's run on a page of its own; Dee's wisp imports it with its history, work and team and
// carries it on, its harness hearing what happened first. And what runs it when the harness or
// model isn't there (runHere).

import { test as nodeTest, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { browser, installFakeBins, makeRepo, records, tmp, until } from './helpers.js';

const sqlite = await import('node:sqlite').then(
  () => true,
  () => false,
);
const test = (name, fn) => nodeTest(name, { skip: !sqlite && 'the grid needs node:sqlite (Node 22.13+)' }, fn);

const RECORD = tmp('share-record');
process.env.FAKE_RECORD = RECORD;
process.env.WISP_HOME = tmp('share-home');
process.env.WISP_UPDATE_CHECK = '0';
installFakeBins();

const { startServer } = await import('../server/index.js');
const { createShare, parseShareLink, redactDeep, runHere } = await import('../server/services/share.js');
const { workdir } = await import('../server/runner.js');
const { loadConfig } = sqlite ? await import('../grid/config.js') : {};
const { startGrid } = sqlite ? await import('../grid/server.js') : {};
const { ensureMaster } = sqlite ? await import('../grid/secrets.js') : {};

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
// What a shared task's page shows: wisp's look (its stylesheets, share-view.js) over the JSON it embeds.
const shown = (html) => JSON.parse(/<script type="application\/json" id="shareData">([\s\S]*?)<\/script>/.exec(html)[1]);
const csrfOf = (html) => /name="csrf" value="([^"]+)"/.exec(html)?.[1];

let grid;
let gridBase;
let srv;
let base;

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  srv = await startServer({ port, handleSignals: false });
  if (!sqlite) return;
  const dataDir = tmp('share-grid');
  ensureMaster(dataDir);
  const cfg = loadConfig({ dataDir, env: {}, overrides: { domain: 'wisp.localhost', listen: { host: '127.0.0.1', port: await freePort() }, auth: { dev: true } } });
  grid = await startGrid(cfg, { log: () => {} });
  gridBase = cfg.publicUrl;
});
after(async () => {
  srv.shutdown();
  srv.server.closeAllConnections?.();
  srv.server.close();
  await grid?.close();
});

async function deviceToken(email) {
  const code = await browser().go(`${gridBase}/api/device/code`, { method: 'POST', body: { name: `${email}’s wisp` } });
  const b = browser();
  const start = await b.go(`${gridBase}/auth/dev/start`);
  await b.go(`${gridBase}/auth/dev/callback`, { method: 'POST', form: { csrf: csrfOf(start.text), email, name: email.split('@')[0], return: '/' }, headers: { origin: gridBase } });
  const page = await b.go(code.json.verification_uri_complete);
  await b.go(`${gridBase}/activate`, { method: 'POST', form: { csrf: csrfOf(page.text), code: code.json.user_code, answer: 'allow' }, headers: { origin: gridBase } });
  return until(async () => (await browser().go(`${gridBase}/api/device/token`, { method: 'POST', body: { device_code: code.json.device_code } })).json.token, { what: `${email}’s token` });
}

// This wisp, signed in to the grid as someone (a cloud computer holding their device token).
const signedIn = (token) =>
  createShare(
    { store: srv.store, runner: srv.runner, crew: srv.crew, triggers: srv.triggers, machines: { list: [{ id: 'm1', kind: 'grid', grid: gridBase, handle: 'x' }] }, secrets: { get: () => token }, configChanged() {}, sessionChanged() {}, broadcast() {} },
    { env: {} },
  );

const settled = (id, n) =>
  until(
    () => {
      const s = srv.store.get(id);
      return s && s.turns.length === n && s.state !== 'running' && s;
    },
    { what: `${id} settled` },
  );

test('runHere: the same harness and model when they’re here, the nearest model, else the lead’s harness', () => {
  const here = [
    { id: 'claude', name: 'Claude Code', models: [{ id: '' }, { id: 'opus' }, { id: 'sonnet' }], efforts: ['high', 'max'] },
    { id: 'codex', name: 'Codex', models: [{ id: '' }] },
  ];
  assert.deepEqual(runHere(here, { agent: 'claude', model: 'sonnet', effort: 'max' }), { agent: 'claude', model: 'sonnet', effort: 'max', note: '' });
  assert.equal(runHere(here, { agent: 'claude', model: 'claude-opus-4-1' }).model, 'opus', 'a full id finds its family');
  const gone = runHere(here, { agent: 'claude', model: 'gpt-5', effort: 'high' });
  assert.deepEqual([gone.agent, gone.model, gone.effort], ['claude', '', '']);
  assert.match(gone.note, /gpt-5 isn’t one of Claude Code’s models here/);
  assert.equal(runHere(here, { agent: 'codex', model: 'gpt-5.1-codex' }).model, 'gpt-5.1-codex', 'no list to check it against: kept');
  const missing = runHere(here, { agent: 'grok', model: 'grok-4' }, { agent: 'codex', model: '' });
  assert.equal(missing.agent, 'codex');
  assert.match(missing.note, /isn’t installed here: Codex carries it on/);
  assert.equal(runHere(here, { agent: 'grok' }).agent, 'claude', 'no lead: the first one installed');
});

test('a share link is <grid>/s/<16>; secrets anywhere in a task are redacted', () => {
  assert.deepEqual(parseShareLink('https://grid.example.com/s/AbCdEfGhIjKlMnOp'), { origin: 'https://grid.example.com', id: 'AbCdEfGhIjKlMnOp' });
  assert.equal(parseShareLink('https://grid.example.com/s/short'), null);
  const { value, hits } = redactDeep({ turns: [{ raw: `token ghp_${'a'.repeat(36)}`, n: 3 }] });
  assert.equal(hits, 1);
  assert.deepEqual(value, { turns: [{ raw: 'token [redacted: a GitHub token]', n: 3 }] });
});

test('not signed in to a grid: sharing says to sign in, and a pasted link from a grid you’re not on isn’t fetched', async () => {
  const repo = makeRepo();
  const s = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'fix the add function', cwd: repo, agent: 'claude' }) })).json();
  await settled(s.id, 1);
  const r = await fetch(`${base}/api/sessions/${s.id}/share`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /Sign in to a wisp Grid first/);
  const p = await fetch(`${base}/api/shares/peek`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://elsewhere.example/s/AbCdEfGhIjKlMnOp' }) });
  assert.equal(p.status, 409);
  assert.match((await p.json()).error, /Sign in to elsewhere\.example first/);
});

test('shared with a passkey, opened in a browser with its delegate, imported with its history, work and team, carried on', async () => {
  const pia = signedIn(await deviceToken('pia@example.com'));
  const dee = signedIn(await deviceToken('dee@example.com'));

  // Pia's task: a turn, a codex subagent's run it delegated, a secret in its output, new work.
  const repo = makeRepo();
  const lead = srv.runner.create({ prompt: 'fix the add function', cwd: repo, agent: 'claude', model: 'sonnet', subagents: [{ name: 'codex', agent: 'codex' }] });
  await settled(lead.id, 1);
  const child = srv.runner.create({ prompt: 'write a test for add', cwd: repo, agent: 'codex', parentId: lead.id, member: 'codex' });
  await settled(child.id, 1);
  lead.children = { codex: child.id };
  lead.turns[0].delegations = [{ id: 'd1', name: 'codex', member: 'codex', agent: 'codex', model: '', sessionId: child.id, turnId: child.turns[0].id, prompt: 'write a test for add', startedAt: Date.now() }];
  lead.turns[0].raw = `deployed with ghp_${'b'.repeat(36)}`;
  srv.store.save(lead);
  fs.writeFileSync(path.join(workdir(lead), 'notes.md'), 'work in progress\n');

  const out = await pia.share(lead, { passkey: 'open sesame' });
  assert.match(out.url, new RegExp(`^${gridBase.replace(/[.]/g, '\\.')}/s/[A-Za-z0-9_-]{16}$`));
  assert.ok(out.locked && out.work);
  assert.ok(out.notes.some((n) => /1 secret .* replaced/.test(n)), out.notes.join('\n'));
  assert.equal((await pia.share(lead, { passkey: 'open sesame' })).url, out.url, 'sharing again keeps the link');

  // The browser: the passkey first, then the task, with a link to its delegate's own page.
  const b = browser();
  const locked = await b.go(out.url);
  assert.equal(locked.status, 200);
  assert.match(locked.text, /locked this task|locked it with a passkey/);
  assert.doesNotMatch(locked.text, /fix the add function/);
  assert.equal((await b.go(out.url, { method: 'POST', form: { passkey: 'nope' } })).status, 403);
  const page = await b.go(out.url, { method: 'POST', form: { passkey: 'open sesame' } });
  assert.equal(page.status, 200);
  assert.match(page.text, /<script type="module" src="\/js\/share-view\.js">/);
  assert.match(page.text, /<link rel="stylesheet" href="\/css\/feed\.css">/);
  assert.match(page.headers['content-security-policy'], /script-src 'self'; connect-src 'none'/);
  // It can be framed (wisp's preview block, a doc); the grid's other pages can't.
  assert.match(page.headers['content-security-policy'], /frame-ancestors \*/);
  assert.equal(page.headers['x-frame-options'], undefined);
  assert.equal(locked.headers['x-frame-options'], undefined);
  assert.equal((await browser().go(`${gridBase}/signin`)).headers['x-frame-options'], 'DENY');
  const view = shown(page.text);
  assert.equal(view.task.turns[0].prompt, 'fix the add function');
  assert.deepEqual([view.task.turns[0].delegations[0].name, view.task.turns[0].delegations[0].run], ['codex', 'codex']);
  assert.equal(view.task.runs.codex.turns[0].prompt, 'write a test for add');
  assert.doesNotMatch(page.text, /ghp_b/);
  assert.equal((await browser().go(`${gridBase}/js/share-view.js`)).status, 200, 'wisp’s own renderer, from the grid');
  assert.equal((await browser().go(`${gridBase}/js/..%2f..%2fgrid%2fdb.js`)).status, 404);
  assert.match(page.headers['x-robots-tag'], /noindex/);
  const sub = await b.go(`${out.url}/r/codex`);
  assert.equal(sub.status, 200, 'the cookie keeps it open for its delegates’ pages');
  assert.equal(shown(sub.text).run, 'codex');
  assert.equal((await browser().go(`${out.url}/r/codex`)).status, 200);
  assert.doesNotMatch((await browser().go(`${out.url}/r/codex`)).text, /write a test for add|shareData/, 'without the passkey, a delegate’s page asks for it too');
  assert.equal((await b.go(`${out.url}/r/nope`)).status, 404);

  // Dee's wisp: the card, locked, then open.
  const peekLocked = await dee.peek(out.url);
  assert.deepEqual([peekLocked.locked, peekLocked.open], [true, false]);
  const card = await dee.peek(out.url, { passkey: 'open sesame' });
  assert.equal(card.title, lead.title);
  assert.equal(card.from.handle.length > 0, true);
  assert.deepEqual([card.turns, card.delegates, card.agent, card.run.agent], [1, 1, 'claude', 'claude']);
  await assert.rejects(dee.importShare(out.url, { passkey: 'wrong' }), /passkey isn’t right/);

  // Imported: waiting for Dee, the same history, the delegate's run as its subagent, the work.
  const { session: s, notes } = await dee.importShare(out.url, { passkey: 'open sesame' });
  assert.equal(s.state, 'review');
  assert.equal(s.turns.length, 1);
  assert.ok(s.turns[0].shared);
  assert.equal(s.turns[0].prompt, 'fix the add function');
  assert.match(s.turns[0].raw, /\[redacted: a GitHub token\]/);
  assert.deepEqual([s.agent, s.model, s.sharedFrom.id], ['claude', 'sonnet', parseShareLink(out.url).id]);
  assert.deepEqual(s.subagents.map((m) => [m.name, m.agent]), [['codex', 'codex']]);
  const kid = srv.store.get(s.children.codex);
  assert.ok(kid && kid.parentId === s.id, 'its delegate’s run is its subagent’s session');
  assert.equal(kid.turns[0].prompt, 'write a test for add');
  assert.deepEqual([s.turns[0].delegations[0].sessionId, s.turns[0].delegations[0].turnId], [kid.id, kid.turns[0].id]);
  assert.ok(s.worktree, notes.join('\n'));
  // Its repo is new, so it checks out with the importer's git config: CRLF on Windows (core.autocrlf).
  assert.equal(fs.readFileSync(path.join(workdir(s), 'notes.md'), 'utf8').replace(/\r\n/g, '\n'), 'work in progress\n');
  assert.match(fs.readFileSync(path.join(workdir(s), 'math.js'), 'utf8'), /uncommitted/);

  // Carried on: the harness hears what happened before it, as a shared task.
  const before = records(RECORD, 'claude').length;
  await fetch(`${base}/api/sessions/${s.id}/reply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'now handle negative numbers' }) });
  await settled(s.id, 2);
  const heard = records(RECORD, 'claude').slice(before).find((r) => r.stdin.includes('now handle negative numbers'));
  assert.ok(heard, 'the follow-up ran');
  assert.match(heard.stdin, /shared from their wisp/);
  assert.match(heard.stdin, /Delegated:\*\* @codex/);

  // Stopped sharing: the link and the API answer 404.
  await pia.unshare(lead);
  assert.equal((await browser().go(out.url)).status, 404);
  await assert.rejects(dee.peek(out.url), /isn’t shared any more/);
});

test('a crew member it delegated to comes along: on the importer’s crew (resumed: no schedule), its job linked as the delegate’s run', async () => {
  const pia = signedIn(await deviceToken('pia2@example.com'));
  const dee = signedIn(await deviceToken('dee2@example.com'));
  const repo = makeRepo();
  const ada = srv.crew.create({ name: 'Ada', role: 'Reviewer', brief: 'Reviews diffs for bugs.', agent: 'claude' });
  const lead = srv.runner.create({ prompt: 'ship the add fix', cwd: repo, agent: 'claude', subagents: [{ crew: ada.id, name: 'ada', label: 'Ada', agent: 'claude' }] });
  await settled(lead.id, 1);
  const job = srv.runner.create({ prompt: 'review the add fix', cwd: repo, agent: 'claude', crew: { id: ada.id, job: 'delegated', from: { id: lead.id, title: lead.title } } });
  await settled(job.id, 1);
  lead.turns[0].delegations = [{ id: 'd2', name: 'ada', member: 'Ada', crew: ada.id, agent: 'claude', model: '', sessionId: job.id, turnId: job.turns[0].id, prompt: 'review the add fix', startedAt: Date.now() }];
  srv.store.save(lead);

  const out = await pia.share(lead, { work: false });
  assert.equal(out.locked, false);
  const page = await browser().go(out.url);
  const view = shown(page.text);
  assert.deepEqual(view.share.crew, ['Ada']);
  assert.equal(view.task.turns[0].delegations[0].run, '~ada-1');
  assert.ok(view.task.turns[0].delegations[0].crew);
  const job2 = shown((await browser().go(`${out.url}/r/${encodeURIComponent('~ada-1')}`)).text);
  assert.deepEqual([job2.run, job2.task.runs['~ada-1'].crew, job2.task.runs['~ada-1'].turns[0].prompt], ['~ada-1', view.task.crew.members[0].key, 'review the add fix']);

  // Dee has no Ada: she joins, ready to take delegations, and the lead's team points at her.
  srv.crew.remove(ada);
  const card = await dee.peek(out.url);
  assert.deepEqual(card.newCrew, ['Ada']);
  const { session: s, crew } = await dee.importShare(out.url, { prompt: '' });
  const mine = srv.crew.list.find((m) => m.name === 'Ada');
  assert.ok(mine && mine.id !== ada.id);
  assert.equal(mine.paused, false);
  assert.deepEqual(crew.map((m) => m.name), ['Ada']);
  assert.equal(s.subagents[0].crew, mine.id);
  const d = s.turns[0].delegations[0];
  assert.equal(d.crew, mine.id);
  assert.equal(srv.store.get(d.sessionId).turns[0].prompt, 'review the add fix');
  assert.ok(inScratch(s), 'without its work it gets a folder of its own');

  // Imported again: the Ada already here is reused, not a second one.
  await dee.importShare(out.url, { prompt: '' });
  assert.equal(srv.crew.list.filter((m) => m.name.startsWith('Ada')).length, 1);
});

const inScratch = (s) => srv.store.isScratch(s.cwd);
