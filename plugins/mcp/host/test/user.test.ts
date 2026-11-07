// `wisp mcp` for the user's editors (v1 test/integrations.test.js 'wisp mcp: tools/list, launch with
// wait, list, the crew'), against fake owners: the words each tool answers in, the folder it defaults
// to, and the errors that are a tool's error versus a protocol error.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whoOf } from '../src/offer.ts';
import { handleRpc } from '../src/rpc.ts';
import { line } from '../src/user-tools.ts';
import { Changes } from '../src/waits.ts';
import { makeScope, tick } from './fake.ts';

interface Member {
  id: string;
  name: string;
  handle: string;
  role?: string;
  agent: string;
  mode: string;
  cwd: string;
  cron?: string;
  notebook?: string;
}

function world() {
  const scope = makeScope();
  const changes = new Changes({ timeout: (ms, fn) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); } }, scope.signal);
  const sessions = new Map<string, Record<string, unknown>>();
  const crew = new Map<string, Member>();
  const ran: { cmd: string; args: Record<string, unknown> }[] = [];
  const find = (key: unknown): Member => {
    const k = String(key).toLowerCase();
    const m = [...crew.values()].find((x) => x.id === key || x.name.toLowerCase() === k || x.handle === k);
    if (!m) throw new Error(`No one called “${String(key)}” on the crew.`);
    return m;
  };
  const owners: Record<string, (a: Record<string, unknown>) => unknown> = {
    'runtime.create': (a) => {
      const id = `s${sessions.size + 1}`;
      sessions.set(id, { id, title: String(a['prompt']), state: 'running', agent: a['agent'] ?? 'claude', cwd: a['cwd'], mode: a['mode'] ?? 'auto', project: 'repo' });
      return { id };
    },
    'runtime.get': (a) => {
      const s = sessions.get(String(a['id']));
      if (!s) throw new Error(`no session ${String(a['id'])}`);
      return s;
    },
    'runtime.list': () => [...sessions.values()].reverse(),
    'runtime.markdown': (a) => ({ markdown: `## Fake ${String(sessions.get(String(a['id']))?.['agent'])} finished` }),
    'runtime.followUp': (a) => (a['queue'] ? { queued: 1 } : { turnId: 't2' }),
    'runtime.stop': () => ({}),
    'runtime.agents': () => [{ id: 'claude', name: 'Claude Code', available: true, version: '2.0', models: [{ id: 'opus' }, { id: 'sonnet' }] }, { id: 'codex', name: 'Codex', available: false }],
    'machines.list': () => [{ id: 'm1', name: 'devbox', state: 'online', remote: { agents: [{ id: 'codex', available: true }] } }],
    'crew.list': () => [...crew.values()],
    'crew.get': (a) => find(a['key']),
    'crew.add': (a) => {
      const m: Member = { id: `c${crew.size + 1}abcdef`, name: String(a['name']), handle: String(a['name']).toLowerCase(), agent: String(a['agent'] ?? 'auto'), mode: 'auto', cwd: String(a['cwd']), ...(a['role'] !== undefined && { role: String(a['role']) }) };
      crew.set(m.id, m);
      return m;
    },
    'crew.update': (a) => Object.assign(find(a['id']), a['fields']),
    'crew.remove': (a) => void crew.delete(String(a['id'])),
  };
  const run = async <R,>(cmd: string, args: unknown): Promise<R> => {
    ran.push({ cmd, args: args as Record<string, unknown> });
    const h = owners[cmd];
    if (!h) throw new Error(`unexpected ${cmd}`);
    return h(args as Record<string, unknown>) as R;
  };
  const ctx = { who: whoOf({ set: 'user:full' }, {}), extra: [], version: '2.0.0', user: { run, changes, now: Date.now, cwd: '/work/repo' } };
  let n = 0;
  const call = async (name: string, args: Record<string, unknown> = {}) => (await handleRpc({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } }, ctx)) as { result?: { isError?: boolean; content: { text: string }[] }; error?: { code: number; message: string } };
  const text = async (name: string, args: Record<string, unknown> = {}) => (await call(name, args)).result?.content[0]?.text ?? '';
  return { scope, changes, sessions, crew, ran, call, text };
}

