// Machines: a second wisp reached over SSH. "The machine" is this computer: test/fixtures/fake-ssh.mjs
// relays the -L tunnel and runs the bootstrap script with sh, so the real script starts a real
// second wisp server (its own WISP_HOME), and sessions launched through the first one run there.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installFakeBins, makeClone, makeRepo, records, same, tmp, until, win } from './helpers.js';
import { sameRepo } from '../server/git.js';
import { authorizedKeys, reachable, sshBanner, tailscaleSelf } from '../server/machines/reachable.js';
import { nodeInstallScript } from '../server/machines/bootstrap.js';
import { bootstrapScript, STEPS, splitId, qualify, sshHint, sshHosts, knownHosts, tailscalePeers, discoverHosts, updateTo } from '../server/machines.js';

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

const execGit = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
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
  assert.match(sshHint('ssh: Could not resolve hostname nope', 'nope').text, /can’t find a computer called nope/);
  assert.equal(sshHint('ssh: connect to host box port 22: Operation timed out', 'me@box').tailscale, true);
  assert.match(sshHint('ssh: connect to host box port 22: Connection refused', 'me@box').text, /Remote Login/);

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

// mobile/ copies these two files into the Android app and runs them in its WebView.
test('the bootstrap script loads without Node, for the phone app', () => {
  for (const f of ['server/machines/bootstrap.js', 'server/shq.js']) {
    const src = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    for (const [, from] of src.matchAll(/from '([^']+)'/g)) assert.ok(['../shq.js'].includes(from), `${f} imports ${from}`);
  }
  assert.deepEqual(
    STEPS.map(([id]) => id),
    ['ssh', 'node', 'wisp', 'tunnel', 'agents'],
  );
  // The phone loads whichever wisp runs there, so it skips the API check.
  const sh = bootstrapScript({ port: 4477, command: 'npx -y wisp-agents@latest', apiVersion: 'any' });
  assert.match(sh, /^API=any$/m);
  assert.match(sh, /\[ "\$API" != any \] && \[ "\$3" != "\$API" \]/);
});

