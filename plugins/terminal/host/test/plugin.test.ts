// The plugin as the kernel sees it: v1's routes with v1's answers, the terminal service runtime's take
// over uses, the "In terminal" summary field, the follow-up refusal, and cleanup with the task.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Session, SummaryField } from '@wisp-plugin/runtime-api';
import { BUSY_MESSAGE, TERMINAL, type TerminalService } from '@wisp-plugin/terminal-api';
import plugin from '../src/index.ts';
import { appHere } from '../src/routes.ts';
import { fakeCtx } from './fixtures/fake-ctx.ts';
import { fakeProc, tick } from './fixtures/fake-pty.ts';

const dir = mkdtempSync(join(tmpdir(), 'wisp-term-'));
const session = (id: string, extra: Partial<Session> = {}): Session => ({ id, title: 't', agent: 'claude', model: 'm', effort: '', mode: 'edits', cwd: dir, dirs: [], state: 'review', unread: false, archived: false, createdAt: 1, updatedAt: 1, queue: [], ext: {}, ...extra }) as unknown as Session;

async function setup(sessions: Record<string, Session> = { s1: session('s1') }, settings: Record<string, unknown> = {}) {
  const proc = fakeProc();
  const apps: string[] = [];
  const spawn = proc.spawn.bind(proc);
  proc.spawn = ((bin: string, args: readonly string[], o: Parameters<typeof spawn>[2] & { detached?: boolean }) => {
    if (o.detached) {
      apps.push([bin, ...args].join(' '));
      return { exited: Promise.resolve() };
    }
    return spawn(bin, args, o);
  }) as typeof proc.spawn;
  const f = fakeCtx({
    services: { proc },
    settings,
    commands: { 'runtime.get': (a) => {
      const s = sessions[String((a as { id: string }).id)];
      if (!s) throw Object.assign(new Error('no such session'), { code: 'not_found' });
      return s;
    } },
  });
  await plugin.setup(f.ctx);
  return { ...f, proc, apps, svc: f.provided.get(TERMINAL.id) as TerminalService };
}

test('routes: v1 paths and permissions, each one named', async () => {
  const { routes, scope } = await setup();
  assert.deepEqual(routes.map((r) => `${r.method} ${r.pattern} ${r.permission}`), [
    'GET /sessions/:id/term session:read',
    'POST /sessions/:id/term terminal:input',
    'DELETE /sessions/:id/term terminal:close',
    'GET /sessions/:id/shell session:read',
    'POST /sessions/:id/shell terminal:shell',
    'DELETE /sessions/:id/shell terminal:close',
    'POST /sessions/:id/open-shell terminal:open',
  ]);
  scope.dispose();
});

test('take over: opened through the service, streamed, typed into, resized and closed through /term', async () => {
  const { call, svc, proc, points, hook, emitted, scope } = await setup();
  assert.equal((await call('GET', '/sessions/nope/term')).status, 404);
  assert.deepEqual((await call('POST', '/sessions/s1/term', { body: { data: 'x' } })).json, { error: 'This task has no terminal open.' });
  const info = await svc.open('takeover', 's1', { argv: ['claude', '--resume', 'abc'], cwd: dir, cols: 100, rows: 20 });
  assert.equal(info.state, 'starting');
  const summary = points.get('runtime.summary')?.[0] as SummaryField;
  assert.deepEqual(summary.fields(session('s1'), undefined), { term: true }, 'the card says it is in a terminal');
  assert.deepEqual(summary.fields(session('s2'), undefined), {});
  const sse = await call('GET', '/sessions/s1/term');
  assert.equal(sse.status, 200);
  assert.equal(sse.res.headers['content-type'], 'text/event-stream');
  const child = proc.children[0];
  child?.print('fake claude · interactive · 100x20');
  assert.match(sse.res.text, /fake claude · interactive · 100x20/);
  assert.deepEqual((await call('POST', '/sessions/s1/term', { body: { data: 'hi there\r', seq: 0, from: 'page' } })).json, { ok: true });
  assert.deepEqual((await call('POST', '/sessions/s1/term', { body: { cols: 120, rows: 30 } })).json, { ok: true });
  assert.deepEqual([child?.typed, child?.sizes], [['hi there\r'], [[120, 30]]]);
  // A follow-up waits for it to end.
  assert.deepEqual(await hook('before:followUp', { id: 's1', text: 'more' }), { kind: 'veto', code: 'conflict', message: BUSY_MESSAGE });
  assert.deepEqual(await hook('before:followUp', { id: 's2', text: 'more' }), { kind: 'continue' });
  child?.exit(0);
  await tick();
  assert.match(sse.res.text, /event: exit\ndata: \{"code":0\}/);
  assert.deepEqual(summary.fields(session('s1'), undefined), {});
  assert.deepEqual(await hook('before:followUp', { id: 's1', text: 'more' }), { kind: 'continue' });
  assert.equal((await call('POST', '/sessions/s1/term', { body: { data: 'x' } })).status, 404);
  assert.deepEqual((await call('DELETE', '/sessions/s1/term')).json, { ok: true });
  assert.equal(await svc.active(), 0);
  assert.deepEqual(emitted.map((e) => (e.data as { state: string }).state), ['starting', 'running', 'ended', 'gone']);
  scope.dispose();
});

