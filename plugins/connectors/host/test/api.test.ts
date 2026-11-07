// v1's HTTP API for connectors (test/connectors.test.js, "Through the API"): secret values stay on the
// server, importing the harnesses' own servers, OAuth with refresh, and the agent's tools.

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { cappedRefusal, cappedSet, explain } from '@wisp/kernel';
import { COMMANDS, EVENTS } from '@wisp-plugin/connectors-api';
import type { ConnectorsView, SigninAsk } from '@wisp-plugin/connectors-api';
import { CONNECTOR } from '../src/store.ts';
import { boot, oauthServer, tmp, until, type Booted } from './fakes.ts';

const HOME = tmp('user');
process.env['HOME'] = HOME;
process.env['USERPROFILE'] = HOME;
for (const k of ['CLAUDE_CONFIG_DIR', 'COPILOT_HOME', 'XDG_CONFIG_HOME']) delete process.env[k];
process.env['CODEX_HOME'] = path.join(HOME, 'codex-home');
mkdirSync(process.env['CODEX_HOME']);

let b: Booted;
before(async () => {
  b = await boot();
});
after(() => b.host.dispose());

const api = async (p: string, body?: unknown, method = body ? 'POST' : 'GET') => {
  const r = await b.host.http.request(method, `/api${p}`, body === undefined ? {} : { body });
  return { status: r.status, body: r.json as ConnectorsView & { error?: string; url?: string; skipped?: unknown[] }, text: r.text };
};
// What the store holds of each connector, less its last test (the fake server names a tool after its token).
const rows = () => JSON.stringify(b.host.store.query(CONNECTOR).map((r) => ({ ...r, body: { ...(r.body as object), test: null } })));
const secretsText = () => JSON.stringify([...b.host.secrets]);

test('the API keeps secret values on the server and tests what it saved', async () => {
  const add = await api('/connectors', { name: 'fake', command: process.execPath, args: ['server.mjs'], env: { TOKEN: 'tok-123' } });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  assert.ok(!JSON.stringify(add.body).includes('tok-123'));
  const c = add.body.connectors[0];
  assert.ok(c);
  assert.deepEqual(c.env, [{ key: 'TOKEN', set: true }]);
  assert.ok(!rows().includes('tok-123'), 'not in the store');
  assert.match(secretsText(), /tok-123/);
  const t = await api(`/connectors/${c.id}/test`, {});
  assert.deepEqual(t.body.connectors[0]?.test?.tools, ['echo_tok-123', 'add']);
  const off = await api(`/connectors/${c.id}`, { enabled: false }, 'PATCH');
  assert.equal(off.body.connectors[0]?.enabled, false);
  assert.ok(off.body.connectors[0]?.test, 'switching it off keeps the last test');
  assert.equal((await api('/connectors', { name: 'fake', command: 'x' })).status, 400);
  assert.equal((await api('/connectors/nope', { enabled: true }, 'PATCH')).status, 404);
  await api(`/connectors/${c.id}`, undefined, 'DELETE');
  assert.deepEqual((await api('/connectors')).body.connectors, []);
  assert.doesNotMatch(secretsText(), /tok-123/, 'its secrets go with it');
});

test('servers in the harnesses’ configs are offered, imported with their secrets, or dismissed', async () => {
  mkdirSync(path.join(HOME, '.cursor'), { recursive: true });
  writeFileSync(path.join(HOME, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { Docs: { command: process.execPath, args: ['server.mjs'], env: { TOKEN: 'from-cursor' } }, other: { url: 'https://h.example/mcp' } } }));
  writeFileSync(path.join(process.env['CODEX_HOME'] ?? '', 'config.toml'), '[mcp_servers.docs]\ncommand = "npx"\n');
  const v = (await api('/connectors')).body;
  const docs = v.found.find((f) => f.name === 'docs');
  assert.deepEqual(docs?.from, ['Codex', 'Cursor'], 'one entry for a name, with every config it’s in');
  assert.ok(!JSON.stringify(v.found).includes('from-cursor'), 'the page sees key names only');
  const imp = await api('/connectors/import', { names: ['docs'], dismiss: ['other'] });
  assert.deepEqual(imp.body.found, []);
  assert.deepEqual(imp.body.skipped, []);
  const c = imp.body.connectors.find((x) => x.name === 'docs');
  assert.ok(c);
  assert.deepEqual(c.own, ['codex'], 'Codex has its own docs and keeps it');
  assert.equal(c.command, 'npx', 'the first config that has the name gives it (Codex, then Cursor)');
  await api(`/connectors/${c.id}`, undefined, 'DELETE');
});

