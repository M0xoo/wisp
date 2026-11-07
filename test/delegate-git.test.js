// A lead's delegate call starts all its subagents in one tick, in one folder. Harnesses that only
// say "file X changed" need that folder pinned first (fileTracker), through blocking git calls:
// one set for the lot, or the server answers nothing while N of them run one after the other.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { installFakeBins, makeRepo, tmp, until } from './helpers.js';

const win = process.platform === 'win32';
process.env.FAKE_RECORD = tmp('delegate-git-record');
process.env.WISP_HOME = tmp('delegate-git-home');
process.env.WISP_UPDATE_CHECK = '0';
process.env.WISP_NO_OPEN = '1';
installFakeBins();

// Every git wisp runs goes through this and leaves a line: what's counted is what ran, not timing.
const log = path.join(tmp('delegate-git-log'), 'git.log');
const realGit = execFileSync(win ? 'where' : 'which', ['git']).toString().split(/\r?\n/)[0].trim();
const shim = path.join(tmp('delegate-git-shim'), 'git');
if (!win) {
  fs.writeFileSync(shim, `#!/bin/sh\necho "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(realGit)} "$@"\n`);
  fs.chmodSync(shim, 0o755);
}
const calls = (re) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n') : []).filter((l) => re.test(l));
const counting = () => {
  fs.rmSync(log, { force: true });
  process.env.WISP_GIT_BIN = shim;
};

const { startServer } = await import('../server/index.js');
const { fileTracker } = await import('../server/adapters/common.js');

let srv;
let base;
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const tick = () => new Promise((r) => setImmediate(r));

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  srv = await startServer({ port, handleSignals: false });
});
after(() => {
  delete process.env.WISP_GIT_BIN;
  srv.shutdown();
  srv.server.closeAllConnections?.();
  srv.server.close();
});

test('a delegate call pins the folder once, however many subagents it starts', { skip: win && 'the git shim is a shell script' }, async () => {
  const cwd = makeRepo();
  counting();
  const r = await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'ADHOC*14 please review', cwd, agent: 'claude', worktree: false }) });
  const { id } = await r.json();
  assert.ok(id, 'launched');
  const done = await until(async () => {
    const x = await (await fetch(`${base}/api/sessions/${id}`)).json();
    return x.state === 'review' && !srv.runner.live.has(id) && x;
  }, { timeout: 60_000 });
  delete process.env.WISP_GIT_BIN;
  assert.equal(done.subagents.length, 14);
  // The lead's checkpoint is one; the fourteen subagents, started in one tick, share another.
  assert.equal(calls(/^stash create/).length, 2, calls(/^stash create/).join('\n'));
  // All fourteen report math.js changed: it comes out of their pin once. The other read is the
  // lead's own edit, from its checkpoint.
  const shows = calls(/^show .*math\.js/);
  assert.equal(shows.length, 2, shows.join('\n'));
});

test('trackers started in one tick share a pin; the next tick pins the folder as it is then', { skip: win && 'the git shim is a shell script' }, async () => {
  const cwd = makeRepo();
  const file = path.join(cwd, 'math.js');
  const start = fs.readFileSync(file, 'utf8');
  await tick();
  counting();
  const [a, b] = [fileTracker(cwd), fileTracker(cwd)];
  assert.equal(calls(/^stash create/).length, 1, 'one pin for both');

  fs.writeFileSync(file, 'second\n');
  await tick();
  const c = fileTracker(cwd);
  assert.equal(calls(/^stash create/).length, 2, 'a new tick, a new pin');

  fs.writeFileSync(file, 'third\n');
  assert.equal(a.change('math.js').edits[0].before, start);
  assert.equal(b.change('math.js').edits[0].before, start);
  assert.equal(c.change('math.js').edits[0].before, 'second\n', 'not what the earlier trackers pinned');
  assert.equal(calls(/^show /).length, 2, 'a and b read the file from git once between them');

  // A pin in another folder is its own.
  const other = makeRepo();
  fileTracker(other);
  assert.equal(calls(/^stash create/).length, 3);
  delete process.env.WISP_GIT_BIN;
});
