// Starting a task from an issue (New task → Issue): GET /api/issues through a real wisp server, real
// git and a fake `gh`, and a stand-in for Linear's GraphQL API. The list, search, the minute's cache,
// and each problem in words with its fix.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { installFakeBins, makeRepo, records, tmp } from './helpers.js';

const GH_STATE = path.join(tmp('issues-gh'), 'state.json');
const RECORD = tmp('issues-rec');
process.env.FAKE_GH_STATE = GH_STATE;
process.env.FAKE_RECORD = RECORD;
process.env.WISP_HOME = tmp('issues-home');
process.env.WISP_UPDATE_CHECK = '0';
process.env.WISP_NO_OPEN = '1';
installFakeBins();

// Linear: answers the viewer's assigned issues, and refuses any key but the right one.
const asked = [];
const linear = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    const body = JSON.parse(raw);
    asked.push({ auth: req.headers.authorization, body });
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== 'lin_api_good') return res.writeHead(401).end(JSON.stringify({ errors: [{ message: 'Authentication required', extensions: { code: 'AUTHENTICATION_ERROR' } }] }));
    const nodes = [
      { id: 'u1', identifier: 'ENG-7', title: 'Login loops on Safari', url: 'https://linear.app/acme/issue/ENG-7', description: 'Steps:\n1. Open Safari', updatedAt: '2026-11-01T10:00:00Z', labels: { nodes: [{ name: 'Bug' }] }, assignee: { name: 'ada', displayName: 'Ada' } },
      { id: 'u2', identifier: 'ENG-9', title: 'Dark mode for settings', url: 'https://linear.app/acme/issue/ENG-9', description: null, updatedAt: '2026-10-30T10:00:00Z', labels: { nodes: [] }, assignee: null },
    ];
    const q = body.variables.filter.title?.containsIgnoreCase?.toLowerCase();
    res.end(JSON.stringify({ data: { viewer: { assignedIssues: { nodes: nodes.filter((n) => !q || n.title.toLowerCase().includes(q)) } } } }));
  });
});

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

let srv;
let base;
async function api(p, body, method = body ? 'POST' : 'GET') {
  const r = await fetch(`${base}/api${p}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
}
const setGh = (state) => fs.writeFileSync(GH_STATE, JSON.stringify(state));
const ghCalls = () => records(RECORD, 'gh').filter((r) => r.argv[0] === 'issue');

const ISSUES = [
  { number: 12, title: 'Users get logged out after a refresh', url: 'https://github.com/acme/repo/issues/12', labels: ['bug', 'auth'], assignees: [{ login: 'lena' }], updatedAt: '2026-11-01T09:00:00Z', body: 'It happens on every refresh.\r\n\r\nSee the logs.' },
  { number: 9, title: 'Docs for the API', url: 'https://github.com/acme/repo/issues/9', labels: [], assignees: [], updatedAt: '2026-10-28T09:00:00Z', body: 'x'.repeat(5000) },
];

let project;
let bare;
before(async () => {
  await new Promise((ok) => linear.listen(0, '127.0.0.1', ok));
  process.env.WISP_LINEAR_API = `http://127.0.0.1:${linear.address().port}/graphql`;
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const { startServer } = await import('../server/index.js');
  srv = await startServer({ port, handleSignals: false });
  const dir = makeRepo();
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/repo.git'], { cwd: dir });
  project = (await api('/projects', { path: dir })).body;
  bare = (await api('/projects', { path: makeRepo() })).body; // no remote at all
});
after(() => {
  srv.shutdown();
  srv.server.closeAllConnections?.();
  srv.server.close();
  linear.close();
});

test('a project’s open GitHub issues, from its origin remote', async () => {
  setGh({ issues: ISSUES });
  const { status, body } = await api(`/issues?project=${project.id}`);
  assert.equal(status, 200);
  assert.equal(body.source, 'github');
  assert.equal(body.repo, 'acme/repo');
  assert.equal(body.error, undefined);
  assert.deepEqual(body.issues[0], { id: '12', ref: '#12', number: 12, title: 'Users get logged out after a refresh', url: 'https://github.com/acme/repo/issues/12', labels: ['bug', 'auth'], assignee: 'lena', body: 'It happens on every refresh.\n\nSee the logs.', updatedAt: '2026-11-01T09:00:00Z' });
  assert.equal(body.issues[1].assignee, '');
  assert.equal(body.issues[1].body.length, 4000); // the first 4000 characters
  assert.ok(body.issues[1].body.endsWith('…'));
  const call = ghCalls().at(-1).argv;
  assert.deepEqual(call.slice(0, 6), ['issue', 'list', '--repo', 'acme/repo', '--state', 'open']);
  assert.equal(call[call.indexOf('--json') + 1], 'number,title,labels,assignees,url,updatedAt,body');
  assert.equal(call[call.indexOf('--limit') + 1], '50');
});

test('a search goes to gh, and a list is kept for a minute', async () => {
  setGh({ issues: ISSUES });
  const n = ghCalls().length;
  const { body } = await api(`/issues?project=${project.id}&q=docs`);
  assert.deepEqual(body.issues.map((i) => i.ref), ['#9']);
  assert.equal(ghCalls().at(-1).argv.at(-1), 'docs');
  // The same project and words again: no second call, even with gh's answer changed.
  setGh({ issues: [] });
  assert.deepEqual((await api(`/issues?project=${project.id}&q=docs`)).body.issues.map((i) => i.ref), ['#9']);
  assert.equal(ghCalls().length, n + 1);
});

