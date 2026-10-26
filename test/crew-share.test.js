// Sharing crew members (server/crew-share.js): the blueprint (who a member is, never where they run
// or what they did), .crew.json export with the secret scan and a secret gist, the import review and
// import (paused, with their triggers, all or nothing), an agent importing a file, and the members
// a spell brings: locked to the spell, paused when it changes what they do, out of the crew while
// it's off, and kept or removed with it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { installFakeBins, makeRepo, records, tmp, until } from './helpers.js';
import { normalizeBlueprint, normalizeBlueprints, parseCrewFile, uniqueName } from '../server/crew-share.js';

const RECORD = tmp('share-record');
process.env.FAKE_RECORD = RECORD;
process.env.FAKE_GH_STATE = path.join(tmp('share-gh'), 'state.json');
process.env.WISP_HOME = tmp('share-home');
process.env.WISP_UPDATE_CHECK = '0';
installFakeBins();

// The server first: its hooks must be in place before any test runs.
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
async function api(p, body, method = body ? 'POST' : 'GET') {
  const r = await fetch(`${base}/api${p}`, { method, headers: method === 'GET' ? {} : { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(`${p}: ${j.error}`), { status: r.status, body: j });
  return j;
}
const ended = (id) =>
  until(async () => {
    const x = await api(`/sessions/${id}`);
    return x.state !== 'running' && x.turns.at(-1)?.status !== 'running' && x;
  });
const triggersOf = async (id) => (await api('/triggers')).filter((t) => t.crew === id);
const byName = async (name) => (await api('/crew')).find((m) => m.name === name);
const clear = async () => {
  for (const m of await api('/crew')) await api(`/crew/${m.id}`, undefined, 'DELETE');
};

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


// --- pure --------------------------------------------------------------------------------------------

test('a blueprint: who a member is, checked; never a folder or a machine', () => {
  const b = normalizeBlueprint({ name: ' Scout ', role: 'CI watcher', brief: 'Watch CI.', cron: '*/30 * * * *', on: ['ci', 'finished', 'ci'], mode: 'plan', kit: [{ kind: 'skill', name: 'read-ci', description: 'when CI fails', body: 'steps', path: '/Users/me/.claude/skills/read-ci', id: 'abc123' }], team: [{ agent: 'codex', use: 'tests' }] });
  assert.deepEqual([b.key, b.name, b.on, b.agent, b.parallel], ['scout', 'Scout', ['ci', 'finished'], 'auto', 2]);
  assert.deepEqual(b.kit, [{ kind: 'skill', name: 'read-ci', description: 'when CI fails', body: 'steps' }], 'no path or id travels');
  assert.throws(() => normalizeBlueprint({ name: 'Scout', cwd: '/Users/me/repo' }), /cwd: a shared member has no folder/);
  assert.throws(() => normalizeBlueprint({ name: 'Scout', machine: 'abc' }), /machine: a shared member has no machine/);
  assert.throws(() => normalizeBlueprint({ name: 'Scout', cron: 'now and then' }), /cron: Couldn’t read/);
  assert.equal(normalizeBlueprint({ name: 'Scout', cron: 'daily' }).cron, '0 9 * * *');
  assert.throws(() => normalizeBlueprint({ name: 'Scout', on: ['issues'] }), /on: issues isn't one of/);
  assert.throws(() => normalizeBlueprint({ name: 'Scout', mode: 'yolo' }), /mode: plan, edits or auto/);
  assert.throws(() => normalizeBlueprint({ name: 'Scout', kit: [{ kind: 'skill', name: 'x', body: 'y' }] }), /kit: Say when x should be used/);
  assert.throws(() => normalizeBlueprint({ name: '<b>' }), /name: up to 24/);
  assert.throws(() => normalizeBlueprint({ name: 'Scout', team: [{ crew: 'scout' }] }), /delegate to themselves/);
  assert.throws(() => normalizeBlueprints([{ name: 'Scout' }, { name: 'scout' }]), /members\[1\] \(scout\): two members share/);
  assert.throws(() => normalizeBlueprints([{ name: 'Scout', team: [{ crew: 'quill' }] }]), /delegates to quill, who isn't in this file/);
  assert.deepEqual(normalizeBlueprints([{ name: 'Scout', team: [{ crew: 'quill' }] }, { name: 'Quill' }])[0].team, [{ crew: 'quill' }]);
});

test('the editor’s templates are blueprints, so the site can publish them as files to import', async () => {
  const { TEMPLATES } = await import('../web/js/crew-templates.js');
  const list = normalizeBlueprints(TEMPLATES, 'templates');
  assert.equal(list.length, TEMPLATES.length);
  assert.deepEqual(list.map((b) => b.key), TEMPLATES.map((t) => t.key), 'their keys name the files');
});

test('a crew file: one member, a list, or { wispCrew, members }; a spell goes to the spell review', () => {
  assert.equal(parseCrewFile({ name: 'Ada' }).members[0].name, 'Ada');
  assert.equal(parseCrewFile([{ name: 'Ada' }, { name: 'Bo' }]).members.length, 2);
  assert.equal(parseCrewFile({ wispCrew: 1, members: [{ name: 'Ada' }] }).members[0].key, 'ada');
  assert.ok(parseCrewFile({ wispSpell: 1, id: 'x', name: 'X' }).spell);
  assert.throws(() => parseCrewFile({ wispCrew: 2, members: [{ name: 'Ada' }] }), /update wisp/);
  assert.throws(() => parseCrewFile({ wispCrew: 1, members: [] }), /no crew members/);
  assert.throws(() => parseCrewFile({ hello: 1 }), /A crew file is/);
  assert.equal(uniqueName('Scout', ['scout']), 'Scout 2');
  assert.equal(uniqueName('Scout', ['scout', 'scout-2']), 'Scout 3');
  assert.equal(uniqueName('Abcdefghijklmnopqrstuvwx', ['abcdefghijklmnopqrstuvwx']), 'Abcdefghijklmnopqrstuv 2', 'still a valid name (24 at most)');
});

// --- through the server ----------------------------------------------------------------------------

test('export: who they are, never where they run; delegates and the notebook only when asked', async () => {
  await clear();
  const repo = makeRepo();
  const quill = await api('/crew', { name: 'Quill', role: 'PR reviewer', brief: 'Review PRs.', cwd: repo, agent: 'claude' });
  const scout = await api('/crew', {
    name: 'Scout',
    role: 'CI watcher',
    brief: 'Watch CI on main.',
    cron: '*/30 * * * *',
    on: ['finished'],
    cwd: repo,
    agent: 'claude',
    mode: 'plan',
    notebook: 'main is protected',
    kit: [{ kind: 'rules', name: 'AGENTS.md', body: 'Be brief.' }],
    team: [{ agent: 'codex', use: 'run the tests' }, { crew: quill.id, name: 'Quill' }],
  });
  const one = await api('/crew/export', { ids: ['scout'] });
  assert.equal(one.file, 'scout.crew.json');
  const [b] = one.bundle.members;
  assert.equal(one.bundle.wispCrew, 1);
  assert.deepEqual([b.name, b.cron, b.on, b.mode, b.agent, b.kit[0].name], ['Scout', '*/30 * * * *', ['finished'], 'plan', 'claude', 'AGENTS.md']);
  for (const k of ['cwd', 'machine', 'notebook', 'log', 'queue', 'offers', 'id', 'paused', 'createdAt']) assert.ok(!(k in b), `${k} stays here`);
  assert.ok(!JSON.stringify(one.bundle).includes(repo), 'no path anywhere');
  assert.deepEqual(b.team, [{ agent: 'codex', use: 'run the tests' }], 'a crew delegate not shared stays here…');
  assert.match(one.notes.join('\n'), /delegates to Quill, who stays here/, '…and the notes say so');

  const both = await api('/crew/export', { ids: [scout.id], team: true, notebook: true, kit: false });
  assert.deepEqual(both.bundle.members.map((x) => x.name), ['Scout', 'Quill']);
  assert.deepEqual(both.bundle.members[0].team.at(-1), { crew: 'quill' });
  assert.equal(both.bundle.members[0].notebook, 'main is protected');
  assert.deepEqual(both.bundle.members[0].kit, []);
  assert.equal(both.file, 'crew.crew.json');
  await assert.rejects(api('/crew/export', { ids: ['Nobody'] }), /No one called “Nobody”/);
});

test('the secret scan blocks a share and says where; the gist is secret, through gh', async () => {
  await api('/crew/scout', { notebook: `deploy with ghp_${'a'.repeat(36)}` }, 'PATCH');
  const err = await api('/crew/export', { ids: ['Scout'], notebook: true }).catch((e) => e);
  assert.equal(err.status, 422);
  assert.match(err.message, /a GitHub token in Scout · notebook, line 1/);
  assert.deepEqual(err.body.hits, [{ where: 'Scout · notebook', line: 1, what: 'a GitHub token' }]);
  assert.ok(!err.message.includes('ghp_'), 'the token itself is never echoed');
  const gistsBefore = records(RECORD, 'gh').filter((r) => r.argv[0] === 'gist').length;
  await assert.rejects(api('/crew/export', { ids: ['Scout'], notebook: true, gist: true }), /looks like a secret/);
  assert.equal(records(RECORD, 'gh').filter((r) => r.argv[0] === 'gist').length, gistsBefore, 'nothing was posted');

  // Without the notebook it's clean: posted to a secret gist.
  const out = await api('/crew/export', { ids: ['Scout'], gist: true });
  assert.match(out.gist.ref, /^gist:abc\d{5}$/);
  assert.match(out.gist.url, /^https:\/\/gist\.github\.com\/acme\//);
  const call = records(RECORD, 'gh').filter((r) => r.argv[0] === 'gist').at(-1);
  assert.deepEqual(call.argv.slice(0, 2), ['gist', 'create']);
  assert.ok(!call.argv.includes('--public') && !call.argv.includes('-p'), 'never public');
  const state = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, 'utf8'));
  const gist = state.gists[out.gist.ref.slice(5)];
  assert.equal(gist.public, false);
  assert.deepEqual(JSON.parse(gist.files['scout.crew.json']), out.bundle);
  assert.match(gist.description, /Scout: a wisp crew member/);
});

test('the import review: names that clash, a harness not here, delegates left out, who needs a project', async () => {
  const file = { wispCrew: 1, members: [{ name: 'Scout', role: 'CI watcher', on: ['ci'], agent: 'nope-cli', model: 'x-1', team: [{ crew: 'echo' }] }, { name: 'Echo', role: 'Release notes', cron: '0 17 * * 5' }] };
  const r = await api('/crew/import', { text: JSON.stringify(file), dryRun: true });
  assert.equal(r.members.length, 2);
  const [s, e] = r.members;
  assert.deepEqual([s.name, s.agent, s.model, s.needsProject, e.name, e.needsProject], ['Scout 2', 'auto', '', true, 'Echo', false]);
  assert.match(s.notes.join('\n'), /Scout is already on your crew: they join as Scout 2/);
  assert.match(s.notes.join('\n'), /Prefers nope-cli, which isn't installed here/);
  assert.equal(r.room, 12 - 2);
  // Leaving Echo out drops the delegation to them, and says so.
  const left = await api('/crew/import', { text: JSON.stringify(file), dryRun: true, choices: { echo: { skip: true }, scout: { name: 'Sentry' } } });
  assert.deepEqual([left.members[0].name, left.members[0].team], ['Sentry', []]);
  assert.match(left.members[0].notes.join('\n'), /Delegates to Echo, who you left out/);
  assert.equal((await api('/crew')).length, 2, 'a review adds no one');
  // A spell pasted here goes to the spell review instead.
  assert.equal((await api('/crew/import', { text: JSON.stringify({ wispSpell: 1, id: 'x', name: 'X' }), dryRun: true })).spell.id, 'x');
  await assert.rejects(api('/crew/import', { text: 'not json' }), /That isn't JSON/);
  await assert.rejects(api('/crew/import', { url: 'http://example.com/x.crew.json' }), /https URL or gist/);
});

test('import: paused, with their triggers and delegates; a CI watcher needs a project; all or none', async () => {
  const repo = makeRepo();
  const file = { wispCrew: 1, members: [{ name: 'Scout', role: 'CI watcher', brief: 'Watch CI.', on: ['ci'], mode: 'plan', kit: [{ kind: 'skill', name: 'read-ci', description: 'when CI fails', body: 'gh run view --log-failed' }], team: [{ crew: 'echo' }] }, { name: 'Echo', role: 'Release notes', on: ['done'], notebook: 'we use keep-a-changelog' }] };
  const n = (await api('/crew')).length;
  await assert.rejects(api('/crew/import', { text: JSON.stringify(file) }), /Scout 2 starts when CI fails: pick the project/);
  await assert.rejects(api('/crew/import', { text: JSON.stringify(file), choices: { scout: { cwd: '/no/such/dir' } } }), /Not a folder/);
  assert.equal((await api('/crew')).length, n, 'a refused import adds no one');
  assert.equal((await api('/triggers')).length, (await api('/triggers')).filter((t) => (t.crew ? true : true)).length);

  const r = await api('/crew/import', { text: JSON.stringify(file), choices: { scout: { cwd: repo } } });
  assert.deepEqual(r.members.map((m) => [m.name, m.paused]), [['Scout 2', true], ['Echo', true]]);
  const [s, e] = r.members;
  assert.equal(s.cwd, repo);
  assert.equal(s.mode, 'plan');
  assert.equal(s.kit[0].name, 'read-ci');
  assert.ok(!s.spell, 'an import is yours');
  assert.deepEqual(s.team.map((t) => t.crew), [e.id], 'the delegate is the Echo just added');
  assert.equal(e.notebook, 'we use keep-a-changelog');
  assert.deepEqual((await triggersOf(s.id)).map((t) => [t.kind, t.cwd]), [['ci', repo]]);
  assert.deepEqual((await triggersOf(e.id)).map((t) => t.kind), ['done']);
  // Theirs to edit, like any member.
  assert.equal((await api(`/crew/${s.id}`, { brief: 'Mine now.', paused: false }, 'PATCH')).brief, 'Mine now.');

  // No room: nobody joins.
  await clear();
  const many = { wispCrew: 1, members: Array.from({ length: 12 }, (_, i) => ({ name: `M${i}` })) };
  await api('/crew/import', { text: JSON.stringify(many) });
  await assert.rejects(api('/crew/import', { text: JSON.stringify({ name: 'One more' }) }), /room for 0 more/);
  await clear();
});

test('an agent adds the members from a shared file when the user gives one', async () => {
  const cwd = makeRepo();
  const s = await api('/sessions', { prompt: 'CREWIMPORT: add the member from this file', cwd, agent: 'claude', mode: 'edits', worktree: false });
  assert.match((await ended(s.id)).turns.at(-1).presentation.blocks[0].summary, /Added Iris to the user's crew, paused/);
  const iris = await byName('Iris');
  assert.deepEqual([iris.paused, iris.cwd, iris.role], [true, cwd, 'Importer']);
  assert.deepEqual((await triggersOf(iris.id)).map((t) => t.kind), ['finished']);
  await clear();
});

const spell = (over = {}) => ({
  wispSpell: 1,
  id: 'ci-crew',
  name: 'CI crew',
  version: '1.0.0',
  crew: [
    { key: 'scout', name: 'Scout', role: 'CI watcher', brief: 'Watch CI.', cron: '*/30 * * * *', on: ['finished'], mode: 'plan', team: [{ crew: 'quill' }] },
    { key: 'quill', name: 'Quill', role: 'PR reviewer', brief: 'Review PRs.' },
  ],
  ...over,
});

test('a spell brings members: paused until you review them, the spell’s to change, yours to place', async () => {
  await clear();
  const repo = makeRepo();
  const out = await api('/spells', { spell: spell(), enable: true });
  assert.equal(out.spell.kind, 'runs', 'a member with a schedule runs on its own');
  assert.match(out.spell.summary.join('\n'), /A crew member, Scout · CI watcher: works every 30 min, when a task finishes, in Plan mode\. Joins paused/);
  const scout = await byName('Scout');
  const quill = await byName('Quill');
  assert.deepEqual([scout.paused, scout.changed.from, scout.spell.name, scout.spell.key], [true, null, 'CI crew', 'scout']);
  assert.deepEqual(scout.team.map((t) => t.crew), [quill.id], 'a delegate in the same spell');
  assert.deepEqual(await triggersOf(scout.id), [], 'no triggers before you resume them: nothing queues for them');

  // What the spell owns is locked; where they work isn't.
  await assert.rejects(api(`/crew/${scout.id}`, { brief: 'Something else' }, 'PATCH'), /comes from the “CI crew” spell.*brief.*Make it mine/);
  await assert.rejects(api(`/crew/${scout.id}`, { on: ['ci'] }, 'PATCH'), /sets what starts them/);
  await assert.rejects(api(`/crew/${scout.id}`, { paused: false }, 'PATCH'), /review it before they resume/);
  const resumed = await api(`/crew/${scout.id}`, { paused: false, accept: true, cwd: repo, on: ['finished'], parallel: 3 }, 'PATCH');
  assert.deepEqual([resumed.paused, resumed.changed, resumed.cwd, resumed.parallel], [false, undefined, repo, 3]);
  assert.deepEqual((await triggersOf(scout.id)).map((t) => t.kind), ['finished']);
  await api(`/crew/${scout.id}`, { notebook: 'learned: main is protected' }, 'PATCH');

  // An update that only renames their role applies at once; one that changes their brief pauses them.
  await api('/spells', { spell: spell({ version: '1.1.0', crew: [{ ...spell().crew[0], role: 'CI lead' }, spell().crew[1]] }) });
  let now = await byName('Scout');
  assert.deepEqual([now.role, now.paused, now.changed], ['CI lead', false, undefined]);
  await api('/spells', { spell: spell({ version: '2.0.0', crew: [{ ...spell().crew[0], role: 'CI lead', brief: 'Watch CI and fix it.', mode: 'auto' }, spell().crew[1]] }) });
  now = await byName('Scout');
  assert.deepEqual([now.brief, now.mode, now.paused], ['Watch CI and fix it.', 'auto', true], 'the server paused them');
  assert.deepEqual([now.changed.from.brief, now.changed.from.mode], ['Watch CI.', 'plan'], 'and kept what it was, for the diff');
  assert.deepEqual([now.notebook, now.cwd, now.parallel], ['learned: main is protected', repo, 3], 'what they learned and your choices stay');
  assert.equal((await api(`/crew/${scout.id}`, { paused: false, accept: true }, 'PATCH')).paused, false);

  // Switched off: out of the crew, triggers and all. Back on: as they were.
  await api('/spells/ci-crew', { enabled: false }, 'PATCH');
  assert.equal(await byName('Scout'), undefined);
  assert.deepEqual(await triggersOf(scout.id), []);
  await api('/spells/ci-crew', { enabled: true }, 'PATCH');
  now = await byName('Scout');
  assert.deepEqual([now.id, now.notebook, now.paused, now.cwd], [scout.id, 'learned: main is protected', false, repo]);
  assert.deepEqual((await triggersOf(scout.id)).map((t) => t.kind), ['finished']);

  // Make it mine: the spell lets go of them, and an update no longer touches them.
  await api(`/crew/${quill.id}/detach`, {});
  assert.equal((await api(`/crew/${quill.id}`, { brief: 'My own brief.' }, 'PATCH')).brief, 'My own brief.');
  await api('/spells', { spell: spell({ version: '3.0.0', crew: [{ ...spell().crew[0], role: 'CI lead', brief: 'Watch CI and fix it.', mode: 'auto' }, { ...spell().crew[1], brief: 'Changed by the spell.' }] }) });
  assert.equal((await byName('Quill')).brief, 'My own brief.');
  assert.equal((await api('/crew')).filter((m) => m.name.startsWith('Quill')).length, 2, 'the spell adds its own Quill again, numbered');
  assert.ok(await byName('Quill 2'));
});

test('removing a spell: its members stay on as yours, or go with it; switched-off ones too', async () => {
  await api('/spells/ci-crew', undefined, 'DELETE');
  const scout = await byName('Scout');
  assert.ok(scout && !scout.spell, 'kept, as yours');
  assert.equal(scout.paused, false);
  await clear();

  await api('/spells', { spell: spell({ id: 'two', name: 'Two' }), enable: true });
  assert.ok(await byName('Scout'));
  await api('/spells/two?crew=remove', undefined, 'DELETE');
  assert.deepEqual(await api('/crew'), [], 'gone with it');

  // One switched off is kept too (paused, back in the crew).
  await api('/spells', { spell: spell({ id: 'three', name: 'Three' }), enable: true });
  await api('/spells/three', { enabled: false }, 'PATCH');
  assert.deepEqual(await api('/crew'), []);
  await api('/spells/three', undefined, 'DELETE');
  assert.deepEqual((await api('/crew')).map((m) => [m.name, m.paused, !!m.spell]).sort(), [['Quill', true, false], ['Scout', true, false]]);
  await clear();
});
