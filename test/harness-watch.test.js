// Harness watch (server/harness-watch.js): wisp pins each harness's program (path, size, sha256,
// version) the first time it runs it, and says when it changed: an update as info, anything else as
// a warning, with Trust this version. Ask before running a changed harness holds the run instead.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { installFakeBins, makeRepo, tmp, until, win } from './helpers.js';

process.env.WISP_HOME = tmp('hw-wisp');
process.env.WISP_UPDATE_CHECK = '0';
process.env.CLAUDE_CONFIG_DIR = tmp('hw-claude-home'); // never this computer's ~/.claude
const BIN_DIR = installFakeBins();
const { startServer } = await import('../server/index.js');
const { HarnessWatch, classify, installDir, versionUp, resolveBin, changeLine } = await import('../server/harness-watch.js');

let srv;
let base;
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
async function api(p, body, method) {
  const r = await fetch(`${base}/api${p}`, { method: method || (body ? 'POST' : 'GET'), headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(`${p}: ${j.error}`), { status: r.status });
  return j;
}
const ended = (id) =>
  until(
    async () => {
      const x = await api(`/sessions/${id}`);
      return x.state !== 'running' && !['running', 'held'].includes(x.turns.at(-1).status) && x;
    },
    { timeout: 30_000 },
  );

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

// A program in its own folder: `name` under dir, with these bytes.
function program(dir, name, body) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  fs.writeFileSync(f, body);
  fs.chmodSync(f, 0o755);
  return f;
}

test('versionUp, installDir and classify: an update is a newer version in the same install folder', () => {
  assert.equal(versionUp('2.0.1 (Claude Code)', '2.0.2 (Claude Code)'), true);
  assert.equal(versionUp('2.0.10', '2.0.9'), false);
  assert.equal(versionUp('2.0.1', '2.0.1'), false);
  assert.equal(versionUp('', '2.0.1'), false); // unknown: not an update
  assert.equal(installDir('/opt/homebrew/Cellar/codex/0.1.2/bin/codex'), installDir('/opt/homebrew/Cellar/codex/0.1.3/bin/codex'));
  assert.equal(installDir('/h/.local/share/claude/versions/2.0.1'), installDir('/h/.local/share/claude/versions/2.0.2'));
  assert.notEqual(installDir('/usr/local/bin/claude'), installDir('/tmp/evil/claude'));
  const pin = { real: '/opt/homebrew/Cellar/codex/0.1.2/bin/codex', version: 'codex 0.1.2' };
  assert.equal(classify(pin, { real: '/opt/homebrew/Cellar/codex/0.1.3/bin/codex', version: 'codex 0.1.3' }), 'update');
  assert.equal(classify(pin, { real: '/tmp/x/codex', version: 'codex 0.1.3' }), 'warn'); // another folder
  assert.equal(classify(pin, { real: pin.real, version: 'codex 0.1.2' }), 'warn'); // same version, other bytes
  assert.equal(classify(pin, { real: '/opt/homebrew/Cellar/codex/0.1.1/bin/codex', version: 'codex 0.1.1' }), 'warn'); // went back
});

test('resolveBin finds a program on PATH and through a symlink', { skip: win && 'symlinks need admin on Windows' }, () => {
  const dir = tmp('hw-resolve');
  const real = program(path.join(dir, 'versions', '1.0.0'), 'tool', '#!/bin/sh\n');
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.symlinkSync(real, path.join(dir, 'bin', 'tool'));
  const at = resolveBin('tool', { PATH: path.join(dir, 'bin') });
  assert.equal(at.path, path.join(dir, 'bin', 'tool'));
  assert.equal(at.real, fs.realpathSync(real));
  assert.equal(resolveBin('nope-not-here', { PATH: path.join(dir, 'bin') }), null);
});