test('each problem says what fixes it, and isn’t kept', async () => {
  setGh({ signedOut: true });
  let { status, body } = await api(`/issues?project=${project.id}&q=signed-out`);
  assert.equal(status, 200);
  assert.deepEqual(body.issues, []);
  assert.equal(body.fix, 'signin');
  assert.match(body.error, /Sign in to GitHub/);
  // Signed in now: the next look asks again.
  setGh({ issues: ISSUES });
  assert.equal((await api(`/issues?project=${project.id}&q=signed-out`)).body.error, undefined);

  ({ body } = await api(`/issues?project=${bare.id}`));
  assert.equal(body.fix, 'remote');
  assert.match(body.error, /has no GitHub remote/);

  ({ body } = await api('/issues'));
  assert.equal(body.fix, 'project');

  setGh({ issues: 'not json' });
  ({ body } = await api(`/issues?project=${project.id}&q=broken`));
  assert.match(body.error, /isn’t a list of issues/);

  assert.equal((await api('/issues?project=nope')).status, 404);
  assert.equal((await api(`/issues?project=${project.id}&source=gitlab`)).status, 400);
});

test('gh missing says to install it', async () => {
  const was = process.env.WISP_GH_BIN;
  process.env.WISP_GH_BIN = path.join(tmp('no-gh'), 'gh-missing');
  try {
    const { body } = await api(`/issues?project=${project.id}&q=missing`);
    assert.equal(body.fix, 'install');
    assert.match(body.error, /isn’t installed/);
  } finally {
    if (was === undefined) delete process.env.WISP_GH_BIN;
    else process.env.WISP_GH_BIN = was;
  }
});

test('Linear: without a connector it says to connect one; with its API key, your open issues', async () => {
  let { body } = await api('/issues?source=linear');
  assert.equal(body.linear, false);
  assert.equal(body.fix, 'linear');
  assert.match(body.error, /Connect Linear/);
  assert.equal((await api(`/issues?project=${project.id}`)).body.linear, false);

  // Named linear; its command runs nothing (adding one tests it: no npx download here).
  const c = (await api('/connectors', { name: 'linear', command: process.execPath, args: ['-e', '0'], env: { LINEAR_API_KEY: 'lin_api_bad' } })).body;
  ({ body } = await api('/issues?source=linear'));
  assert.equal(body.fix, 'linear');
  assert.match(body.error, /refused the connector’s API key/);

  const id = c.connectors.find((x) => x.name === 'linear').id;
  await api(`/connectors/${id}`, { env: { LINEAR_API_KEY: 'lin_api_good' } }, 'PATCH');
  ({ body } = await api('/issues?source=linear'));
  assert.equal(body.error, undefined);
  assert.equal(body.linear, true);
  assert.deepEqual(body.issues[0], { id: 'ENG-7', ref: 'ENG-7', number: 'ENG-7', title: 'Login loops on Safari', url: 'https://linear.app/acme/issue/ENG-7', labels: ['Bug'], assignee: 'Ada', body: 'Steps:\n1. Open Safari', updatedAt: '2026-11-01T10:00:00Z' });
  assert.equal(body.issues[1].body, '');
  // Open ones only, and a search by title.
  assert.deepEqual(asked.at(-1).body.variables.filter, { state: { type: { nin: ['completed', 'canceled'] } } });
  ({ body } = await api('/issues?source=linear&q=dark'));
  assert.deepEqual(body.issues.map((i) => i.ref), ['ENG-9']);
  // GitHub's answer says Linear is there too, for the picker's switch.
  assert.equal((await api(`/issues?project=${project.id}`)).body.linear, true);
});

test('jira: a Jira connector’s site, email and token; the issues assigned to you, flattened', async () => {
  const { jiraCreds, jiraIssues } = await import('../server/issues.js');
  const secrets = { get: (ns, k) => ({ 'env:JIRA_URL': 'acme.atlassian.net/', 'env:JIRA_EMAIL': 'me@acme.dev', 'env:JIRA_API_TOKEN': 'tok' })[k] };
  assert.equal(jiraCreds([{ id: 'c1', name: 'GitHub', env: ['GITHUB_TOKEN'] }], secrets), null);
  const creds = jiraCreds([{ id: 'c2', name: 'Jira', command: 'npx', args: ['mcp-atlassian'], env: ['JIRA_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'] }], secrets);
  assert.deepEqual(creds, { site: 'https://acme.atlassian.net', email: 'me@acme.dev', token: 'tok' });
  let asked;
  const fetch = async (url, opts) => {
    asked = { url, auth: opts.headers.authorization };
    return { ok: true, status: 200, json: async () => ({ issues: [{ key: 'ACME-12', fields: { summary: 'Login loops', labels: ['bug'], assignee: { displayName: 'Me' }, updated: '2026-11-01', description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Users get ' }, { type: 'text', text: 'logged out' }] }] } } }] }) };
  };
  const r = await jiraIssues(creds, 'login "x"', { fetch });
  assert.match(asked.url, /\/rest\/api\/3\/search\/jql\?/);
  assert.equal(new URL(asked.url).searchParams.get('jql'), 'assignee = currentUser() AND statusCategory != Done AND text ~ "login  x " ORDER BY updated DESC');
  assert.equal(asked.auth, `Basic ${Buffer.from('me@acme.dev:tok').toString('base64')}`);
  assert.deepEqual(r.issues[0], { id: 'jira:ACME-12', ref: 'ACME-12', number: 'ACME-12', title: 'Login loops', url: 'https://acme.atlassian.net/browse/ACME-12', labels: ['bug'], assignee: 'Me', body: 'Users get logged out', updatedAt: '2026-11-01' });
  const refused = await jiraIssues(creds, '', { fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
  assert.equal(refused.fix, 'jira');
});
