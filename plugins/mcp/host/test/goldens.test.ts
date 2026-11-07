// Every tool list wisp offers, against v1's own tools/list output (test/goldens, recorded by running
// v1's server/mcp-ask.js under each env combination and server/mcp-wisp.js's serveMcp). Names,
// descriptions, schemas, order and readOnlyHint: a live prompt depends on each of them (plan §6.9).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { McpSessionInfo } from '@wisp-plugin/mcp-api';
import { toolsFor, whoOf } from '../src/offer.ts';
import { handleRpc } from '../src/rpc.ts';
import { Changes } from '../src/waits.ts';

const golden = (name: string): unknown => JSON.parse(readFileSync(new URL(`./goldens/${name}.json`, import.meta.url), 'utf8'));
const TEAM = [
  { name: 'reviewer', agent: 'codex', model: 'gpt-5', effort: 'high', use: 'code review', count: 1 },
  { name: 'x', agent: 'claude', count: 2, copies: ['x#1', 'x#2'], place: 'devbox' },
];
const COMBOS: [string, McpSessionInfo][] = [
  ['ask-default', {}],
  ['ask-readonly', { readOnly: true }],
  ['ask-capped', { capped: true }],
  ['ask-spells', { spells: true }],
  ['ask-approve-watch', { approve: true, watch: true }],
  ['ask-readonly-approve-watch', { readOnly: true, approve: true, watch: true }],
  ['ask-capped-approve-watch-spells', { capped: true, approve: true, watch: true, spells: true }],
  ['ask-team', { team: TEAM }],
];
const agent = (info: McpSessionInfo, set = 'agent:session:s') => whoOf({ set, session: 's' }, info);
const plain = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

for (const [name, info] of COMBOS) {
  test(`an agent's tools/list equals v1's: ${name}`, () => {
    assert.deepEqual(plain(toolsFor(agent(info))), golden(`tools-${name}`));
  });
}

test('a caller speaking for agent:capped gets the capped list whatever its flags say', () => {
  assert.deepEqual(plain(toolsFor(agent({}, 'agent:capped'))), golden('tools-ask-capped'));
  assert.deepEqual(plain(toolsFor(agent({}, 'agent:capped:plan'))), golden('tools-ask-capped'));
});

test("the user's editors get wisp mcp's list, the crew kit left out", () => {
  const tools = plain(toolsFor(whoOf({ set: 'user:full' }, {})));
  assert.deepEqual(tools, golden('tools-user'));
  assert.deepEqual((tools as { name: string }[]).map((t) => t.name), ['wisp_launch', 'wisp_list', 'wisp_get', 'wisp_wait', 'wisp_reply', 'wisp_stop', 'wisp_agents', 'wisp_crew', 'wisp_crew_add', 'wisp_crew_edit', 'wisp_crew_remove']);
});

test('how many tools there are: 29 for agents, 11 for the user, 35 names in all', () => {
  const all = toolsFor(agent({ approve: true, watch: true, spells: true }));
  const user = toolsFor(whoOf({ set: 'user:full' }, {}));
  assert.equal(all.length, 29);
  assert.equal(user.length, 11);
  assert.equal(new Set([...all, ...user].map((t) => t.name)).size, 35);
});

test('initialize answers as v1 did, for each audience', async () => {
  const ac = new AbortController();
  const changes = new Changes({ timeout: () => () => {} }, ac.signal);
  const user = await handleRpc({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, { who: whoOf({ set: 'user:full' }, {}), extra: [], version: '9.9.9', user: { run: async () => Promise.reject(new Error('x')), changes, now: Date.now, cwd: '/' } });
  const want = golden('initialize-user') as { serverInfo: { version: string } };
  assert.deepEqual(plain(user), { jsonrpc: '2.0', id: 2, result: { ...want, serverInfo: { ...want.serverInfo, version: '9.9.9' } } });
  const a = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { who: agent({}), extra: [], version: '9.9.9' });
  assert.deepEqual(a, { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'wisp', version: '0.1.0' } } });
});

test('ping, a notification and an unknown method answer as v1 did', async () => {
  const c = { who: agent({}), extra: [], version: '2' };
  assert.deepEqual(await handleRpc({ jsonrpc: '2.0', id: 7, method: 'ping' }, c), { jsonrpc: '2.0', id: 7, result: {} });
  assert.equal(await handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, c), null);
  assert.equal(await handleRpc('not a message', c), null);
  assert.deepEqual(await handleRpc({ jsonrpc: '2.0', id: 8, method: 'resources/list' }, c), { jsonrpc: '2.0', id: 8, error: { code: -32601, message: 'Method not found: resources/list' } });
});
