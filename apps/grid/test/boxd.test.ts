// boxd and the container driver without Docker: a fake `docker` (fixtures/fake-docker.ts) runs each
// box as a plain process (fixtures/fake-box.ts). Checked: boxd only runs what it is built to run (its
// own image, network and mounts; the run's values checked), secrets never reach a command line, homes
// live in boxd's folder, old homes move with migrate, and deleting an account removes the box and its
// files, through boxd or with hostd running docker itself. And boxd itself imports only node: modules.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { BOXD, CONTAINER, checkRun, containerRun, boxdCall, boxdRun, migrate, serveBoxd, writeEnvFile, type BoxdChild } from '../src/boxd.ts';
import { loadConfig } from '../src/config.ts';
import { ensureMaster } from '../src/secrets.ts';
import { browser, fixture, freePort, tmp, until } from './helpers.ts';

const unix = process.platform !== 'win32'; // boxd is a Unix socket on a Linux server
const skip = !unix && 'boxd runs on Linux (Unix sockets)';
const GRID = new URL('../src/grid.ts', import.meta.url);
// The tests that boot a whole grid need the edge's startGrid (apps/grid/src/grid.ts).
const skipGrid = skip || (!fs.existsSync(GRID) && 'needs apps/grid/src/grid.ts (startGrid), which isn’t there yet');

const dockerDir = tmp('docker');
const shebang = /\s/.test(process.execPath) ? '/usr/bin/env node' : process.execPath;
fs.writeFileSync(path.join(dockerDir, 'docker'), `#!${shebang}\nimport(${JSON.stringify(pathToFileURL(fixture('fake-docker.ts')).href)});\n`, { mode: 0o755 });
process.env['PATH'] = `${dockerDir}${path.delimiter}${process.env['PATH'] ?? ''}`;
process.env['WISP_UPDATE_CHECK'] = '0';

interface DockerCall {
  args: string[];
  name?: string;
  home?: string;
  network?: string;
  runtime?: string | null;
  envFileMode?: number | null;
  envKeys?: string[];
}
const dockerCalls = (): DockerCall[] => {
  const f = path.join(dockerDir, 'docker.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as DockerCall) : [];
};
const runsOf = (name: string): DockerCall[] => dockerCalls().filter((c) => c.args[0] === 'run' && c.name === name);

const health = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => req.destroy());
  });
const exitOf = (child: BoxdChild, ms = 15_000): Promise<unknown> =>
  Promise.race([new Promise((r) => child.on('exit', (code: unknown, signal: unknown) => r({ code, signal }))), new Promise((_, no) => setTimeout(() => no(new Error('the box never exited')), ms).unref())]);
const SECRET = 'grid-proxy-secret-'.padEnd(48, 'x');

test('boxd.ts imports node: built-ins only: it runs as root, so everything it trusts is on its page', () => {
  const file = new URL('../src/boxd.ts', import.meta.url).pathname;
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const specs: string[] = [];
  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) specs.push(n.moduleSpecifier.text);
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) specs.push(n.arguments[0] && ts.isStringLiteral(n.arguments[0]) ? n.arguments[0].text : '<computed>');
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'require') specs.push('<require>');
    ts.forEachChild(n, visit);
  };
  visit(sf);
  assert.ok(specs.length > 0, 'it imports something');
  assert.deepEqual(specs.filter((s) => !s.startsWith('node:')), [], 'only node: modules');
});

