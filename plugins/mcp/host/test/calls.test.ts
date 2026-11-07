// An agent's tools/call answers against v1's, case by case. goldens/calls-agent.json was recorded by
// running v1's server/mcp-ask.js against canned /api/internal replies; here each canned reply becomes
// the owner's command answer, and the tool must say exactly what v1 said, and ask the owner for what
// v1 asked its route for.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { McpSessionInfo } from '@wisp-plugin/mcp-api';
import { whoOf } from '../src/offer.ts';
import { handleRpc } from '../src/rpc.ts';
import { Changes } from '../src/waits.ts';
import { makeScope } from './fake.ts';

interface Case {
  case: string;
  env?: Record<string, string>;
  call: [string, Record<string, unknown>];
  routes: Record<string, Record<string, unknown>>;
  sent: { key: string; body?: Record<string, unknown>; query: string }[];
  reply: unknown;
}
const CASES: Case[] = JSON.parse(readFileSync(new URL('./goldens/calls-agent.json', import.meta.url), 'utf8'));

// v1's route → v2's command, and how v2's args name what v1 put in its path and query.
function commandFor(key: string): string | undefined {
  const [method, path = ''] = key.split(' ');
  const p = path.replace(/^\/api\/internal\//, '');
  if (p === 'ask') return 'runtime.ask';
  if (p.startsWith('ask/')) return 'runtime.pollAnswer';
  if (p === 'approve') return 'runtime.approval';
  if (p === 'connectors/s') return method === 'GET' ? 'connectors.list' : 'connectors.add';
  if (p === 'connectors/s/signin') return 'connectors.signin';
  if (p === 'delegate/s') return method === 'POST' ? 'runtime.delegate' : 'runtime.results';
  if (p === 'launch/s') return 'runtime.agent.launch';
  if (p === 'task/s') return method === 'GET' ? 'runtime.agent.taskState' : 'runtime.agent.task';
  if (p === 'tags') return 'runtime.agent.tag';
  if (p === 'session/s') return 'runtime.agent.session';
  if (p === 'crew/s') return method === 'GET' ? 'crew.agent.list' : method === 'PATCH' ? 'crew.agent.edit' : 'crew.agent.add';
  return undefined;
}

function handlers(c: Case): Map<string, (args: Record<string, unknown>) => unknown> {
  const out = new Map<string, (args: Record<string, unknown>) => unknown>();
  for (const [key, body] of Object.entries(c.routes)) {
    const cmd = commandFor(key);
    if (!cmd) throw new Error(`no command for ${key}`);
    if (cmd === 'runtime.ask') out.set(cmd, () => ({ askId: body['id'] }));
    else if (cmd === 'runtime.pollAnswer') out.set(cmd, () => body);
    else out.set(cmd, () => body);
  }
  return out;
}

const infoOf = (env: Record<string, string> = {}): McpSessionInfo => ({
  ...(env['WISP_APPROVE'] && { approve: true }),
  ...(env['WISP_CAPPED'] && { capped: true }),
  ...(env['WISP_READONLY'] && { readOnly: true }),
  turnId: 'turn1',
});

for (const c of CASES) {
  test(`tools/call as v1 answered it: ${c.case}`, async () => {
    const scope = makeScope();
    const hs = handlers(c);
    const ran: { cmd: string; args: Record<string, unknown> }[] = [];
    const run = async <R,>(cmd: string, args: unknown): Promise<R> => {
      ran.push({ cmd, args: args as Record<string, unknown> });
      const h = hs.get(cmd);
      if (!h) throw new Error(`unexpected ${cmd}`);
      return h(args as Record<string, unknown>) as R;
    };
    const info = infoOf(c.env);
    const who = whoOf({ set: 'agent:session:s', session: 's' }, info);
    const changes = new Changes({ timeout: (ms, fn) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); } }, scope.signal);
    const out = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: c.call[0], arguments: c.call[1] } }, { who, extra: [], version: '2', agent: { session: 's', info: who.info, run, changes, now: Date.now, chain: new Map() } });
    scope.dispose();
    const { jsonrpc: _j, id: _i, ...reply } = out as unknown as Record<string, unknown>;
    assert.deepEqual(reply, c.reply);
    // The same owners asked, in the same order, for the same things.
    assert.deepEqual(ran.map((r) => r.cmd), c.sent.map((s) => commandFor(s.key)));
    c.sent.forEach((s, i) => {
      const args = ran[i]?.args ?? {};
      for (const [k, v] of Object.entries(s.body ?? {})) {
        const name = k === 'session' && args['session'] === undefined ? 'id' : k === 'tool_use_id' ? 'toolUseId' : k;
        assert.deepEqual(args[name], v, `${s.key} ${k}`);
      }
      for (const [k, v] of new URLSearchParams(s.query)) assert.equal(String(Array.isArray(args[k]) ? (args[k] as string[]).join(',') : args[k]), v, `${s.key} ?${k}`);
    });
  });
}