// A computer with only SSH on: the script fetches Node.js into ~/.wisp/node. Here nodejs.org is a
// fake curl serving a tiny "node" tarball, so this runs offline on Linux and macOS alike.
test('no Node.js there: the script installs it into ~/.wisp/node, and refuses a bad download', { skip: win }, () => {
  const dir = tmp('node-dist');
  const os_ = execFileSync('uname', ['-s'], { encoding: 'utf8' }).trim() === 'Darwin' ? 'darwin' : 'linux';
  const arch = { x86_64: 'x64', amd64: 'x64', aarch64: 'arm64', arm64: 'arm64' }[execFileSync('uname', ['-m'], { encoding: 'utf8' }).trim()];
  const name = `node-v24.0.0-${os_}-${arch}`;
  fs.mkdirSync(path.join(dir, name, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, name, 'bin', 'node'), '#!/bin/sh\n[ "$1" = -v ] && echo v24.0.0\nexit 0\n', { mode: 0o755 });
  execFileSync('tar', ['-czf', `${name}.tar.gz`, name], { cwd: dir });
  const sha = execFileSync(os_ === 'darwin' ? 'shasum' : 'sha256sum', os_ === 'darwin' ? ['-a', '256', `${name}.tar.gz`] : [`${name}.tar.gz`], { cwd: dir, encoding: 'utf8' }).split(' ')[0];
  const bin = tmp('fake-curl');
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh\nfor a; do u=$a; done\ncat "${dir}/$(basename "$u")"\n`, { mode: 0o755 });
  const run = (sums) => {
    fs.writeFileSync(path.join(dir, 'SHASUMS256.txt'), `${sums}  ${name}.tar.gz\n`);
    const home = tmp('bare-home');
    const script = `say() { printf '@@wisp %s\\n' "$*"; }\n${nodeInstallScript({ dist: 'http://nodejs.test' })}install_node && node -v; true`;
    const out = execFileSync('sh', ['-c', script], { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8' });
    return { out, home };
  };
  const ok = run(sha);
  assert.match(ok.out, /@@wisp step node run installing Node\.js into ~\/\.wisp\/node/);
  assert.match(ok.out, /^v24\.0\.0$/m); // the installed one is on PATH afterwards
  assert.ok(fs.existsSync(path.join(ok.home, '.wisp', 'node', 'bin', 'node')));
  assert.ok(!fs.existsSync(path.join(ok.home, '.wisp', 'node-download')));
  const bad = run('0'.repeat(64));
  assert.match(bad.out, /@@wisp fail node The Node\.js download was damaged/);
  assert.ok(!fs.existsSync(path.join(bad.home, '.wisp', 'node')));
  // Machines and the phone ask for it; a script without it says what's missing instead.
  assert.match(bootstrapScript({ port: 1, command: 'x', apiVersion: 1, installNode: true }), /^INSTALL=1$/m);
  assert.match(bootstrapScript({ port: 1, command: 'x', apiVersion: 1 }), /^INSTALL=0$/m);
});

test('an older wisp on the machine can be updated to this version', () => {
  assert.equal(updateTo('0.10.0', '0.9.0'), '0.10.0');
  assert.equal(updateTo('0.10.0', '0.10.0'), null);
  assert.equal(updateTo('0.10.0', '0.11.0'), null); // newer there: leave it
  assert.equal(updateTo('0.10.0', undefined), null); // not connected yet
  assert.equal(updateTo('0.10.0', '0.9.0', 'wisp'), null); // a custom command picks the version
});

test('found hosts: ~/.ssh/config, Tailscale peers and known_hosts, one entry per target', { skip: win }, async () => {
  const dir = tmp('sshdir');
  fs.writeFileSync(path.join(dir, 'config'), 'Host devbox\n  HostName 10.0.0.5\n  User me\n');
  fs.writeFileSync(
    path.join(dir, 'known_hosts'),
    [
      'github.com ssh-ed25519 AAAA',
      'gpu.lan,192.168.1.20 ssh-ed25519 AAAA',
      '192.168.1.30 ecdsa-sha2-nistp256 AAAA',
      '[build.lan]:2222 ssh-ed25519 AAAA',
      '|1|aGFzaA==|aGFzaA== ssh-ed25519 AAAA',
      '@cert-authority *.corp ssh-ed25519 AAAA',
      'devbox ssh-ed25519 AAAA',
      'localhost ssh-ed25519 AAAA',
    ].join('\n'),
  );
  assert.deepEqual(knownHosts(path.join(dir, 'known_hosts')), [
    { host: 'gpu.lan', hostname: '192.168.1.20' },
    { host: '192.168.1.30', hostname: '' },
    { host: 'devbox', hostname: '' },
  ]);

  const ts = path.join(dir, 'tailscale');
  const status = {
    Self: { HostName: 'me' },
    Peer: {
      a: { HostName: 'studio', DNSName: 'studio.tail1.ts.net.', OS: 'macOS', Online: true, TailscaleIPs: ['100.64.0.2'] },
      b: { HostName: 'phone', DNSName: 'phone.tail1.ts.net.', OS: 'iOS', Online: true },
      c: { HostName: 'old-vm', DNSName: '', OS: 'linux', Online: false, TailscaleIPs: ['100.64.0.9'] },
    },
  };
  fs.writeFileSync(ts, `#!/bin/sh\n[ "$1 $2" = "status --json" ] || exit 2\ncat <<'EOF'\n${JSON.stringify(status)}\nEOF\n`, { mode: 0o755 });
  assert.deepEqual(await tailscalePeers({ bin: ts }), [
    { host: 'studio.tail1.ts.net', name: 'studio', os: 'macOS', online: true },
    { host: '100.64.0.9', name: 'old-vm', os: 'linux', online: false },
  ]);
  assert.deepEqual(await tailscalePeers({ bin: path.join(dir, 'missing') }), []);

  const found = await discoverHosts({ sshDir: dir, tailscale: { bin: ts } });
  assert.deepEqual(
    found.map((x) => [x.target, x.name, x.source]),
    [
      ['devbox', 'devbox', 'ssh-config'],
      ['studio.tail1.ts.net', 'studio', 'tailscale'],
      ['gpu.lan', 'gpu', 'known-hosts'],
      ['192.168.1.30', '192.168.1.30', 'known-hosts'],
      ['100.64.0.9', 'old-vm', 'tailscale'],
    ],
  ); // offline peers last; devbox only once
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
  assert.equal(v.hint.letIn, true); // the page offers the password box
  assert.match(v.hint.title, /isn’t allowed in yet/);
  assert.equal(v.steps[0].status, 'fail');
  await call('DELETE', `/machines/${m.id}`);
});