test('boxd checks what a run asks for; image, network, mounts and uid stay its own', { skip, timeout: 30_000 }, () => {
  assert.throws(() => checkRun({ id: '../etc', port: 47000 }), /user id/);
  assert.throws(() => checkRun({ id: 'u1', port: 80 }), /port/);
  assert.throws(() => checkRun({ id: 'u1', port: 47000, env: { 'A B': 'x' } }), /variable name/);
  assert.throws(() => checkRun({ id: 'u1', port: 47000, env: { A: 'x\nLD_PRELOAD=/tmp/x.so' } }), /line break/);
  assert.throws(() => checkRun({ id: 'u1', port: 47000, limits: { memory: 'lots' } }), /size like 1536m/);
  assert.throws(() => checkRun({ id: 'u1', port: 47000, limits: { pids: 1 } }), /pids/);
  assert.throws(() => checkRun({ id: 'u1', port: 47000, dns: ['evil.example'] }), /dns/);
  const r = checkRun({ id: 'u1', port: 47000, env: { S: 'x' }, image: 'alpine', network: 'host', runtime: 'runc', home: '/', uid: 0 });
  assert.deepEqual(Object.keys(r).sort(), ['dns', 'env', 'id', 'limits', 'port', 'sandbox'], 'nothing else is taken from the request');
  assert.equal(r.sandbox, false);
  assert.equal(checkRun({ id: 'u1', port: 47000, sandbox: 'yes' }).sandbox, false, 'only true asks for a sandbox');
  assert.equal(checkRun({ id: 'u1', port: 47000, sandbox: true }).sandbox, false, 'a user’s own box is never a sandbox');
  assert.equal(checkRun({ id: 'u1-sb-0a1b2c3d', port: 47000, sandbox: true }).sandbox, true);
  assert.deepEqual(r.limits, { memory: '1536m', memorySwap: '3g', cpus: 1.5, pids: 512 });

  const dir = tmp('envfile');
  const f = path.join(dir, 'env');
  writeEnvFile(f, { WISP_TRUSTED_PROXY_SECRET: SECRET, A: 'b=c' });
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(f, 'utf8'), `WISP_TRUSTED_PROXY_SECRET=${SECRET}\nA=b=c\n`);
  const s = containerRun({ ...CONTAINER, envFile: f, name: 'wisp-u-1', port: 47001, home: '/h' }).args.join(' ');
  assert.doesNotMatch(s, /SECRET/);
  // A cloud computer's box: no capabilities, no setuid. A sandbox under gVisor: Docker's defaults
  // (sudo works inside, against gVisor's kernel). A sandbox under runc stays locked down.
  assert.match(s, /--cap-drop ALL --security-opt no-new-privileges/);
  assert.match(s, / wisp-grid-user node \/opt\/wisp\/bin\/wisp\.js --no-open --port 47001$/, 'the bundled wisp of apps/server');
  const sb = containerRun({ ...CONTAINER, runtime: 'runsc', sandbox: true, name: 'wisp-u-1-sb-x', port: 47001, home: '/h' }).args.join(' ');
  assert.doesNotMatch(sb, /cap-drop ALL|no-new-privileges/);
  assert.match(sb, /--cap-drop NET_RAW --cap-drop MKNOD --cap-drop AUDIT_WRITE/);
  assert.match(sb, /--runtime runsc/);
  assert.match(sb, /--shm-size 512m/);
  assert.match(sb, /--user 0 wisp-grid-user \/usr\/local\/sbin\/wisp-sandbox-init node /, 'root only to start its root helper, then wisp as uid 1000');
  const runc = containerRun({ ...CONTAINER, runtime: '', sandbox: true, name: 'wisp-u-1-sb-x', port: 47001, home: '/h' }).args.join(' ');
  assert.match(runc, /--cap-drop ALL --security-opt no-new-privileges/);
});

