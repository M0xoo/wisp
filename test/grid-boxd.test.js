// boxd and the container driver without Docker: a fake `docker` (test/fixtures/fake-docker.mjs)
// runs each box's wisp as a plain process. Checked: boxd only runs what it is built to run (its own
// image, network and mounts; the run's values checked), secrets never reach a command line, homes
// live in boxd's folder, old homes move with migrate, and deleting an account removes the box and
// its files, through boxd or with hostd running docker itself.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { browser, installFakeBins, tmp, until } from './helpers.js';

const unix = process.platform !== 'win32'; // boxd is a Unix socket on a Linux server
const sqlite = await import('node:sqlite').then(
  () => true,
  () => false,
);
const skip = !unix && 'boxd runs on Linux (Unix sockets)';
const skipGrid = skip || (!sqlite && 'the grid needs node:sqlite (Node 22.13+)');

installFakeBins();
const dockerDir = tmp('docker');
const FAKE_DOCKER = fileURLToPath(new URL('./fixtures/fake-docker.mjs', import.meta.url));
const shebang = /\s/.test(process.execPath) ? '/usr/bin/env node' : process.execPath;
fs.writeFileSync(path.join(dockerDir, 'docker'), `#!${shebang}\nimport(${JSON.stringify(pathToFileURL(FAKE_DOCKER).href)});\n`, { mode: 0o755 });
process.env.PATH = `${dockerDir}${path.delimiter}${process.env.PATH}`;
process.env.WISP_UPDATE_CHECK = '0';
const dockerCalls = () => {
  const f = path.join(dockerDir, 'docker.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};
const runsOf = (name) => dockerCalls().filter((c) => c.args[0] === 'run' && c.name === name);

const { BOXD, CONTAINER, checkRun, containerRun, boxdCall, boxdRun, migrate, serveBoxd, writeEnvFile } = await import('../grid/boxd.js');

const health = (port) =>
  new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => req.destroy());
  });
const exitOf = (child, ms = 15_000) =>
  Promise.race([new Promise((r) => child.on('exit', (code, signal) => r({ code, signal }))), new Promise((_, no) => setTimeout(() => no(new Error('the box never exited')), ms).unref())]);
let nextPort = 47600 + Math.floor(Math.random() * 300);
const port = () => nextPort++;
const SECRET = 'grid-proxy-secret-'.padEnd(48, 'x');

test('boxd checks what a run asks for; image, network, mounts and uid stay its own', { skip, timeout: 30_000 }, () => {
  assert.throws(() => checkRun({ id: '../etc', port: 47000 }), /user id/);
  assert.throws(() => checkRun({ id: 'u1', port: 80 }), /port/);
  assert.throws(() => checkRun({ id: 'u1', port: 47000, env: { 'A B': 'x' } }), /variable name/);
  assert.throws(() => checkRun({ id: 'u1', port: 47000, env: { A: 'x\nLD_PRELOAD=/tmp/x.so' } }), /line break/);
  assert.throws(() => checkRun({ id: 'u1', port: 47000, limits: { memory: 'lots' } }), /size like 1536m/);
  assert.throws(() => checkRun({ id: 'u1', port: 47000, limits: { pids: 1 } }), /pids/);
  assert.throws(() => checkRun({ id: 'u1', port: 47000, dns: ['evil.example'] }), /dns/);
  const r = checkRun({ id: 'u1', port: 47000, env: { S: 'x' }, image: 'alpine', network: 'host', runtime: 'runc', home: '/', uid: 0 });
  assert.deepEqual(Object.keys(r).sort(), ['dns', 'env', 'id', 'limits', 'port'], 'nothing else is taken from the request');
  assert.deepEqual(r.limits, { memory: '1536m', memorySwap: '3g', cpus: 1.5, pids: 512 });

  const dir = tmp('envfile');
  const f = path.join(dir, 'env');
  writeEnvFile(f, { WISP_TRUSTED_PROXY_SECRET: SECRET, A: 'b=c' });
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(f, 'utf8'), `WISP_TRUSTED_PROXY_SECRET=${SECRET}\nA=b=c\n`);
  const s = containerRun({ ...CONTAINER, envFile: f, name: 'wisp-u-1', port: 47001, home: '/h' }).args.join(' ');
  assert.doesNotMatch(s, /SECRET/);
});