test('the first run pins; the same program says nothing; a touched one keeps its pin', async () => {
  const home = tmp('hw-home');
  const f = program(tmp('hw-a'), 'agent', 'v1');
  const w = new HarnessWatch(home);
  assert.equal(await w.observe('claude', f, '1.0.0'), null);
  const pin = JSON.parse(fs.readFileSync(path.join(home, 'harnesses.json'), 'utf8')).pins.claude;
  assert.equal(pin.sha256.length, 64);
  assert.equal(pin.size, 2);
  assert.equal(pin.version, '1.0.0');
  assert.equal(await w.observe('claude', f, '1.0.0'), null);
  assert.equal(w.suspect('claude', f), false);
  fs.utimesSync(f, new Date(), new Date(Date.now() + 5000)); // touched, same bytes
  assert.equal(w.suspect('claude', f), true); // a stat can't tell...
  assert.equal(await w.observe('claude', f, '1.0.0'), null); // ...the hash can
  assert.equal(w.suspect('claude', f), false);
  // Read back by a new wisp: the pin survives a restart.
  assert.equal(new HarnessWatch(home).view('claude').pinnedAt, pin.at);
});

test('other bytes at the same version warn; Trust this version pins them', async () => {
  let now = 1000;
  const w = new HarnessWatch(tmp('hw-home'), { now: () => now });
  const f = program(tmp('hw-b'), 'agent', 'v1');
  await w.observe('codex', f, 'codex 0.1.2');
  now = 2000;
  fs.writeFileSync(f, 'evil');
  assert.equal(w.suspect('codex', f), true);
  const c = await w.observe('codex', f, 'codex 0.1.2');
  assert.equal(c.kind, 'warn');
  assert.equal(c.from.version, 'codex 0.1.2');
  assert.notEqual(c.from.sha256, c.to.sha256);
  assert.equal(c.at, 2000);
  assert.match(changeLine('Codex', c), /^Codex changed since 1970-01-01: codex 0\.1\.2 \(other bytes: [0-9a-f]{12}…\)$/);
  // Seen again, it's the same open change (its date doesn't move).
  now = 3000;
  assert.equal((await w.observe('codex', f, 'codex 0.1.2')).at, 2000);
  assert.deepEqual(w.view('codex').changed.to.sha256, c.to.sha256);
  assert.equal(w.trust('codex'), true);
  assert.equal(w.change('codex'), null);
  assert.equal(w.view('codex').pinnedAt, 3000);
  assert.equal(await w.observe('codex', f, 'codex 0.1.2'), null);
  assert.equal(w.trust('codex'), false); // nothing left to trust
});

test('a newer version in the same install folder is an update; another folder is a warning', async () => {
  const root = tmp('hw-c');
  const w = new HarnessWatch(tmp('hw-home'));
  const v1 = program(path.join(root, 'Cellar', 'codex', '0.1.2', 'bin'), 'codex', 'one');
  await w.observe('codex', v1, 'codex 0.1.2');
  const v2 = program(path.join(root, 'Cellar', 'codex', '0.1.3', 'bin'), 'codex', 'two');
  assert.equal((await w.observe('codex', v2, 'codex 0.1.3')).kind, 'update');
  const evil = program(path.join(root, 'tmp'), 'codex', 'three');
  // Still compared with what you last trusted (0.1.2), not with the untrusted 0.1.3.
  const c = await w.observe('codex', evil, 'codex 0.1.4');
  assert.equal(c.kind, 'warn');
  assert.equal(c.from.version, 'codex 0.1.2');
  assert.equal(c.to.path, evil);
});

test('hashing is cached by path, size and mtime', async () => {
  const w = new HarnessWatch(tmp('hw-home'));
  const f = program(tmp('hw-d'), 'agent', 'aaaa');
  const t = 1_700_000_000; // whole seconds: utimes keeps them exactly
  fs.utimesSync(f, t, t);
  const first = await w.fingerprint(f);
  fs.writeFileSync(f, 'bbbb'); // same size...
  fs.utimesSync(f, t, t); // ...and mtime: the cache answers without reading it
  assert.equal((await w.fingerprint(f)).sha256, first.sha256);
  fs.utimesSync(f, t, t + 5);
  assert.notEqual((await w.fingerprint(f)).sha256, first.sha256);
});

// The fake claude on PATH, swapped for other bytes.
const fakeClaude = path.join(BIN_DIR, win ? 'claude.cmd' : 'claude');
const swap = () => fs.appendFileSync(fakeClaude, win ? '\r\nREM changed\r\n' : '\n// changed\n');

