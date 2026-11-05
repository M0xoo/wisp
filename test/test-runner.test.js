import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/test.mjs', import.meta.url));

// A copy of scripts/test.mjs in a folder of its own, run the way npm runs it. NODE_TEST_CONTEXT goes:
// inside a test node --test would see it, call itself recursive and run nothing.
function run(files, args = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-test-runner-'));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.mkdirSync(path.join(dir, 'test', 'fixtures'), { recursive: true });
  fs.copyFileSync(script, path.join(dir, 'scripts', 'test.mjs'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, 'test', name), body);
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const r = spawnSync(process.execPath, ['scripts/test.mjs', ...args], { cwd: dir, env, encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  return { code: r.status, out: r.stdout + r.stderr };
}
const said = (word) => `import fs from 'node:fs'; fs.writeSync(2, ${JSON.stringify(`ran ${word}\n`)});`;

test('every test/*.test.js runs, and nothing else in test/', () => {
  const { code, out } = run({ 'a.test.js': said('a'), 'b-c.test.js': said('b-c'), 'helpers.js': said('helpers'), 'real-clis.mjs': said('real'), 'fixtures/d.test.js': said('fixture') });
  assert.equal(code, 0, out);
  assert.match(out, /ran a\b/);
  assert.match(out, /ran b-c\b/);
  assert.doesNotMatch(out, /ran (helpers|real|fixture)/);
});

test('a failing test fails the run with node --test’s exit code', () => {
  const { code, out } = run({ 'a.test.js': said('a'), 'b.test.js': 'throw new Error("boom")' });
  assert.equal(code, 1, out);
  assert.match(out, /ran a\b/);
});

test('flags reach node --test, ahead of the files', () => {
  const { code, out } = run({ 'a.test.js': `import test from 'node:test'; test('kept', () => {}); test('dropped', () => { throw new Error('ran it'); });` }, ['--test-name-pattern=kept']);
  assert.equal(code, 0, out);
});

test('no test files is a failure, not bare node --test finding its own', () => {
  const { code, out } = run({ 'helpers.js': said('helpers') });
  assert.equal(code, 1, out);
  assert.match(out, /no test\/\*\.test\.js found/);
  assert.doesNotMatch(out, /ran helpers/);
});