test('a terminal session (tui) takes its follow-ups typed in: no refusal', async () => {
  const { svc, hook, scope } = await setup();
  await svc.open('takeover', 's1', { argv: ['claude'], cwd: dir, tui: true });
  assert.deepEqual(await hook('before:followUp', { id: 's1', text: 'more' }), { kind: 'continue' });
  scope.dispose();
});

test('shell: started in the task’s folder, again without a restart only resizes, typed into, ended', async () => {
  const { call, proc, scope } = await setup();
  const start = await call('POST', '/sessions/s1/shell', { body: { cols: 80, rows: 24 } });
  assert.deepEqual(start.json, { ok: true, started: true, dir, gone: false });
  assert.equal(proc.calls[0]?.cwd, dir);
  assert.deepEqual(proc.calls[0]?.args, ['-l'], 'the login shell');
  assert.deepEqual((await call('POST', '/sessions/s1/shell', { body: { cols: 100, rows: 30 } })).json, { ok: true, started: false });
  assert.deepEqual(proc.children[0]?.sizes, [[100, 30]]);
  assert.deepEqual((await call('POST', '/sessions/s1/shell', { body: { data: 'ls\r' } })).json, { ok: true });
  assert.deepEqual(proc.children[0]?.typed, ['ls\r']);
  const again = await call('POST', '/sessions/s1/shell', { body: { restart: true } });
  assert.equal(again.json['started'], true);
  assert.deepEqual(proc.children[0]?.killed, ['SIGHUP'], 'the old one hung up');
  assert.equal(proc.calls.length, 2);
  assert.deepEqual((await call('DELETE', '/sessions/s1/shell')).json, { ok: true });
  assert.deepEqual((await call('POST', '/sessions/s1/shell', { body: { data: 'x' } })).json, { error: 'The shell has ended.' });
  assert.deepEqual((await call('DELETE', '/sessions/s1/shell')).json, { ok: false });
  scope.dispose();
});

test('shell: a task whose folder is gone opens in home and says so; a folder source answers first', async () => {
  const gone = session('g', { cwd: join(dir, 'nope') });
  const { call, points, scope } = await setup({ g: gone });
  const out = await call('POST', '/sessions/g/shell', {});
  assert.equal(out.json['gone'], true);
  points.set('terminal.folder', [{ id: 'wt', folder: async () => ({ dir: '/wt', root: '/wt', gone: false }) }]);
  const viaWorktree = await call('POST', '/sessions/g/shell', { body: { restart: true } });
  assert.equal(viaWorktree.json['dir'], '/wt');
  scope.dispose();
});

test('shell: archived or deleted, its terminals close', async () => {
  const s = session('s1');
  const { call, fire, svc, scope } = await setup({ s1: s });
  await call('POST', '/sessions/s1/shell', {});
  await svc.open('takeover', 's1', { argv: ['claude'], cwd: dir });
  await fire('session.changed', { id: 's1' });
  assert.ok(await svc.get('shell', 's1'), 'a change that isn’t an archive keeps it');
  s.archived = true;
  await fire('session.changed', { id: 's1' });
  assert.equal(await svc.get('shell', 's1'), null);
  assert.ok(await svc.get('takeover', 's1'));
  await fire('session.deleted', { id: 's1' });
  assert.equal(await svc.get('takeover', 's1'), null);
  scope.dispose();
});

test('open-shell: the terminal app from Settings, never through the grid’s edge', async () => {
  const { call, apps, scope } = await setup(undefined, { terminal: 'custom', 'terminal.command': 'foot -D {cwd}' });
  const via = await call('POST', '/sessions/s1/open-shell', { headers: { 'x-wisp-proxy-secret': 'x' } });
  assert.equal(via.status, 409);
  assert.match(String(via.json['error']), /no terminal app/);
  const local = await call('POST', '/sessions/s1/open-shell');
  if (appHere({ platform: process.platform, env: process.env }, { headers: {} })) {
    assert.deepEqual(local.json, { ok: true, dir });
    if (process.env['WISP_NO_OPEN'] !== '1') assert.match(apps[0] ?? '', /^sh -c foot -D '/);
  } else assert.equal(local.status, 409);
  assert.equal(appHere({ platform: 'linux', env: {} }, { headers: {} }), false, 'a headless Linux has none');
  assert.equal(appHere({ platform: 'win32', env: {} }, { headers: {} }), true);
  scope.dispose();
});

test('the plugin’s scope ending closes every terminal', async () => {
  const { svc, proc, scope } = await setup();
  await svc.open('takeover', 's1', { argv: ['claude'], cwd: dir });
  await svc.open('shell', 's1', { argv: ['sh'], cwd: dir });
  scope.dispose();
  assert.deepEqual(proc.children.map((c) => c.killed), [['SIGHUP'], ['SIGHUP']]);
});
