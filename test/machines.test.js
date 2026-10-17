// Machines: a second wisp reached over SSH. "The machine" is this computer: test/fixtures/fake-ssh.mjs
// relays the -L tunnel and runs the bootstrap script with sh, so the real script starts a real
// second wisp server (its own WISP_HOME), and sessions launched through the first one run there.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installFakeBins, makeRepo, records, tmp, until, win } from './helpers.js';
import { bootstrapScript, splitId, qualify, sshHint, sshHosts } from '../server/machines.js';

const RECORD = tmp('machines-record');
const THERE = tmp('machines-there'); // WISP_HOME on "the machine"
process.env.FAKE_RECORD = RECORD;
process.env.FAKE_SSH_HOME = THERE;
process.env.FAKE_SSH_LOG = path.join(RECORD, 'ssh.jsonl');
process.env.WISP_HOME = tmp('machines-here');
process.env.WISP_UPDATE_CHECK = '0';
installFakeBins();

// `ssh` itself: a node launcher for the fake, like the fake harnesses.
const sshDir = tmp('ssh-bin');
const ssh = path.join(sshDir, 'ssh');
fs.writeFileSync(ssh, `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(fileURLToPath(new URL('./fixtures/fake-ssh.mjs', import.meta.url))).href)});\n`);
fs.chmodSync(ssh, 0o755);
process.env.WISP_SSH = ssh;

const WISP_BIN = fileURLToPath(new URL('../bin/wisp.js', import.meta.url));
const { startServer } = await import('../server/index.js');

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

// The machine's wisp port: outside the ephemeral range every other test file binds port 0 in, so
// a server from a test running alongside can't take it and be "reused" (then stopped) by this one.
const outsidePort = async () => {
  for (;;) {
    const port = 20000 + Math.floor(Math.random() * 10000);
    const free = await new Promise((resolve) => {
      const s = net.createServer().once('error', () => resolve(false));
      s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
    });
    if (free) return port;
  }
};

let srv;
let base;
let remotePort;
async function call(method, p, body) {
  const r = await fetch(`${base}/api${p}`, {
    method,
    headers: method === 'GET' ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`${method} ${p}: ${j.error}`), { status: r.status });
  return j;
}
const machine = async (id) => (await call('GET', '/machines')).find((m) => m.id === id);
const remoteHealth = () => fetch(`http://127.0.0.1:${remotePort}/api/health`).then((r) => r.json());

before(async () => {
  const port = await freePort();
  remotePort = await outsidePort();
  base = `http://127.0.0.1:${port}`;
  srv = await startServer({ port, handleSignals: false });
});
after(async () => {
  // Whatever happened, don't leave the second wisp running.
  const h = await remoteHealth().catch(() => null);
  if (h?.pid) process.kill(h.pid, 'SIGTERM');
  srv.shutdown();
  srv.server.closeAllConnections?.();
  srv.server.close();
});

