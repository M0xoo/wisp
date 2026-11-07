// The fake GitHub CLI itself: wisp runs it from several places at once (Ship it, the minute poll of
// every open PR, the PR panel), so what one call writes to its state file must survive the others.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRepo, tmp } from './helpers.js';

const FAKE_GH = fileURLToPath(new URL('./fixtures/fake-gh.mjs', import.meta.url));
const repo = makeRepo();
const gh = (state, ...argv) =>
  new Promise((resolve, reject) => {
    execFile(process.execPath, [FAKE_GH, ...argv], { cwd: repo, env: { ...process.env, FAKE_GH_STATE: state, FAKE_RECORD: '' } }, (err, stdout, stderr) => (err ? reject(new Error(`gh ${argv.join(' ')}: ${stderr}`)) : resolve(stdout)));
  });
const create = (state, head) => gh(state, 'pr', 'create', '--base', 'main', '--head', head, '--title', head, '--body', ' ');
const prs = (state) => JSON.parse(fs.readFileSync(state, 'utf8')).prs;

test('a pr view running beside a pr create never loses the PR it made', async () => {
  const state = path.join(tmp('fake-gh'), 'gh.json');
  await create(state, 'first');
  // The minute poll views PR 1 while Ship it creates the next one (ship.test.js 'review by another
  // harness' then read "no pull requests found"). A view only reads: it used to write back the state
  // it read at its start, over the PR the create had just saved.
  for (let round = 2; round <= 9; round++) {
    await Promise.all([create(state, `b${round}`), ...Array.from({ length: 4 }, () => gh(state, 'pr', 'view', '1', '--json', 'number'))]);
    assert.deepEqual(Object.keys(prs(state)).map(Number), Array.from({ length: round }, (_, i) => i + 1), `round ${round}`);
    assert.equal(JSON.parse(await gh(state, 'pr', 'view', `b${round}`, '--json', 'number')).number, round);
  }
});

test('a pr view waits out a pr create caught halfway through writing the state file', async () => {
  const state = path.join(tmp('fake-gh'), 'gh.json');
  await create(state, 'first');
  const whole = fs.readFileSync(state, 'utf8');
  // A create holds the lock while writeFileSync has emptied the file and not yet written it: the
  // window two CI runs hit ('Unexpected end of JSON input' from a view). Held here on purpose.
  fs.mkdirSync(`${state}.lock`);
  fs.writeFileSync(state, '');
  const view = gh(state, 'pr', 'view', '1', '--json', 'number');
  setTimeout(() => {
    fs.writeFileSync(state, whole);
    fs.rmSync(`${state}.lock`, { recursive: true });
  }, 300);
  assert.equal(JSON.parse(await view).number, 1);
});

test('pr creates at the same time each get their own number', async () => {
  const state = path.join(tmp('fake-gh'), 'gh.json');
  await Promise.all(Array.from({ length: 6 }, (_, i) => create(state, `c${i}`)));
  const all = Object.values(prs(state));
  assert.deepEqual(all.map((p) => p.number).sort((x, y) => x - y), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(all.map((p) => p.headRefName).sort(), ['c0', 'c1', 'c2', 'c3', 'c4', 'c5']);
  assert.equal(fs.existsSync(`${state}.lock`), false, 'the lock goes with the last writer');
});
