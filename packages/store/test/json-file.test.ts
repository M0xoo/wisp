import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JsonFile } from '../src/index.ts';
import { tmpHome } from './fixture.ts';

test('write is atomic, 0600, and reads back; a missing file reads as undefined', () => {
  const file = path.join(tmpHome(), 'nested', 'secrets.json');
  const f = new JsonFile<{ token: string }>(file);
  assert.equal(f.read(), undefined);
  f.write({ token: 'a' });
  assert.deepEqual(f.read(), { token: 'a' });
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['secrets.json'], 'no temp file left');
});

test('a corrupt file throws instead of reading as empty', () => {
  const file = path.join(tmpHome(), 'secrets.json');
  fs.writeFileSync(file, '{"token": "cut-o');
  assert.throws(() => new JsonFile(file).read(), /not valid JSON/);
});

test('of two background saves only the newer lands; a sync write beats a save on its way', async () => {
  const file = path.join(tmpHome(), 'prefs.json');
  const f = new JsonFile<number>(file);
  const first = f.save(1);
  const second = f.save(2);
  assert.deepEqual(await Promise.all([first, second]), [false, true]);
  assert.equal(f.read(), 2);
  const late = f.save(3);
  f.write(4);
  assert.equal(await late, false);
  assert.equal(f.read(), 4);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['prefs.json']);
});

test('cleanTemps removes old temp files a crash left, and keeps fresh ones', () => {
  const dir = tmpHome();
  const file = path.join(dir, 'secrets.json');
  fs.writeFileSync(`${file}.123.1.tmp`, 'old');
  fs.writeFileSync(`${file}.123.2.tmp`, 'new');
  fs.writeFileSync(path.join(dir, 'other.json.1.tmp'), 'not ours');
  const old = new Date(Date.now() - 5 * 60_000);
  fs.utimesSync(`${file}.123.1.tmp`, old, old);
  assert.equal(new JsonFile(file).cleanTemps(), 1);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['other.json.1.tmp', 'secrets.json.123.2.tmp']);
});