test('ids, hints, ~/.ssh/config hosts and the bootstrap script', () => {
  assert.equal(qualify('abc123', 'm1'), 'abc123@m1');
  assert.deepEqual(splitId('abc123@m1'), { id: 'abc123', machine: 'm1' });
  assert.equal(splitId('abc123'), null);
  assert.equal(sshHint('me@box: Permission denied (publickey).', 'me@box').command, 'ssh-copy-id me@box');
  assert.match(sshHint('ssh: Could not resolve hostname nope', 'nope').text, /doesn’t resolve/);

  const dir = tmp('sshcfg');
  fs.writeFileSync(path.join(dir, 'config'), `Host devbox gpu\n  HostName 10.0.0.5\n  User me\nHost *\n  ServerAliveInterval 30\nInclude extra/*.conf\n`);
  fs.mkdirSync(path.join(dir, 'extra'));
  fs.writeFileSync(path.join(dir, 'extra', 'work.conf'), 'Host build-1\n  HostName build.internal\n');
  assert.deepEqual(
    sshHosts(path.join(dir, 'config')).map((h) => [h.host, h.hostname, h.user]),
    [
      ['devbox', '10.0.0.5', 'me'],
      ['gpu', '10.0.0.5', 'me'],
    ],
  ); // Include paths resolve under ~/.ssh, so the temp one isn't followed

  const sh = bootstrapScript({ port: 4555, command: "npx -y wisp-agents@1.2.3 # it's", apiVersion: 1 });
  assert.match(sh, /^PORT=4555$/m);
  assert.match(sh, /^CMD='npx -y wisp-agents@1\.2\.3 # it'\\''s'$/m);
  assert.doesNotMatch(sh, /__[A-Z]+__/);
});

test('an SSH host that is not a host is refused (no option injection)', async () => {
  await assert.rejects(call('POST', '/machines', { target: '-oProxyCommand=touch /tmp/x', connect: false }), /SSH host/);
  await assert.rejects(call('POST', '/machines', { target: 'a b', connect: false }), /SSH host/);
});

test('a failed connect says why and what to run', { skip: win }, async () => {
  const m = await call('POST', '/machines', { target: 'locked-box' });
  const v = await until(async () => {
    const x = await machine(m.id);
    return x.state === 'error' && x;
  });
  assert.match(v.error, /Permission denied/);
  assert.equal(v.hint.command, 'ssh-copy-id locked-box');
  assert.equal(v.steps[0].status, 'fail');
  await call('DELETE', `/machines/${m.id}`);
});

test('connect, add a project, launch, follow up and stop wisp over there', { skip: win, timeout: 120_000 }, async () => {
  const m = await call('POST', '/machines', { target: 'me@devbox', port: remotePort, command: `${JSON.stringify(process.execPath)} ${JSON.stringify(WISP_BIN)}` });
  assert.equal(m.name, 'devbox');
  const v = await until(
    async () => {
      const x = await machine(m.id);
      if (x.state === 'error') throw new Error(`${x.error}\n${x.log.join('\n')}`);
      return x.state === 'online' && x;
    },
    { timeout: 60_000 },
  );
  assert.deepEqual(
    v.steps.map((s) => [s.id, s.status]),
    [
      ['ssh', 'done'],
      ['node', 'done'],
      ['wisp', 'done'],
      ['tunnel', 'done'],
      ['agents', 'done'],
    ],
  );
  assert.match(v.steps[2].detail, /^started · /);
  assert.ok(v.remote.agents.some((a) => a.id === 'claude' && a.available));
  const health = await remoteHealth();
  assert.equal(health.pid, v.remote.pid); // a second, separate wisp
  assert.notEqual(health.pid, process.pid);

  // The ssh command line: keys only, the tunnel, and nothing but `sh -s` for the login shell.
  const argv = fs.readFileSync(process.env.FAKE_SSH_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((a) => a.includes('me@devbox'));
  assert.ok(argv.includes('BatchMode=yes'));
  assert.ok(argv.some((a) => new RegExp(`^\\d+:127\\.0\\.0\\.1:${remotePort}$`).test(a)));
  assert.deepEqual(argv.slice(-2), ['me@devbox', 'sh -s']);

  // A project over there: checked by that wisp, kept here with the machine's id.
  const repo = makeRepo();
  await assert.rejects(call('POST', '/projects', { machine: m.id, path: path.join(repo, 'nope') }), /Not a folder/);
  const p = await call('POST', '/projects', { machine: m.id, path: repo });
  assert.equal(p.machine, m.id);
  assert.equal(p.path, repo);
  const discovered = await call('GET', `/machines/${m.id}/discover`);
  assert.ok(!discovered.some((f) => f.path === repo));
  const dirs = await call('GET', `/machines/${m.id}/fs?q=${encodeURIComponent(repo + '/')}`);
  assert.ok(Array.isArray(dirs));

  // The event stream relays the machine's events under the rewritten ids.
  const ac = new AbortController();
  const events = await fetch(`${base}/api/events`, { signal: ac.signal });
  let seen = '';
  (async () => {
    try {
      for await (const chunk of events.body) seen += Buffer.from(chunk).toString('utf8');
    } catch {}
  })();

  // An attachment uploaded here travels with the launch.
  const up = await fetch(`${base}/api/uploads?name=notes.txt&type=text/plain`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: 'remember the milk' }).then((r) => r.json());
  const s = await call('POST', '/sessions', { prompt: 'Fix the add bug', cwd: repo, agent: 'claude', worktree: false, attachments: [up.id], machine: m.id });
  assert.match(s.id, new RegExp(`^[0-9a-f]{12}@${m.id}$`));
  assert.deepEqual(s.machine, { id: m.id, name: 'devbox', target: 'me@devbox' });
  assert.equal(s.projectId, p.id);

  const done = await call('GET', `/sessions/${s.id}/wait?timeout=30`);
  assert.equal(done.state, 'review');
  assert.equal(done.id, s.id);
  const run = records(RECORD, 'claude').at(-1);
  assert.equal(fs.realpathSync(run.cwd), fs.realpathSync(repo));
  assert.match(run.stdin + run.argv.join(' '), new RegExp(`${THERE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*notes\\.txt`)); // its copy, over there
  const full = await call('GET', `/sessions/${s.id}`);
  assert.equal(full.id, s.id);
  assert.equal(full.turns.length, 1);
  assert.ok(full.turns[0].attachments[0].id.endsWith(`@${m.id}`));
  assert.equal(await fetch(`${base}/api/uploads/${full.turns[0].attachments[0].id}`).then((r) => r.text()), 'remember the milk');
  const md = await fetch(`${base}/api/sessions/${s.id}/presentation?format=markdown`).then((r) => r.text());
  assert.ok(md.length > 0);

  const list = await call('GET', '/sessions');
  const listed = list.find((x) => x.id === s.id);
  assert.equal(listed.projectId, p.id);
  assert.ok(!list.some((x) => x.agent === 'wisp' && x.machine)); // its welcome tour stays over there
  await until(() => seen.includes(`"id":"${s.id}"`));

  // Follow-up, mark done, takeover command: all on the same session over there.
  await call('POST', `/sessions/${s.id}/reply`, { text: 'Also add a test' });
  await until(async () => (await call('GET', `/sessions/${s.id}`)).turns.length === 2 && (await call('GET', `/sessions/${s.id}/wait?timeout=30`)).state === 'review');
  const patched = await call('PATCH', `/sessions/${s.id}`, { state: 'done' });
  assert.equal(patched.state, 'done');
  assert.equal(patched.id, s.id);
  const take = await call('GET', `/sessions/${s.id}/takeover`);
  assert.match(take.command, /'-t' 'me@devbox' 'sh -c '/);
  assert.match(take.command, /--resume/);

  // One prompt, here and on the machine at once: a shared groupId makes them one task.
  const gid = 'ab12cd34ef56';
  const [here, there] = await Promise.all([
    call('POST', '/sessions', { prompt: 'Same task everywhere', cwd: repo, agent: 'claude', worktree: false, groupId: gid }),
    call('POST', '/sessions', { prompt: 'Same task everywhere', cwd: repo, agent: 'claude', worktree: false, groupId: gid, machine: m.id }),
  ]);
  assert.equal(here.groupId, gid);
  assert.equal(there.groupId, gid);
  assert.ok(!here.machine);
  assert.ok(there.id.endsWith(`@${m.id}`));
  for (const x of [here, there]) assert.equal((await call('GET', `/sessions/${x.id}/wait?timeout=30`)).state, 'review');
  assert.deepEqual((await call('GET', '/sessions')).filter((x) => x.groupId === gid).map((x) => !!x.machine).sort(), [false, true]);

  // Offline: the last sessions seen stay listed; actions say it's offline.
  await call('POST', `/machines/${m.id}/disconnect`);
  await until(async () => (await machine(m.id)).state === 'off');
  assert.ok((await call('GET', '/sessions')).some((x) => x.id === s.id));
  await assert.rejects(call('GET', `/sessions/${s.id}`), (err) => err.status === 503 && /offline/.test(err.message));
  assert.equal((await remoteHealth()).pid, v.remote.pid); // wisp over there kept running

  // Reconnect finds it running; stop takes it down.
  await call('POST', `/machines/${m.id}/connect`);
  const again = await until(async () => {
    const x = await machine(m.id);
    return x.state === 'online' && x;
  });
  assert.match(again.steps[2].detail, /^already running/);
  await call('POST', `/machines/${m.id}/stop`, {});
  await until(async () => !(await remoteHealth().catch(() => null)));

  ac.abort();
  await call('DELETE', `/machines/${m.id}`);
  const cfg = await call('GET', '/config');
  assert.ok(!cfg.projects.some((x) => x.machine === m.id));
  assert.ok(!cfg.machines.some((x) => x.id === m.id));
});
