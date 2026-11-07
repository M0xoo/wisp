import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { importFiles } from '../src/index.ts';
import type { ImportFile, Writer } from '../src/index.ts';
import { open, tmpHome } from './fixture.ts';

// A v1 sessions/ folder: <id>.json written temp + rename, .light/ summaries, and the leftovers a
// crash or a background write can leave (x.json.3.tmp).
function v1Sessions(): string {
  const dir = path.join(tmpHome(), 'sessions');
  fs.mkdirSync(path.join(dir, '.light'), { recursive: true });
  for (const id of ['s1', 's2', 's3']) fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, title: `task ${id}`, turns: [{ prompt: 'hi', activity: [{ t: 'text' }] }] }));
  fs.writeFileSync(path.join(dir, '.light', 's1.json'), '{}');
  fs.writeFileSync(path.join(dir, 's4.json.3.tmp'), '{"id":"s4"');
  return dir;
}

// The fake owner handler: a session row and its events, as the runtime plugin would write them.
function handler(seen: string[]): (file: ImportFile, w: Writer) => void {
  return (file, w) => {
    const s = file.json() as { id: string; title: string; turns: { activity: unknown[] }[] };
    seen.push(file.name);
    w.upsert('session', { id: s.id, title: s.title, state: 'idle', archived: false, updated_at: Math.floor(file.mtimeMs), extra: null });
    s.turns.forEach((t, i) => w.upsert('session', { id: s.id, extra: { turns: i + 1, events: t.activity.length } }));
  };
}

test('imports each matching file once, in its own transaction, ignoring temp files and folders', async () => {
  const { store, session } = open();
  const dir = v1Sessions();
  const seen: string[] = [];
  const r = await importFiles(store, { name: 'runtime.sessions', dir, handle: handler(seen) });
  assert.deepEqual(r, { imported: ['s1.json', 's2.json', 's3.json'], unchanged: 0, failed: [], stopped: false });
  assert.equal(store.count(session), 3);
  assert.deepEqual(store.get(session, 's1')?.extra, { turns: 1, events: 1 });
  const again = await importFiles(store, { name: 'runtime.sessions', dir, handle: handler(seen) });
  assert.deepEqual(again, { imported: [], unchanged: 3, failed: [], stopped: false });
  assert.equal(seen.length, 3);
});

test('a file changed since its import (mtime or size) is imported again', async () => {
  const { store, session } = open();
  const dir = v1Sessions();
  await importFiles(store, { name: 'runtime.sessions', dir, handle: handler([]) });
  fs.writeFileSync(path.join(dir, 's2.json'), JSON.stringify({ id: 's2', title: 'renamed in v1', turns: [] }));
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(dir, 's2.json'), later, later);
  const r = await importFiles(store, { name: 'runtime.sessions', dir, handle: handler([]) });
  assert.deepEqual(r.imported, ['s2.json']);
  assert.equal(store.get(session, 's2')?.title, 'renamed in v1');
});

test('a corrupt file rolls back alone, is recorded as failed, and is not retried until it changes', async () => {
  const { store, session } = open();
  const dir = v1Sessions();
  fs.writeFileSync(path.join(dir, 's2.json'), '{"id":"s2","title":"cut o');
  const r = await importFiles(store, { name: 'runtime.sessions', dir, handle: handler([]) });
  assert.deepEqual(r.imported, ['s1.json', 's3.json']);
  assert.equal(r.failed[0]?.file, 's2.json');
  assert.equal(store.get(session, 's2'), undefined);
  const again = await importFiles(store, { name: 'runtime.sessions', dir, handle: handler([]) });
  assert.deepEqual([again.imported, again.unchanged, again.failed], [[], 3, []]);
});

test('a handler that throws after writing leaves none of that file’s rows', async () => {
  const { store, session } = open();
  const dir = v1Sessions();
  const r = await importFiles(store, {
    name: 'runtime.sessions',
    dir,
    handle: (file, w) => {
      handler([])(file, w);
      if (file.name === 's3.json') throw new Error('unknown turn shape');
    },
  });
  assert.deepEqual(r.failed, [{ file: 's3.json', error: 'unknown turn shape' }]);
  assert.equal(store.get(session, 's3'), undefined);
  assert.equal(store.count(session), 2);
});

test('stopped by its signal, it resumes where it was on the next run', async () => {
  const { store } = open();
  const dir = v1Sessions();
  const stop = new AbortController();
  const seen: string[] = [];
  const first = await importFiles(store, {
    name: 'runtime.sessions',
    dir,
    signal: stop.signal,
    handle: (f, w) => {
      handler(seen)(f, w);
      stop.abort();
    },
  });
  assert.deepEqual([first.imported, first.stopped], [['s1.json'], true]);
  const rest = await importFiles(store, { name: 'runtime.sessions', dir, handle: handler(seen) });
  assert.deepEqual([rest.imported, rest.unchanged], [['s2.json', 's3.json'], 1]);
  assert.deepEqual(seen, ['s1.json', 's2.json', 's3.json']);
});

test('a missing folder imports nothing; a custom pattern picks other files; names are checked', async () => {
  const { store } = open();
  const none = await importFiles(store, { name: 'x', dir: path.join(tmpHome(), 'nope'), handle: () => undefined });
  assert.deepEqual(none.imported, []);
  const dir = tmpHome();
  fs.writeFileSync(path.join(dir, 'budget.json'), '{}');
  fs.writeFileSync(path.join(dir, 'router.json'), '{}');
  const names: string[] = [];
  await importFiles(store, { name: 'x', dir, pattern: /^budget\.json$/, handle: (f) => void names.push(f.name) });
  assert.deepEqual(names, ['budget.json']);
  await assert.rejects(importFiles(store, { name: 'Bad Name', dir, handle: () => undefined }), /bad import name/);
});
