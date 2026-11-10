// Linear and Jira by signing in (New task → Issue → Connect Linear… / Connect Jira…): Settings →
// Connectors offers both as examples pointing at their own MCP servers, and once one is signed in the
// issue picker lists what's assigned to you through that server's tools (no API key to make).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmp } from './helpers.js';

process.env.WISP_HOME = tmp('isi-home');
process.env.WISP_UPDATE_CHECK = '0';

const { EXAMPLES, exampleFor } = await import('../web/js/connector-examples.js');
const { normalizeConnector, storeSecrets, mcpCall } = await import('../server/connectors.js');
const { listIssues, clearIssues } = await import('../server/issues.js');
const { Secrets } = await import('../server/secrets.js');

test('Linear and Jira are among the examples, as remote servers that sign in, and each example is a valid connector', () => {
  const linear = exampleFor('linear');
  const jira = exampleFor('jira');
  assert.equal(linear.transport, 'remote');
  assert.equal(new URL(linear.url).host, 'mcp.linear.app');
  assert.equal(linear.signIn, true);
  assert.equal(jira.transport, 'remote');
  assert.equal(new URL(jira.url).host, 'mcp.atlassian.com');
  assert.equal(jira.signIn, true);
  for (const x of EXAMPLES) assert.doesNotThrow(() => normalizeConnector({ name: x.name, transport: x.transport, url: x.url, command: x.command }, []), x.label);
  assert.equal(exampleFor('nope'), null);
});

// A connector signed in with OAuth, as the sign-in leaves it.
const signedIn = (name, url) => {
  const secrets = { get: (_ns, k) => (k === 'oauth:access' ? 'tok' : '') };
  return { secrets, connectors: [{ id: `c-${name}`, name, transport: 'remote', url, enabled: true, oauth: { clientId: 'x', signedInAt: 1 } }] };
};
const text = (v) => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });

test('linear: a signed-in Linear connector lists your open issues through its list_issues tool', async () => {
  clearIssues();
  const { secrets, connectors } = signedIn('linear', 'https://mcp.linear.app/mcp');
  const calls = [];
  const mcp = async (c, fn) => fn(async (name, args) => {
    calls.push({ id: c.id, name, args });
    return text({ issues: [
      { id: 'u1', identifier: 'ENG-7', title: 'Dark mode flickers', url: 'https://linear.app/acme/issue/ENG-7', labels: ['bug'], assignee: 'Me', status: 'In Progress', updatedAt: '2026-11-02', description: 'On reload.' },
      { id: 'u2', identifier: 'ENG-3', title: 'Old one', url: 'https://linear.app/acme/issue/ENG-3', status: 'Done', updatedAt: '2026-10-01' },
    ] });
  });
  const r = await listIssues({ source: 'linear', q: 'dark', connectors, secrets, mcp });
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.linear, true);
  assert.deepEqual(calls.map(({ id, name, args }) => ({ id, name, assignee: args.assignee, query: args.query })), [{ id: 'c-linear', name: 'list_issues', assignee: 'me', query: 'dark' }]);
  assert.equal(r.scope, 'mine');
  assert.deepEqual(r.issues, [{ id: 'u1', ref: 'ENG-7', number: 'ENG-7', title: 'Dark mode flickers', url: 'https://linear.app/acme/issue/ENG-7', labels: ['bug'], assignee: 'Me', body: 'On reload.', updatedAt: '2026-11-02' }]);
  // Its GitHub answer says Linear is there, for the picker's other sources.
  assert.equal((await listIssues({ source: 'jira', connectors, secrets, mcp })).linear, true);
});