test('boxd runs a box: its own settings, the home in its folder, secrets in a 0600 file; SIGTERM stops it', { skip, timeout: 30_000 }, async () => {
  const root = tmp('boxd');
  const socket = path.join(root, 'box.sock');
  const boxes = path.join(root, 'boxes');
  const b = await serveBoxd({ socket, boxes, data: path.join(root, 'data'), group: null, log: () => {} });
  try {
    assert.equal(fs.statSync(socket).mode & 0o777, 0o660, 'only root and the grid’s group');
    const ping = await boxdCall(socket, { op: 'ping' });
    assert.equal(ping.boxes, boxes);
    const p = port();
    const logFile = path.join(root, 'u1.log');
    // A request can't pick the network or the image: boxd's own are used.
    const child = boxdRun(socket, { id: 'u1', port: p, env: { WISP_TRUSTED_PROXY_SECRET: SECRET, FAKE_DELAY: '100' }, network: 'host', image: 'alpine' }, logFile);
    await until(() => health(p), { what: 'the box', every: 150 });
    const [run] = runsOf('wisp-u-u1');
    assert.equal(run.home, path.join(boxes, 'u1', 'home'));
    assert.equal(run.network, CONTAINER.network);
    assert.equal(run.runtime, CONTAINER.runtime);
    assert.ok(run.args.includes(CONTAINER.image) && !run.args.includes('alpine'));
    assert.equal(run.envFileMode, 0o600);
    assert.ok(run.envKeys.includes('WISP_TRUSTED_PROXY_SECRET'));
    assert.ok(!run.args.join(' ').includes(SECRET), 'never on the command line');
    assert.ok(fs.existsSync(path.join(boxes, 'u1', 'home', '.wisp')), 'the box’s wisp lives in that home');
    assert.equal(fs.statSync(path.join(boxes, 'u1')).mode & 0o777, 0o700);
    assert.equal((await boxdCall(socket, { op: 'ping' })).running, 1);
    const exit = exitOf(child);
    assert.equal(child.kill('SIGTERM'), true);
    await exit;
    assert.ok(!fs.existsSync(path.join(boxes, 'u1', 'env')), 'the env file goes with the box');
    assert.ok(fs.existsSync(path.join(boxes, 'u1', 'home')), 'the home stays');
    assert.ok(fs.readFileSync(logFile, 'utf8').length > 0, 'its output reaches the grid’s log');

    // Bad requests are answered with why.
    const bad = boxdRun(socket, { id: '../x', port: p }, logFile);
    await exitOf(bad);
    assert.match(bad.error, /user id/);
    await assert.rejects(boxdCall(socket, { op: 'format-disk' }), /Unknown op/);
  } finally {
    await b.close();
  }
  const gone = boxdRun(socket, { id: 'u1', port: port() }, path.join(root, 'x.log'));
  await exitOf(gone);
  assert.match(gone.error, /boxd didn’t answer/);
});

test('boxd: a home at the old place must be migrated first; migrate moves it (not links); remove deletes it all', { skip, timeout: 30_000 }, async () => {
  const root = tmp('boxd-mig');
  const socket = path.join(root, 'box.sock');
  const boxes = path.join(root, 'boxes');
  const data = path.join(root, 'data');
  fs.mkdirSync(path.join(data, 'users', 'u2', 'home', '.claude'), { recursive: true });
  fs.writeFileSync(path.join(data, 'users', 'u2', 'home', '.claude', '.credentials.json'), '{"token":"t"}');
  fs.mkdirSync(path.join(data, 'users', 'u3'), { recursive: true });
  fs.symlinkSync('/etc', path.join(data, 'users', 'u3', 'home'));
  const b = await serveBoxd({ socket, boxes, data, group: null, log: () => {} });
  try {
    const refused = boxdRun(socket, { id: 'u2', port: port() }, path.join(root, 'u2.log'));
    await exitOf(refused, 3000);
    assert.match(refused.error, /still at .*boxd\.js migrate/);
    assert.ok(!fs.existsSync(path.join(boxes, 'u2', 'home')), 'no empty home in its place');

    const r = migrate({ data, boxes, log: () => {} });
    assert.deepEqual(r, { moved: ['u2'], skipped: ['u3'] });
    assert.equal(fs.readFileSync(path.join(boxes, 'u2', 'home', '.claude', '.credentials.json'), 'utf8'), '{"token":"t"}');
    assert.ok(!fs.existsSync(path.join(data, 'users', 'u2', 'home')));
    assert.ok(!fs.existsSync(path.join(boxes, 'u3')), 'a link is never followed');

    const p = port();
    const child = boxdRun(socket, { id: 'u2', port: p, env: { FAKE_DELAY: '100' } }, path.join(root, 'u2.log'));
    await until(() => health(p), { what: 'the migrated box', every: 150 });
    assert.throws(() => migrate({ data, boxes, log: () => {} }), /stop the grid first/);

    const exit = exitOf(child);
    await boxdCall(socket, { op: 'remove', id: 'u2' });
    await exit;
    assert.ok(!fs.existsSync(path.join(boxes, 'u2')), 'home, logins and all');
    assert.ok(dockerCalls().some((c) => c.args.join(' ') === 'rm -f wisp-u-u2'));
    await assert.rejects(boxdCall(socket, { op: 'remove', id: '..' }), /user id/);
  } finally {
    await b.close();
  }
});