test('a remote connector signs in with OAuth, and its token is refreshed when it runs out', async () => {
  const { st, url } = oauthServer(b.net);
  const add = await api('/connectors', { name: 'analytics', url });
  const id = add.body.connectors.find((c) => c.name === 'analytics')?.id ?? '';
  const row = async () => (await api('/connectors')).body.connectors.find((c) => c.id === id);
  await until(async () => (await row())?.test, 'first check');
  assert.equal((await row())?.test?.auth, true, 'a 401 asks for a sign-in');
  const origin = 'http://127.0.0.1:7777';
  const signin = (await api(`/connectors/${id}/signin`, { origin })).body.url ?? '';
  assert.match(signin, /\/authorize\?/);
  assert.equal((await api(`/connectors/${id}/signin`, { origin: 'not a url' })).status, 400);
  // The browser: the sign-in page sends it back to wisp's callback.
  const back = (await b.net.fetch(signin)).headers.get('location') ?? '';
  assert.ok(back.startsWith(`${origin}/api/connectors/oauth/callback?`));
  const page = await b.host.http.request('GET', back);
  assert.match(page.text ?? '', /Signed in to analytics/);
  await until(async () => (await row())?.test?.ok, 'check after sign-in');
  const r = await row();
  assert.deepEqual(r?.test?.tools, ['insights']);
  assert.equal(r?.signedIn?.host, new URL(url).host);
  assert.ok(!JSON.stringify((await api('/connectors')).body).includes('tok1'), 'the token never reaches the page');
  assert.ok(!rows().includes('tok1'), 'nor the store');
  // The server stops taking tok1: the proxy gets a fresh one from wisp and carries on.
  st.valid = 'tok2';
  const again = await api(`/connectors/${id}/test`, {});
  assert.equal(again.body.connectors.find((c) => c.id === id)?.test?.ok, true);
  assert.equal(st.refreshed, 1);
  // The proxy's own route for it answers the fresh token.
  const tok = await b.host.http.request('POST', `/api/internal/connectors/${id}/token`, { body: {} });
  assert.deepEqual(tok.json, { token: 'tok2' });
  // An old or reused callback is refused, and says what to do.
  assert.match((await b.host.http.request('GET', back)).text ?? '', /too old or was already used/);
  await api(`/connectors/${id}/signin`, undefined, 'DELETE');
  assert.equal((await row())?.signedIn, null);
  assert.doesNotMatch(secretsText(), /tok2|"r1"/, 'signing out drops its tokens');
  await api(`/connectors/${id}`, undefined, 'DELETE');
});

test('an agent lists and adds connectors, and the user fills in its key on a card, never through the agent', async () => {
  b.sessions.set('s1', { id: 's1', agent: 'claude', cwd: HOME, ext: {} });
  const caller = { set: 'agent:session', session: 's1' };
  const internal = async (p: string, body?: unknown) => (await b.host.http.request(body === undefined ? 'GET' : 'POST', `/api/internal/connectors/s1${p}`, { caller, ...(body !== undefined && { body }) })).json as { text?: string; error?: string };
  assert.equal((await b.host.http.request('GET', '/api/internal/connectors/s1', { caller: { set: 'agent:session', session: 'other' } })).status, 403, 'a token speaks for its own session only');
  // Values are refused: they would sit in the transcript.
  assert.match((await internal('', { name: 'fake2', command: `${process.execPath} server.mjs`, env: { TOKEN: 'x' } })).error ?? '', /names only/);
  const add = await internal('', { name: 'fake2', transport: 'local', command: `${JSON.stringify(process.execPath)} server.mjs`, env: ['TOKEN'] });
  assert.match(add.text ?? '', /Added fake2/);
  assert.match(add.text ?? '', /needs TOKEN/);
  assert.match((await internal('')).text ?? '', /\*\*fake2\*\*.*needs TOKEN/);
  const card = (await b.host.run(COMMANDS.agentSignin, { name: 'fake2', why: 'From the team vault' }, caller)) as { ask: SigninAsk };
  assert.equal(card.ask.connector.kind, 'keys');
  assert.equal(card.ask.question, 'fake2 needs TOKEN');
  assert.equal(card.ask.context, 'From the team vault');
  assert.deepEqual(card.ask.connector.keys, [{ key: 'TOKEN', field: 'env', set: false }]);
  // The card saves the key straight to wisp; once it works, the waiting call is answered.
  const id = (await api('/connectors')).body.connectors.find((c) => c.name === 'fake2')?.id;
  await api(`/connectors/${id}`, { env: { TOKEN: 'from-card' } }, 'PATCH');
  const works = await until(() => b.host.events.find((e) => e.type === EVENTS.works && (e.data as { id: string }).id === id), 'works');
  assert.match((works.data as { text: string }).text, /^Done: fake2 works \(2 tools\)/);
  assert.match((await internal('/signin', { name: 'fake2' })).text ?? '', /already works/);
  assert.match((await internal('/signin', { name: 'ghost' })).error ?? '', /No connector called “ghost”/);
  // A crew member's job or a subagent can't add any.
  b.sessions.set('s1', { id: 's1', agent: 'claude', cwd: HOME, ext: { 'wisp.crew': { id: 'm1' } } });
  assert.match((await internal('', { name: 'other', url: 'https://h.example/mcp' })).error ?? '', /Only a task the user started/);
  b.sessions.set('s1', { id: 's1', agent: 'claude', cwd: HOME, parentId: 'lead', ext: {} });
  assert.match((await internal('/signin', { name: 'fake2' })).error ?? '', /Only a task the user started/);
  await api(`/connectors/${id}`, undefined, 'DELETE');
});

test('a task a channel started at a mode cap can’t reach connectors: the kernel’s agent:capped set refuses, in v1’s words', () => {
  for (const cmd of Object.values(COMMANDS)) {
    const d = explain(cappedSet(), cmd.replace(/^connectors\./, 'connectors:'));
    assert.deepEqual(d, { ok: false, why: cappedRefusal("read or change the user's connectors") }, cmd);
  }
  assert.equal(explain(cappedSet(), 'runtime:get').ok, true, 'the rest of a session’s power stays');
});