test('let me in: the password once adds this computer’s key there, then it connects', { skip: win, timeout: 60_000 }, async () => {
  process.env.FAKE_SSH_PASSWORD = 'open sesame';
  process.env.WISP_SSH_DIR = tmp('ssh-here'); // this computer's ~/.ssh: no key yet
  const m = await call('POST', '/machines', { target: 'locked-letin', port: await outsidePort() });
  await until(async () => (await machine(m.id)).state === 'error');
  await assert.rejects(call('POST', `/machines/${m.id}/let-in`, { password: 'wrong' }), /Wrong password/);
  await assert.rejects(call('POST', `/machines/${m.id}/let-in`, { password: '' }), /Type your password/);
  const r = await call('POST', `/machines/${m.id}/let-in`, { password: 'open sesame' });
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(path.join(process.env.WISP_SSH_DIR, 'id_ed25519'))); // there was none: wisp made one
  const mine = fs.readFileSync(path.join(process.env.WISP_SSH_DIR, 'id_ed25519.pub'), 'utf8').trim();
  const theirs = path.join(THERE, 'locked_letin', '.ssh', 'authorized_keys');
  assert.equal(fs.readFileSync(theirs, 'utf8'), `${mine}\n`);
  // Again: the key isn't added twice.
  await call('POST', `/machines/${m.id}/let-in`, { password: 'open sesame' });
  assert.equal(fs.readFileSync(theirs, 'utf8'), `${mine}\n`);
  // The password never reached ssh's arguments or the log.
  assert.ok(!fs.readFileSync(process.env.FAKE_SSH_LOG, 'utf8').includes('open sesame'));
  await until(async () => (await machine(m.id)).state === 'online', { timeout: 30_000 });
  await call('POST', `/machines/${m.id}/stop`, {});
  await call('DELETE', `/machines/${m.id}`);
  delete process.env.WISP_SSH_DIR;
});