test('linear: none assigned to you, the picker shows the workspace’s open issues instead (Linear’s real shape)', async () => {
  clearIssues();
  const { secrets, connectors } = signedIn('linear', 'https://mcp.linear.app/mcp');
  const calls = [];
  // As mcp.linear.app answers: id is the key, statusType says whether it's closed, assignee may be null.
  const mcp = async (c, fn) => fn(async (name, args) => {
    calls.push(args);
    if (args.assignee === 'me') return text({ issues: [], hasNextPage: false });
    return text({ issues: [
      { id: 'TRY-16', title: 'Task usage of tokens', url: 'https://linear.app/t/issue/TRY-16', labels: [], assignee: null, status: 'Todo', statusType: 'unstarted', updatedAt: '2026-11-10T00:53:36Z', description: '* include subagents' },
      { id: 'TRY-2', title: 'Shipped', url: 'https://linear.app/t/issue/TRY-2', labels: [], assignee: null, status: 'Shipped', statusType: 'completed', updatedAt: '2026-11-01' },
      { id: 'TRY-3', title: 'Dropped', url: 'https://linear.app/t/issue/TRY-3', labels: [], assignee: null, status: 'Nope', statusType: 'canceled', updatedAt: '2026-11-01' },
    ], hasNextPage: false });
  });
  const r = await listIssues({ source: 'linear', connectors, secrets, mcp });
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.scope, 'all');
  assert.deepEqual(calls.map((x) => x.assignee), ['me', undefined]);
  assert.ok(calls.every((x) => x.fields.includes('statusType') && x.fields.includes('description')), 'asks for the fields it reads');
  assert.deepEqual(r.issues, [{ id: 'TRY-16', ref: 'TRY-16', number: 'TRY-16', title: 'Task usage of tokens', url: 'https://linear.app/t/issue/TRY-16', labels: [], assignee: '', body: '* include subagents', updatedAt: '2026-11-10T00:53:36Z' }]);
});

test('linear: not signed in yet, the picker says to sign in, and a refusal from the server says the same', async () => {
  clearIssues();
  const none = await listIssues({ source: 'linear', connectors: [{ id: 'c', name: 'linear', transport: 'remote', url: 'https://mcp.linear.app/mcp' }], secrets: { get: () => '' } });
  assert.equal(none.fix, 'linear');
  assert.match(none.error, /[Ss]ign in/);
  const { secrets, connectors } = signedIn('linear', 'https://mcp.linear.app/mcp');
  const refused = await listIssues({ source: 'linear', connectors, secrets, mcp: async () => { throw new Error('linear: needs sign-in (HTTP 401). Sign in again in Settings → Connectors'); } });
  assert.equal(refused.fix, 'linear');
  assert.match(refused.error, /[Ss]ign in/);
});

test('jira: a signed-in Atlassian connector finds your site, then searches the issues assigned to you', async () => {
  clearIssues();
  const { secrets, connectors } = signedIn('atlassian', 'https://mcp.atlassian.com/v1/mcp');
  const calls = [];
  const mcp = async (c, fn) => fn(async (name, args) => {
    calls.push({ name, args });
    if (name === 'getAccessibleAtlassianResources') return text([{ id: 'cloud-1', url: 'https://acme.atlassian.net', name: 'acme', scopes: ['read:jira-work'] }]);
    return text({ issues: [{ key: 'ACME-4', fields: { summary: 'Login loops', labels: [], assignee: { displayName: 'Me' }, updated: '2026-11-03', description: 'Plain text here' } }] });
  });
  const r = await listIssues({ source: 'jira', q: 'login', connectors, secrets, mcp });
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.jira, true);
  assert.deepEqual(calls.map((x) => x.name), ['getAccessibleAtlassianResources', 'searchJiraIssuesUsingJql']);
  assert.equal(calls[1].args.cloudId, 'cloud-1');
  assert.match(calls[1].args.jql, /^assignee = currentUser\(\) AND statusCategory != Done AND text ~ "login"/);
  assert.deepEqual(r.issues, [{ id: 'jira:ACME-4', ref: 'ACME-4', number: 'ACME-4', title: 'Login loops', url: 'https://acme.atlassian.net/browse/ACME-4', labels: [], assignee: 'Me', body: 'Plain text here', updatedAt: '2026-11-03' }]);
});

test('mcpCall: starts a connector through the proxy and calls its tools in turn', async () => {
  const home = tmp('isi-call');
  const srv = path.join(tmp('isi-srv'), 'server.mjs');
  fs.writeFileSync(
    srv,
    `import rl from 'node:readline';
rl.createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  const reply = (result) => console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
  if (m.method === 'initialize') reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } });
  if (m.method === 'tools/call' && m.params.name === 'boom') console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -1, message: 'no such tool' } }));
  else if (m.method === 'tools/call') reply({ content: [{ type: 'text', text: m.params.name + ':' + JSON.stringify(m.params.arguments) }] });
});
`,
  );
  const secrets = new Secrets(home);
  const { connector, sets } = normalizeConnector({ name: 'fake', command: process.execPath, args: [srv] }, []);
  storeSecrets(secrets, connector, sets);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ connectors: [connector] }));
  const got = await mcpCall(connector, home, null, async (call) => [await call('a', { x: 1 }), await call('b', {})]);
  assert.deepEqual(got.map((r) => r.content[0].text), ['a:{"x":1}', 'b:{}']);
  await assert.rejects(mcpCall(connector, home, null, (call) => call('boom', {})), /no such tool/);
});