test('a run on a changed harness carries the change; the harness list has it until trusted', async () => {
  const cwd = makeRepo();
  // The run never waits for the hash (runner.js #watchHarness), so a fast fake run can end before
  // its pin is written (a loaded macOS runner did). Hold the hash until the run ended, every time.
  const w = srv.runner.harnessWatch;
  const fingerprint = w.fingerprint;
  let hashNow;
  const gate = new Promise((resolve) => {
    hashNow = resolve;
  });
  w.fingerprint = async (bin) => {
    await gate;
    return fingerprint.call(w, bin);
  };
  const s1 = await api('/sessions', { prompt: 'fix the add bug please', cwd, agent: 'claude', worktree: false });
  await ended(s1.id);
  assert.equal((await api('/agents')).find((a) => a.id === 'claude').pinnedAt, undefined, 'the run ended before its hash');
  w.fingerprint = fingerprint;
  hashNow();
  const first = await until(async () => {
    const a = (await api('/agents')).find((x) => x.id === 'claude');
    return a.pinnedAt && a;
  });
  assert.ok(first.pinnedAt, 'pinned on its first run');
  assert.equal(first.changed, undefined);
  assert.equal((await api(`/sessions/${s1.id}`)).turns.at(-1).harness, undefined);

  swap();
  const s2 = await api('/sessions', { prompt: 'fix the add bug please', cwd, agent: 'claude', worktree: false });
  const done = await until(async () => {
    const x = await api(`/sessions/${s2.id}`);
    return x.turns.at(-1).harness && x.turns.at(-1).status !== 'running' && x;
  });
  const c = done.turns.at(-1).harness;
  assert.equal(c.kind, 'warn'); // same version, other bytes
  assert.equal(done.turns.at(-1).status, 'done'); // never in the way of the run
  const listed = (await api('/agents')).find((a) => a.id === 'claude');
  assert.equal(listed.changed.to.sha256, c.to.sha256);

  const after = (await api('/agents/claude/trust', {})).find((a) => a.id === 'claude');
  assert.equal(after.changed, undefined);
  assert.ok(after.pinnedAt >= c.at);
  assert.ok((await api('/agents/claude/trust', {})).length, 'trusting again answers the list');
  await assert.rejects(api('/agents/nope/trust', {}), (e) => e.status === 404);
});

test('Ask before running a changed harness holds the run until Trust and start', async () => {
  await assert.rejects(api('/config', { defaults: { harnessAsk: 'yes' } }, 'PATCH'), /harnessAsk must be on or off/);
  await api('/config', { defaults: { harnessAsk: 'on' } }, 'PATCH');
  try {
    const cwd = makeRepo();
    // Not changed: it just runs.
    const ok = await api('/sessions', { prompt: 'fix the add bug please', cwd, agent: 'claude', worktree: false });
    assert.notEqual((await ended(ok.id)).turns.at(-1).status, 'held');

    swap();
    const s = await api('/sessions', { prompt: 'fix the add bug please', cwd, agent: 'claude', worktree: false });
    const held = await until(async () => {
      const x = await api(`/sessions/${s.id}`);
      return x.turns.at(-1).held?.harness?.kind && x;
    });
    assert.equal(held.turns.at(-1).status, 'held');
    assert.equal(held.turns.at(-1).held.harness.kind, 'warn');
    const row = (await api('/sessions')).find((x) => x.id === s.id);
    assert.equal(row.held.harness.kind, 'warn'); // the summary says why, for its row
    assert.equal(row.status, 'held');
    await assert.rejects(api(`/sessions/${s.id}/held`, { action: 'wait' }, 'POST'), /trust it, or skip/);
    await api(`/sessions/${s.id}/held`, { action: 'start' }, 'POST');
    const ran = await ended(s.id);
    assert.equal(ran.turns.length, 1);
    assert.equal(ran.turns[0].status, 'done');
    assert.equal((await api('/agents')).find((a) => a.id === 'claude').changed, undefined, 'started = trusted');

    // Skip this run: it never runs, and says why.
    swap();
    const k = await api('/sessions', { prompt: 'fix the add bug please', cwd, agent: 'claude', worktree: false });
    await until(async () => (await api(`/sessions/${k.id}`)).turns.at(-1).held?.harness?.kind);
    await api(`/sessions/${k.id}/held`, { action: 'skip' }, 'POST');
    const skipped = (await api(`/sessions/${k.id}`)).turns.at(-1);
    assert.equal(skipped.status, 'stopped');
    assert.match(skipped.presentation.blocks[0].summary, /changed and wasn’t trusted/);
  } finally {
    await api('/config', { defaults: { harnessAsk: 'off' } }, 'PATCH');
  }
});