// --- a whole grid on the container driver ------------------------------------------------------

async function gridWith(container, dataDir = tmp('grid-c')) {
  const { loadConfig } = await import('../grid/config.js');
  const { startGrid } = await import('../grid/server.js');
  const { ensureMaster } = await import('../grid/secrets.js');
  ensureMaster(dataDir);
  // Room by memory has its own tests (grid-hostd): here the test machine's memory mustn't matter.
  const hostd = { driver: 'container', container, idleMs: 60_000, checkMs: 500, admit: false, env: { FAKE_DELAY: '100' } };
  // The CLI reads grid.json; the running grid gets the same.
  fs.writeFileSync(path.join(dataDir, 'grid.json'), JSON.stringify({ hostd }));
  const cfg = loadConfig({ dataDir, env: {}, overrides: { domain: 'wisp.localhost', listen: { host: '127.0.0.1', port: port() }, auth: { dev: true } } });
  return { cfg, grid: await startGrid(cfg, { log: () => {} }) };
}

async function signInAndOpen(g, email) {
  const b = browser();
  const base = g.cfg.publicUrl;
  const start = await b.go(`${base}/auth/dev/start`);
  const csrf = /name="csrf" value="([^"]+)"/.exec(start.text)[1];
  await b.go(`${base}/auth/dev/callback`, { method: 'POST', form: { csrf, email, name: email, return: '/' }, headers: { origin: base } });
  const r = await b.follow(`${base}/go`);
  const origin = new URL(r.at).origin;
  await until(async () => (await b.go(`${origin}/api/health`, { headers: { accept: 'application/json' } })).status === 200, { what: `${email}’s box`, every: 200 });
  return { b, origin, user: g.grid.accounts.byHandle(email.split('@')[0]) };
}

async function deleteOnPage(g, b, handle) {
  const base = g.cfg.publicUrl;
  const csrf = /name="csrf" value="([^"]+)"/.exec((await b.go(`${base}/`)).text)[1];
  return b.go(`${base}/account/delete`, { method: 'POST', form: { csrf, confirm: handle }, headers: { origin: base } });
}