test('launch with wait blocks until the task lands, then reads it like wisp_get', async () => {
  const w = world();
  const done = w.text('wisp_launch', { prompt: 'fix it', agent: 'claude', wait: true, timeout_seconds: 20 });
  await tick(10);
  const s = w.sessions.get('s1');
  assert.ok(s);
  assert.equal(s['cwd'], '/work/repo', 'the folder wisp mcp runs in');
  s['state'] = 'review';
  w.changes.poke();
  const out = await done;
  assert.match(out, /state: \*\*review\*\*/);
  assert.match(out, /## Fake claude finished/);
  w.scope.dispose();
});

test('launch without wait says where it went', async () => {
  const w = world();
  assert.equal(await w.text('wisp_launch', { prompt: 'fix it', mode: 'plan', cwd: '/x' }), 'Launched session `s1` (“fix it”) on claude in /x, mode plan. Call wisp_wait or wisp_get with this id for the result.');
  assert.equal((await w.call('wisp_launch', { prompt: '  ' })).result?.content[0]?.text, 'wisp: prompt is required');
  w.scope.dispose();
});

test('wait times out on a task still running, and says so', async () => {
  const w = world();
  await w.text('wisp_launch', { prompt: 'slow' });
  const out = await w.text('wisp_wait', { id: 's1', timeout_seconds: 0.05 });
  assert.match(out, /^Session `s1` — \*\*slow\*\* — state: \*\*running\*\* \(timed out waiting; still running\)/);
  assert.match(out, /_Still running\. Call wisp_wait to block until it finishes\._$/);
  w.scope.dispose();
});

test('list: v1 lines, newest first, filtered by state and folder', async () => {
  const w = world();
  await w.text('wisp_launch', { prompt: 'fix it' });
  await w.text('wisp_launch', { prompt: 'other', cwd: '/elsewhere' });
  const s1 = w.sessions.get('s1');
  if (s1) Object.assign(s1, { state: 'review', preview: 'Fixed the test.' });
  assert.equal(await w.text('wisp_list', { limit: 3 }), '- `s2` **other** — running () [claude, repo]\n- `s1` **fix it** — review: Fixed the test. [claude, repo]');
  assert.equal(await w.text('wisp_list', { state: 'review' }), '- `s1` **fix it** — review: Fixed the test. [claude, repo]');
  assert.equal(await w.text('wisp_list', { cwd: '/work' }), '- `s1` **fix it** — review: Fixed the test. [claude, repo]');
  assert.equal(await w.text('wisp_list', { state: 'done' }), 'No sessions.');
  w.scope.dispose();
});

test('a line says waiting, the question and for later as v1 did', () => {
  assert.equal(line({ id: 'a', title: 'T', state: 'running', ask: { question: 'Which one?' }, agent: 'codex', project: 'p', forLater: true, preview: 'x' }), '- `a` **T** — waiting (for later): x — asks: Which one? [codex, p]');
  assert.equal(line({ id: 'a', title: 'T', state: 'running', live: 'Editing a.ts', agent: 'codex', project: 'p' }), '- `a` **T** — running (Editing a.ts) [codex, p]');
});

test('get of a task that is not there is a tool error, not a protocol error', async () => {
  const w = world();
  const bad = await w.call('wisp_get', { id: 'nope' });
  assert.equal(bad.result?.isError, true);
  assert.match(bad.result?.content[0]?.text ?? '', /^wisp: /);
  w.scope.dispose();
});

test('reply and stop answer in v1 words', async () => {
  const w = world();
  await w.text('wisp_launch', { prompt: 'x' });
  assert.equal(await w.text('wisp_reply', { id: 's1', text: ' more ', model: 'opus' }), 'Sent; the agent is working on it.');
  assert.deepEqual(w.ran.at(-1)?.args, { id: 's1', text: 'more', run: { model: 'opus' } });
  assert.equal(await w.text('wisp_reply', { id: 's1', text: 'later', queue: true }), 'Queued; it goes out when the current run finishes.');
  assert.equal((await w.call('wisp_reply', { id: 's1', text: '' })).result?.content[0]?.text, 'wisp: text is required');
  assert.equal(await w.text('wisp_stop', { id: 's1' }), 'Stopped `s1`.');
  w.scope.dispose();
});

test('agents: the harnesses here and the machines with theirs', async () => {
  const w = world();
  assert.equal(await w.text('wisp_agents'), '- **claude** (Claude Code) — installed 2.0; models: opus, sonnet\n- **codex** (Codex) — not installed\n\nMachines (pass machine to wisp_launch):\n- `m1` **devbox** — online; harnesses: codex');
  w.scope.dispose();
});

test('the crew: added in the folder wisp mcp runs in, changed and removed by @handle', async () => {
  const w = world();
  assert.match(await w.text('wisp_crew_add', { name: 'Mo', role: 'Release helper', agent: 'claude' }), /^Added Mo to the crew\.\n\n- \*\*Mo\*\* \(@mo, id `\w+`\) — Release helper/);
  assert.equal([...w.crew.values()][0]?.cwd, '/work/repo');
  assert.match(await w.text('wisp_crew_edit', { member: '@mo', cron: '0 9 * * *' }), /checks in on `0 9 \* \* \*`/);
  assert.match(await w.text('wisp_crew_edit', { member: 'mo', remember: ['likes  short PRs'] }), /^Updated\./);
  assert.equal([...w.crew.values()][0]?.notebook, '- likes short PRs');
  assert.match(await w.text('wisp_crew', {}), /\*\*Mo\*\*/);
  assert.match(await w.text('wisp_crew', { member: 'Mo' }), /## Notebook\n\n- likes short PRs\n\n\(17 characters\)/);
  assert.match(await w.text('wisp_crew_remove', { member: 'Mo' }), /Removed Mo from the crew/);
  assert.equal(w.crew.size, 0);
  assert.equal((await w.call('wisp_crew_remove', { member: 'Nobody' })).result?.isError, true);
  assert.equal(await w.text('wisp_crew', {}), 'No crew yet. Add a member with wisp_crew_add.');
  w.scope.dispose();
});

test('an unknown tool is the protocol error v1 gave (-32602)', async () => {
  const w = world();
  assert.deepEqual((await w.call('nope')).error, { code: -32602, message: 'Unknown tool: nope' });
  w.scope.dispose();
});