test('boxd runs a box: its own settings, the home in its folder, secrets in a 0600 file; SIGTERM stops it', { skip, timeout: 30_000 }, async () => {
  const root = tmp('boxd');
  const socket = path.join(root, 'box.sock');
  const boxes = path.join(root, 'boxes');
  const b = await serveBoxd({ socket, boxes, data: path.join(root, 'data'), group: null, log: () => {} });
  try {
    assert.equal(fs.statSync(socket).mode & 0o777, 0o660, 'only root and the grid’s group');
    const ping = await boxdCall(socket, { op: 'ping' });
    assert.equal(ping['boxes'], boxes);
    const p = await freePort();
    const logFile = path.join(root, 'u1.log');
    // A request can't pick the network or the image: boxd's own are used.
    const child = boxdRun(socket, { id: 'u1', port: p, env: { WISP_TRUSTED_PROXY_SECRET: SECRET }, network: 'host', image: 'alpine' }, logFile);
    await until(() => health(p), { what: 'the box', every: 150 });
    const [run] = runsOf('wisp-u-u1');
    assert.ok(run);
    assert.equal(run.home, path.join(boxes, 'u1', 'home'));
    assert.equal(run.network, CONTAINER.network);
    assert.equal(run.runtime, CONTAINER.runtime);
    assert.ok(run.args.includes(CONTAINER.image) && !run.args.includes('alpine'));
    assert.equal(run.envFileMode, 0o600);
    assert.ok(run.envKeys?.includes('WISP_TRUSTED_PROXY_SECRET'));
    assert.ok(!run.args.join(' ').includes(SECRET), 'never on the command line');
    assert.ok(fs.existsSync(path.join(boxes, 'u1', 'home', '.wisp')), 'the box’s wisp lives in that home');
    assert.equal(fs.statSync(path.join(boxes, 'u1')).mode & 0o777, 0o700);
    assert.equal((await boxdCall(socket, { op: 'ping' }))['running'], 1);
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
  const gone = boxdRun(socket, { id: 'u1', port: await freePort() }, path.join(root, 'x.log'));
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
    const refused = boxdRun(socket, { id: 'u2', port: await freePort() }, path.join(root, 'u2.log'));
    await exitOf(refused, 3000);
    assert.match(refused.error, /still at .*boxd\.ts migrate/);
    assert.ok(!fs.existsSync(path.join(boxes, 'u2', 'home')), 'no empty home in its place');

    const r = migrate({ data, boxes, log: () => {} });
    assert.deepEqual(r, { moved: ['u2'], skipped: ['u3'] });
    assert.equal(fs.readFileSync(path.join(boxes, 'u2', 'home', '.claude', '.credentials.json'), 'utf8'), '{"token":"t"}');
    assert.ok(!fs.existsSync(path.join(data, 'users', 'u2', 'home')));
    assert.ok(!fs.existsSync(path.join(boxes, 'u3')), 'a link is never followed');

    const p = await freePort();
    const child = boxdRun(socket, { id: 'u2', port: p }, path.join(root, 'u2.log'));
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

interface Grid {
  accounts: { byHandle(h: string): { id: string; handle: string; disabled: number } | undefined };
  hostd: { state(id: string): string; ensure(u: { id: string; handle: string }): Promise<unknown> };
  secrets: { ensure(id: string, purpose: string): string };
  close(): Promise<void>;
}
type StartGrid = (cfg: ReturnType<typeof loadConfig>, o: { log: (m: string) => void }) => Promise<Grid>;

async function gridWith(container: Record<string, unknown>, dataDir = tmp('grid-c')): Promise<{ cfg: ReturnType<typeof loadConfig>; grid: Grid }> {
  const { startGrid } = (await import(GRID.href)) as { startGrid: StartGrid };
  ensureMaster(dataDir);
  // Room by memory has its own tests (hostd.test.ts): here the test machine's memory mustn't matter.
  const hostd = { driver: 'container', container, idleMs: 60_000, checkMs: 500, admit: false };
  // The CLI reads grid.json; the running grid gets the same.
  fs.writeFileSync(path.join(dataDir, 'grid.json'), JSON.stringify({ hostd }));
  const cfg = loadConfig({ dataDir, env: {}, overrides: { domain: 'wisp.localhost', listen: { host: '127.0.0.1', port: await freePort() }, auth: { dev: true } } });
  return { cfg, grid: await startGrid(cfg, { log: () => {} }) };
}

const csrfOf = (html: string): string => {
  const m = /name="csrf" value="([^"]+)"/.exec(html);
  assert.ok(m?.[1], 'a csrf field on the page');
  return m[1];
};

async function signIn(g: { cfg: ReturnType<typeof loadConfig> }, email: string) {
  const b = browser();
  const base = g.cfg.publicUrl;
  const start = await b.go(`${base}/auth/dev/start`);
  await b.go(`${base}/auth/dev/callback`, { method: 'POST', form: { csrf: csrfOf(start.text), email, name: email.split('@')[0] ?? email, return: '/' }, headers: { origin: base } });
  return b;
}

async function signInAndOpen(g: { cfg: ReturnType<typeof loadConfig>; grid: Grid }, email: string) {
  const b = await signIn(g, email);
  const r = await b.follow(`${g.cfg.publicUrl}/go`);
  const origin = new URL(r.at).origin;
  await until(async () => (await b.go(`${origin}/api/health`, { headers: { accept: 'application/json' } })).status === 200, { what: `${email}’s box`, every: 200 });
  const user = g.grid.accounts.byHandle(email.split('@')[0] ?? '');
  assert.ok(user);
  return { b, origin, user };
}

async function deleteOnPage(g: { cfg: ReturnType<typeof loadConfig> }, b: ReturnType<typeof browser>, handle: string) {
  const base = g.cfg.publicUrl;
  const csrf = csrfOf((await b.go(`${base}/`)).text);
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
    assert.ok(!runsOf(`wisp-u-${user.id}`)[0]?.args.join(' ').includes(g.grid.secrets.ensure(user.id, 'wisp-proxy')));

    const done = await deleteOnPage(g, gus, 'gus');
    assert.equal(done.status, 200, done.text);
    assert.equal(g.grid.hostd.state(user.id), 'stopped');
    assert.ok(!fs.existsSync(path.join(boxes, user.id)), 'boxd deleted the home');
    assert.ok(!fs.existsSync(path.join(dataDir, 'users', user.id)));
    assert.ok(!g.grid.accounts.byHandle('gus'));

    // From the command line, with the box running: boxd stops it, and the grid takes it in its stride.
    const { user: hal } = await signInAndOpen(g, 'hal@example.com');
    const { gridCli } = await import('../src/cli.ts');
    await gridCli(['users', '--delete', 'hal', '--yes', '--data', dataDir], { out: () => {} });
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
    assert.ok(run);
    assert.equal(run.envFileMode, 0o600);
    assert.ok(run.envKeys?.includes('WISP_TRUSTED_PROXY_SECRET'));
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
    const b = await signIn(g, 'joan@example.com');
    const jo = g.grid.accounts.byHandle('joan');
    assert.ok(jo);
    await assert.rejects(g.grid.hostd.ensure(jo), /boxd didn’t answer at .*is wisp-grid-boxd running/);
    const r = await deleteOnPage(g, b, 'joan');
    assert.equal(r.status, 409);
    assert.match(r.text, /couldn’t be deleted just now, so your account is still here/);
    assert.equal(g.grid.accounts.byHandle('joan')?.disabled, 0);
    assert.match((await b.go(`${g.cfg.publicUrl}/account`)).text, /action="\/account\/delete"/, 'still signed in');
  } finally {
    await g.grid.close();
  }
});

before(() => {
  assert.equal(BOXD.socket, '/run/wisp-grid/box.sock');
});
after(() => {
  // Any box a failed test left behind.
  const state = path.join(dockerDir, 'state');
  for (const f of fs.existsSync(state) ? fs.readdirSync(state) : []) {
    try {
      process.kill(Number(fs.readFileSync(path.join(state, f), 'utf8')), 'SIGKILL');
    } catch {
      // gone
    }
  }
});
