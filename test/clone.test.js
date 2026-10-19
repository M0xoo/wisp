// Adding a project from a repo URL: wisp clones it into the clone folder, then adds the clone.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installFakeBins, makeClone, same, tmp } from './helpers.js';

process.env.WISP_HOME = tmp('clone-home');
process.env.WISP_UPDATE_CHECK = '0';
installFakeBins();
const { startServer } = await import('../server/index.js');
const { parseRepo } = await import('../server/git.js');

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

let srv;
let base;
const cloneDir = tmp('clones');
before(async () => {
  const port = await freePort();
  srv = await startServer({ port, handleSignals: false });
  base = `http://127.0.0.1:${port}`;
  await call('PATCH', '/config', { defaults: { cloneDir } });
});
after(() => {
  srv.shutdown();
  srv.server.close();
});

async function call(method, p, body) {
  const r = await fetch(`${base}/api${p}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

test('parseRepo reads GitHub URLs, ssh and scp forms, and leaves paths alone', () => {
  const gh = (s, o) => parseRepo(s, o)?.gh;
  assert.equal(gh('https://github.com/M0xoo/wisp'), 'M0xoo/wisp');
  assert.equal(gh('https://github.com/M0xoo/wisp.git'), 'M0xoo/wisp');
  assert.equal(gh('https://github.com/M0xoo/wisp/tree/main/server'), 'M0xoo/wisp');
  assert.equal(gh('github.com/M0xoo/wisp/'), 'M0xoo/wisp');
  assert.equal(gh('git@github.com:M0xoo/wisp.git'), 'M0xoo/wisp');
  assert.equal(gh('M0xoo/wisp', { shorthand: true }), 'M0xoo/wisp');
  assert.equal(parseRepo('https://github.com/M0xoo/wisp/pull/3').url, 'https://github.com/M0xoo/wisp.git');
  assert.deepEqual(
    (({ host, name, gh }) => ({ host, name, gh }))(parseRepo('https://gitlab.com/group/sub/app.git')),
    { host: 'gitlab.com', name: 'app', gh: null },
  );
  assert.equal(parseRepo('ssh://git@example.org:2222/team/tool.git').name, 'tool');
  for (const p of ['~/code/app', '/Users/me/app', './app', 'app', 'M0xoo/wisp', 'https://github.com/M0xoo', 'C:\\code\\app']) assert.equal(parseRepo(p), null, p);
});

test('POST /projects with a repo URL clones it into the clone folder and adds the clone', async () => {
  const { remote } = makeClone();
  const url = pathToFileURL(remote).href;
  const r = await call('POST', '/projects', { path: url });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(same(path.dirname(r.body.path), cloneDir));
  assert.equal(r.body.name, path.basename(remote));
  assert.deepEqual(r.body.cloned, { url, existed: false });
  assert.ok(fs.existsSync(path.join(r.body.path, 'math.js')), 'the clone has the files');
  assert.equal((await call('GET', '/config')).body.cloneDir, cloneDir);

  // The same repo again (spelled with `repo`) reuses the clone instead of making a second one.
  const again = await call('POST', '/projects', { repo: url });
  assert.equal(again.status, 201);
  assert.equal(again.body.id, r.body.id);
  assert.equal(again.body.cloned.existed, true);
  assert.equal(fs.readdirSync(cloneDir).length, 1);
});

test('a folder in the way that is another repo gets a suffixed clone', async () => {
  const { remote } = makeClone();
  fs.mkdirSync(path.join(cloneDir, path.basename(remote)));
  const r = await call('POST', '/projects', { repo: pathToFileURL(remote).href });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(path.basename(r.body.path), `${path.basename(remote)}-2`);
});

test('a repo that cannot be cloned is a 400 with the reason, and leaves nothing behind', async () => {
  const before = fs.readdirSync(cloneDir).length;
  const r = await call('POST', '/projects', { repo: pathToFileURL(path.join(tmp('nothing'), 'missing.git')).href });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Couldn’t clone/);
  assert.equal(fs.readdirSync(cloneDir).length, before);
  assert.equal((await call('POST', '/projects', { repo: '~/code/app' })).status, 400);
});

test('a plain folder path still adds the folder', async () => {
  const dir = tmp('plain');
  const r = await call('POST', '/projects', { path: dir });
  assert.equal(r.status, 201);
  assert.equal(r.body.cloned, undefined);
});