test('connect, add a project, launch, follow up and stop wisp over there', { skip: win, timeout: 120_000 }, async () => {
  // Repos the machine clones go to a temp folder, not the real ~/code.
  const clonesThere = tmp('clones-there');
  fs.mkdirSync(path.join(THERE, 'me_devbox'), { recursive: true });
  fs.writeFileSync(path.join(THERE, 'me_devbox', 'config.json'), JSON.stringify({ defaults: { cloneDir: clonesThere } }));
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
  assert.ok(Array.isArray(v.remote.agents.find((a) => a.id === 'claude').models), 'machines report models so the launcher can list them');
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
  // Take over in wisp: the terminal runs over there; its stream and keys pass through here.
  if (process.platform !== 'win32') {
    const inl = await call('POST', `/sessions/${s.id}/takeover`, { inline: true, cols: 90, rows: 20 });
    assert.equal(inl.inline, true);
    await until(async () => (await call('GET', '/sessions')).find((x) => x.id === s.id)?.term === true);
    const ctl = new AbortController();
    const tr = await fetch(`${base}/api/sessions/${s.id}/term`, { signal: ctl.signal });
    assert.match(tr.headers.get('content-type'), /text\/event-stream/);
    const reader = tr.body.getReader();
    let text = '';
    const saw = async (re) => {
      while (!re.test(text)) text += new TextDecoder().decode((await reader.read()).value);
    };
    await saw(/event: hello/);
    await call('POST', `/sessions/${s.id}/term`, { data: 'from here\r' });
    await saw(/from here/);
    ctl.abort();
    await call('DELETE', `/sessions/${s.id}/term`);
    await until(async () => !(await call('GET', '/sessions')).find((x) => x.id === s.id)?.term);
  }

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

  // A project added here runs there too: wisp clones its origin there first and keeps the copy.
  const local = makeClone();
  const lp = await call('POST', '/projects', { path: local.dir });
  assert.equal(lp.origin, local.remote);
  const away = await call('POST', '/sessions', { prompt: 'Rename add to sum', cwd: local.dir, agent: 'claude', machine: m.id });
  assert.ok(away.id.endsWith(`@${m.id}`));
  assert.equal(away.projectId, lp.id); // one project, wherever it runs
  const copy = (await call('GET', '/projects')).find((x) => x.id === lp.id).copies[m.id];
  assert.ok(same(path.dirname(copy), clonesThere), copy);
  assert.ok(sameRepo(execGit(copy, 'remote', 'get-url', 'origin'), local.remote));
  assert.equal((await call('GET', `/sessions/${away.id}/wait?timeout=30`)).state, 'review');
  const awayFull = await call('GET', `/sessions/${away.id}`);
  assert.ok(same(awayFull.worktree.root, copy));
  // A second launch there reuses the copy.
  const again1 = await call('POST', '/sessions', { prompt: 'Plan only', cwd: local.dir, agent: 'claude', machine: m.id, worktree: false });
  await call('GET', `/sessions/${again1.id}/wait?timeout=30`);
  assert.ok(same(fs.realpathSync(records(RECORD, 'claude').at(-1).cwd), copy));

  // What the agent did there: a commit and uncommitted work.
  const wt = awayFull.worktree.path;
  fs.writeFileSync(path.join(wt, 'sum.js'), 'export const sum = (a, b) => a + b;\n');
  execGit(wt, 'add', 'sum.js');
  execGit(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'add sum');
  fs.appendFileSync(path.join(wt, 'math.js'), '// wip there\n');
  fs.writeFileSync(path.join(wt, 'notes.md'), 'untracked\n');

  // Follow up here instead: the task moves over, its work and history with it.
  const mv = await call('POST', `/sessions/${away.id}/reply`, { text: 'Now add a test', machine: '' });
  assert.equal(mv.moved, true);
  const home = mv.session;
  assert.ok(!home.id.includes('@'));
  assert.equal(home.projectId, lp.id);
  assert.equal(home.moved.from, 'devbox');
  assert.equal(home.title, awayFull.title);
  assert.equal((await call('GET', `/sessions/${home.id}/wait?timeout=30`)).state, 'review');
  const homeFull = await call('GET', `/sessions/${home.id}`);
  assert.equal(homeFull.turns.length, awayFull.turns.length + 1);
  assert.equal(homeFull.turns[0].moved, 'devbox');
  assert.equal(homeFull.worktree.branch, awayFull.worktree.branch);
  assert.ok(same(homeFull.worktree.root, local.dir));
  const hw = homeFull.worktree.path;
  assert.equal(fs.readFileSync(path.join(hw, 'sum.js'), 'utf8'), 'export const sum = (a, b) => a + b;\n');
  assert.match(fs.readFileSync(path.join(hw, 'math.js'), 'utf8'), /wip there/);
  assert.equal(execGit(hw, 'log', '-1', '--format=%s'), 'add sum'); // committed stays committed
  assert.deepEqual(execFileSync('git', ['status', '--porcelain'], { cwd: hw, encoding: 'utf8' }).split('\n').filter(Boolean).sort(), [' M math.js', '?? notes.md']); // the rest uncommitted again
  const heard = records(RECORD, 'claude').at(-1);
  assert.ok(same(fs.realpathSync(heard.cwd), hw));
  assert.match(heard.stdin + heard.argv.join(' '), /ran on another computer \(devbox\)[\s\S]*Rename add to sum[\s\S]*Now add a test/);
  const left = await call('GET', `/sessions/${away.id}`);
  assert.equal(left.archived, true);
  const hostHere = os.hostname().replace(/\.local$/, '');
  assert.deepEqual(left.movedTo, { id: home.id, place: hostHere });
  await assert.rejects(call('POST', `/sessions/${home.id}/reply`, { text: 'x', machine: 'nope00' }), /No such machine/);

  // And back out to the machine: same branch name is taken there, so it gets the id.
  const out = await call('POST', `/sessions/${home.id}/reply`, { text: 'Run it on the box', machine: m.id });
  assert.ok(out.session.id.endsWith(`@${m.id}`));
  assert.equal((await call('GET', `/sessions/${out.session.id}/wait?timeout=30`)).state, 'review');
  const outFull = await call('GET', `/sessions/${out.session.id}`);
  assert.equal(outFull.turns.length, homeFull.turns.length + 1);
  assert.deepEqual(outFull.turns.map((t) => t.moved || ''), ['devbox', hostHere, '']);
  assert.ok(same(outFull.worktree.root, copy));
  assert.match(fs.readFileSync(path.join(outFull.worktree.path, 'math.js'), 'utf8'), /wip there/);
  assert.equal((await call('GET', `/sessions/${home.id}`)).archived, true);

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

// Settings → Machines → This computer.
test('this computer: SSH banner, Tailscale self and authorized keys', { skip: win }, async () => {
  const sshd = net.createServer((c) => c.end('SSH-2.0-OpenSSH_test\r\n'));
  const other = net.createServer((c) => c.end('HTTP/1.1 400 Bad Request\r\n'));
  await Promise.all([sshd, other].map((s) => new Promise((r) => s.listen(0, '127.0.0.1', r))));
  try {
    assert.equal(await sshBanner({ port: sshd.address().port }), 'SSH-2.0-OpenSSH_test');
    assert.equal(await sshBanner({ port: other.address().port }), null); // something else on the port

    const dir = tmp('reach');
    const ts = path.join(dir, 'tailscale');
    const status = { BackendState: 'Running', Self: { DNSName: 'box.tail1.ts.net.', TailscaleIPs: ['fd7a::1', '100.64.0.9'] } };
    fs.writeFileSync(ts, `#!/bin/sh\nif [ "$1" = status ]; then echo '${JSON.stringify(status)}'; else echo '{"RunSSH": true}'; fi\n`, { mode: 0o755 });
    assert.deepEqual(await tailscaleSelf({ bin: ts }), { installed: true, running: true, name: 'box.tail1.ts.net', ip: '100.64.0.9', ssh: true });
    assert.deepEqual(await tailscaleSelf({ bin: path.join(dir, 'nope') }), { installed: false, running: false });

    fs.mkdirSync(path.join(dir, '.ssh'));
    assert.equal(authorizedKeys(dir), 0);
    fs.writeFileSync(path.join(dir, '.ssh', 'authorized_keys'), '# mine\nssh-ed25519 AAAA laptop\n\nssh-ed25519 BBBB wisp-phone\n');
    assert.equal(authorizedKeys(dir), 2);

    const r = await reachable({ sshPort: sshd.address().port, home: dir, tailscale: { bin: ts } });
    assert.equal(r.ssh.running, true);
    assert.equal(r.keys, 2);
    assert.equal(r.target, `${os.userInfo().username}@box.tail1.ts.net`); // the tailnet name, when there is one
    assert.equal(r.supported, true);
  } finally {
    sshd.close();
    other.close();
  }
});