test('a grid through boxd: boxes start through the edge, homes stay out of the grid’s folder, deleting takes the box', { skip: skipGrid, timeout: 60_000 }, async () => {
  const root = tmp('grid-boxd');
  const socket = path.join(root, 'box.sock');
  const boxes = path.join(root, 'boxes');
  const dataDir = path.join(root, 'data');
  const b = await serveBoxd({ socket, boxes, data: dataDir, group: null, log: () => {} });
  const g = await gridWith({ boxd: socket }, dataDir);
  try {
    const { b: gus, origin, user } = await signInAndOpen(g, 'gus@example.com');
    assert.equal(g.grid.hostd.state(user.id), 'running');
    const launched = await gus.go(`${origin}/api/sessions`, { method: 'POST', body: { prompt: 'fix the bug', agent: 'claude' }, headers: { origin } });
    assert.equal(launched.status, 201, launched.text);
    assert.ok(fs.existsSync(path.join(boxes, user.id, 'home', '.wisp')));
    assert.deepEqual(fs.readdirSync(path.join(dataDir, 'users', user.id)), ['wisp.log'], 'only the log in the grid’s folder');
    assert.ok(!runsOf(`wisp-u-${user.id}`)[0].args.join(' ').includes(g.grid.secrets.ensure(user.id, 'wisp-proxy')));

    const done = await deleteOnPage(g, gus, 'gus');
    assert.equal(done.status, 200, done.text);
    assert.equal(g.grid.hostd.state(user.id), 'stopped');
    assert.ok(!fs.existsSync(path.join(boxes, user.id)), 'boxd deleted the home');
    assert.ok(!fs.existsSync(path.join(dataDir, 'users', user.id)));
    assert.ok(!g.grid.accounts.byHandle('gus'));

    // From the command line, with the box running: boxd stops it, and the grid takes it in its stride.
    const { user: hal } = await signInAndOpen(g, 'hal@example.com');
    const { gridCli } = await import('../grid/cli.js');
    const log = console.log;
    console.log = () => {};
    try {
      await gridCli(['users', '--delete', 'hal', '--yes', '--data', dataDir]);
    } finally {
      console.log = log;
    }
    await until(() => g.grid.hostd.state(hal.id) === 'stopped', { what: 'hal’s box to stop' });
    assert.ok(!fs.existsSync(path.join(boxes, hal.id)));
    assert.ok(!g.grid.accounts.byHandle('hal'));
    assert.equal((await browser().go(`${g.cfg.publicUrl}/healthz`)).status, 200, 'the grid is fine');
  } finally {
    await g.grid.close();
    await b.close();
  }
});

test('a grid running docker itself: secrets in a 0600 file that’s gone once the box is up; deleting takes the box', { skip: skipGrid, timeout: 60_000 }, async () => {
  const g = await gridWith({});
  try {
    const { b, user } = await signInAndOpen(g, 'ida@example.com');
    const folder = path.join(g.cfg.dataDir, 'users', user.id);
    const [run] = runsOf(`wisp-u-${user.id}`);
    assert.equal(run.envFileMode, 0o600);
    assert.ok(run.envKeys.includes('WISP_TRUSTED_PROXY_SECRET'));
    assert.ok(!run.args.join(' ').includes(g.grid.secrets.ensure(user.id, 'wisp-proxy')), 'never on the command line');
    assert.equal(run.home, path.join(folder, 'home'));
    assert.ok(!fs.existsSync(path.join(folder, 'box.env')), 'docker has read it; it’s gone');

    const done = await deleteOnPage(g, b, 'ida');
    assert.equal(done.status, 200, done.text);
    assert.ok(!fs.existsSync(folder));
    assert.ok(dockerCalls().some((c) => c.args.join(' ') === `rm -f wisp-u-${user.id}`));
  } finally {
    await g.grid.close();
  }
});

test('boxd down: a box says so instead of starting, and deleting keeps the account, signed in, to try again', { skip: skipGrid, timeout: 60_000 }, async () => {
  const g = await gridWith({ boxd: path.join(tmp('no-boxd'), 'box.sock') });
  try {
    const b = browser();
    const base = g.cfg.publicUrl;
    const start = await b.go(`${base}/auth/dev/start`);
    const csrf0 = /name="csrf" value="([^"]+)"/.exec(start.text)[1];
    await b.go(`${base}/auth/dev/callback`, { method: 'POST', form: { csrf: csrf0, email: 'joan@example.com', name: 'joan', return: '/' }, headers: { origin: base } });
    const jo = g.grid.accounts.byHandle('joan');
    await assert.rejects(g.grid.hostd.ensure(jo), /boxd didn’t answer at .*is wisp-grid-boxd running/);
    const r = await deleteOnPage(g, b, 'joan');
    assert.equal(r.status, 409);
    assert.match(r.text, /couldn’t be deleted just now, so your account is still here/);
    assert.equal(g.grid.accounts.byHandle('joan').disabled, 0);
    assert.match((await b.go(`${base}/`)).text, /action="\/account\/delete"/, 'still signed in');
  } finally {
    await g.grid.close();
  }
});

before(() => {
  assert.equal(BOXD.socket, '/run/wisp-grid/box.sock');
});
after(() => {
  // Any box a failed test left behind.
  for (const f of fs.existsSync(path.join(dockerDir, 'state')) ? fs.readdirSync(path.join(dockerDir, 'state')) : []) {
    try {
      process.kill(Number(fs.readFileSync(path.join(dockerDir, 'state', f), 'utf8')), 'SIGKILL');
    } catch {}
  }
});
