// Tasks on disk (server/store.js): a start reads each task's light file and leaves its turns'
// activity, changes and raw answers on disk until something reads them; saves land in the
// background, latest first; the list keeps summaries until a task changes (runner.js listSummary).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmp, until } from './helpers.js';

const { Store } = await import('../server/store.js');
const { listSummary } = await import('../server/runner.js');
const { toolStats, usage } = await import('../server/usage.js');

const task = (id, n = 3) => ({
  id,
  title: `task ${id}`,
  cwd: '/tmp',
  agent: 'claude',
  state: 'review',
  createdAt: 1,
  updatedAt: 2,
  queue: [],
  turns: Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    prompt: `do ${i}`,
    status: 'done',
    presentation: { blocks: [{ type: 'hero', title: `done ${i}`, summary: 's', status: 'done' }] },
    activity: [{ t: i, kind: 'read', label: `read ${i}`, output: 'x'.repeat(1000) }],
    changes: [{ file: 'a.js', op: 'edit', beforeFile: 'old', edits: [{ old: 'a', new: 'b' }] }],
    raw: `answer ${i}`,
  })),
});
const onDisk = (home, id) => JSON.parse(fs.readFileSync(path.join(home, 'sessions', `${id}.json`), 'utf8'));
const lazyKeys = (turn) => ['activity', 'changes', 'raw'].filter((k) => Object.getOwnPropertyDescriptor(turn, k)?.get);

test('a start reads light files: heavy fields load on first read, and a save keeps all of them', () => {
  const home = tmp('store-light');
  const a = new Store(home);
  const s = task('aaaaaaaaaaaa');
  a.put(s);
  a.flush();
  assert.ok(fs.existsSync(path.join(home, 'sessions', '.light', 'aaaaaaaaaaaa.json')));

  const b = new Store(home);
  const t = b.get('aaaaaaaaaaaa');
  assert.equal(t.turns.length, 3);
  assert.equal(t.turns[2].presentation.blocks[0].title, 'done 2');
  assert.deepEqual(lazyKeys(t.turns[0]), ['activity', 'changes', 'raw'], 'not read yet');
  // The list doesn't read them.
  assert.equal(listSummary(t, b).preview, 's');
  assert.deepEqual(lazyKeys(t.turns[0]), ['activity', 'changes', 'raw']);
  // A save of something else keeps every heavy field in the full file.
  t.title = 'renamed';
  b.save(t, { now: true });
  assert.deepEqual(onDisk(home, t.id), { ...s, title: 'renamed' });
  assert.deepEqual(lazyKeys(t.turns[0]), [], 'loaded to be saved');

  // Read straight away, as the runner does.
  const c = new Store(home);
  const u = c.get('aaaaaaaaaaaa');
  assert.equal(u.turns[1].activity[0].label, 'read 1');
  u.turns[1].activity.push({ t: 9, kind: 'edit', label: 'more' });
  u.turns[0].raw = 'changed';
  delete u.turns[2].changes;
  c.save(u, { now: true });
  const disk = onDisk(home, u.id);
  assert.equal(disk.turns[1].activity.length, 2);
  assert.equal(disk.turns[0].raw, 'changed');
  assert.equal(disk.turns[2].changes, undefined);
  assert.deepEqual(disk.turns[0].changes, s.turns[0].changes);
});

test('a task file changed outside wisp is read in full, not from its stale light file', () => {
  const home = tmp('store-stale');
  const a = new Store(home);
  a.put(task('bbbbbbbbbbbb'));
  a.flush();
  const file = path.join(home, 'sessions', 'bbbbbbbbbbbb.json');
  const edited = { ...onDisk(home, 'bbbbbbbbbbbb'), title: 'edited by hand' };
  fs.writeFileSync(file, JSON.stringify(edited) + '\n');
  const b = new Store(home);
  assert.equal(b.get('bbbbbbbbbbbb').title, 'edited by hand');
  assert.deepEqual(lazyKeys(b.get('bbbbbbbbbbbb').turns[0]), []);
});

test('background saves: only the latest lands, a flush writes what is on its way, a deleted task stays gone', async () => {
  const home = tmp('store-writes');
  const a = new Store(home);
  const s = task('cccccccccccc', 1);
  a.put(s);
  a.flush();
  // Two saves in flight, then one right now: the file ends with the last.
  s.title = 'one';
  a.save(s);
  s.title = 'two';
  a.save(s, { now: true });
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(onDisk(home, s.id).title, 'two');
  // A save on its way when the server stops: flush writes it.
  s.title = 'three';
  a.save(s);
  a.flush();
  assert.equal(onDisk(home, s.id).title, 'three');
  // Deleted while a background write is out: nothing comes back.
  s.title = 'four';
  a.save(s);
  await until(() => a.inflight.has(s.id) || onDisk(home, s.id).title === 'four');
  a.delete(s.id);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!fs.existsSync(path.join(home, 'sessions', `${s.id}.json`)));
  assert.ok(!fs.existsSync(path.join(home, 'sessions', '.light', `${s.id}.json`)));
  assert.deepEqual(fs.readdirSync(path.join(home, 'sessions')).filter((f) => f.includes('tmp')), []);
});

test('the list keeps a task’s summary until it changes', () => {
  const home = tmp('store-summary');
  const a = new Store(home);
  const s = task('dddddddddddd', 1);
  a.put(s);
  const one = listSummary(s, a);
  assert.equal(listSummary(s, a), one, 'kept');
  s.title = 'new title';
  a.save(s);
  const two = listSummary(s, a);
  assert.notEqual(two, one);
  assert.equal(two.title, 'new title');
  // A change without a save that moves its state still shows.
  s.state = 'running';
  assert.equal(listSummary(s, a).state, 'running');
  // The config (a project's name and colour) is on every row.
  const three = listSummary(s, a);
  a.config.projects.push({ id: 'p1', name: 'Proj', path: '/tmp', color: 'teal' });
  a.saveConfig();
  assert.equal(listSummary(s, a).project, 'Proj');
  assert.notEqual(listSummary(s, a), three);
  a.flush();
});

test('the usage stats count a task’s questions and tool calls without loading its activity', () => {
  const home = tmp('store-usage');
  const a = new Store(home);
  const s = task('eeeeeeeeeeee', 2);
  const now = Date.now();
  s.turns.forEach((t, i) => {
    t.startedAt = now - 1000;
    t.activity = [
      { t: now - 900, kind: 'ask', label: 'Needs your OK to run rm' },
      { t: now - 800, kind: 'ask', label: 'Which one?' },
      { t: now - 700, kind: 'read', label: 'a.js' },
      { t: now - 600, kind: 'edit', label: 'a.js' },
      { t: now - 500, kind: 'text', label: 'thinking' },
    ].slice(0, 3 + i);
  });
  a.put(s);
  const full = { usage: usage(a.all(), { now }), tools: toolStats(a.all(), { now }) };
  a.flush();
  const b = new Store(home);
  const light = { usage: usage(b.all(), { now }), tools: toolStats(b.all(), { now }) };
  assert.deepEqual(light, full);
  assert.equal(full.tools.total.calls, 7); // asks count as calls too
  assert.equal(full.usage.total.questions, 4);
  assert.deepEqual(lazyKeys(b.get(s.id).turns[0]), ['activity', 'changes', 'raw'], 'still on disk');
});
