// Connectors: MCP servers from Settings handed to every harness through the stdio proxy
// (server/mcp-connector.js), with their secrets kept out of config.json and the CLI arguments.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { installFakeBins, makeRepo, tmp, until } from './helpers.js';

// A home of our own, so the import list reads these fake configs and not yours.
const HOME = tmp('conn-user');
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;
delete process.env.COPILOT_HOME;
delete process.env.XDG_CONFIG_HOME;
process.env.WISP_HOME = tmp('conn-home');
process.env.WISP_UPDATE_CHECK = '0';
installFakeBins();

const { codexServers, normalizeConnector, ownNames, probe, splitCommand, storeSecrets, turnServers } = await import('../server/connectors.js');
const { Secrets } = await import('../server/secrets.js');

// A stdio MCP server that answers initialize and tools/list, naming a tool after $TOKEN.
const FAKE = path.join(tmp('conn-srv'), 'server.mjs');
fs.writeFileSync(
  FAKE,
  `import rl from 'node:readline';
rl.createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  const reply = (result) => console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
  if (m.method === 'initialize') reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } });
  if (m.method === 'tools/list') reply({ tools: [{ name: 'echo_' + (process.env.TOKEN || 'none') }, { name: 'add' }] });
});
`,
);

test('a command line is split like a shell would', () => {
  assert.deepEqual(splitCommand(`npx -y @x/server --root '/a b' "c d" ''`), ['npx', '-y', '@x/server', '--root', '/a b', 'c d', '']);
});

test('names, transports and secrets are checked, with reasons', () => {
  const ok = normalizeConnector({ name: 'My GitHub', command: 'npx -y @x/github', env: { GITHUB_TOKEN: 'ghp_x' } }, []);
  assert.equal(ok.connector.name, 'my_github');
  assert.equal(ok.connector.command, 'npx');
  assert.deepEqual(ok.connector.args, ['-y', '@x/github']);
  assert.deepEqual(ok.connector.env, ['GITHUB_TOKEN']);
  assert.deepEqual(ok.sets, [['env:GITHUB_TOKEN', 'ghp_x']]);
  assert.ok(!JSON.stringify(ok.connector).includes('ghp_x'), 'the value is not in the connector');
  const refuse = (body, re, list = []) => assert.throws(() => normalizeConnector(body, list), (e) => e.status === 400 && re.test(e.message));
  refuse({ name: '', command: 'x' }, /name/);
  refuse({ name: 'wisp', command: 'x' }, /wisp/);
  refuse({ name: 'gh', command: 'x' }, /already/, [{ id: 'a', name: 'gh' }]);
  refuse({ name: 'x', transport: 'local' }, /command/);
  refuse({ name: 'x', transport: 'remote', url: 'ftp://h' }, /https/);
  refuse({ name: 'x', command: `npx srv --token ghp_${'a'.repeat(36)}` }, /GitHub token.*env var/);
  refuse({ name: 'x', url: 'https://u:secretpw@h.example/mcp' }, /password in a URL.*header/);
  refuse({ name: 'x', command: 'y', env: { 'BAD KEY': '1' } }, /Env var name/);
  // Editing: an empty value keeps the saved one; a key left out is gone.
  const was = { ...ok.connector };
  const edit = normalizeConnector({ env: { GITHUB_TOKEN: '', OTHER: 'v' } }, [was], was);
  assert.deepEqual(edit.sets, [['env:OTHER', 'v']]);
  assert.deepEqual(edit.connector.env, ['GITHUB_TOKEN', 'OTHER']);
});

test('Codex’s config.toml servers are read', () => {
  const s = codexServers(`model = "o3"
[mcp_servers.docs]
command = "npx"
args = ["-y", "mcp-docs", 'x y']
env = { "API_KEY" = "k1", OTHER = 'k2' }

[mcp_servers.linear]
url = "https://mcp.linear.app/mcp"
bearer_token = "tok"
[mcp_servers.linear.http_headers]
X-Team = "eng"
[profiles.x]
command = "nope"
`);
  assert.deepEqual(s.docs, { command: 'npx', args: ['-y', 'mcp-docs', 'x y'], env: { API_KEY: 'k1', OTHER: 'k2' } });
  assert.equal(s.linear.url, 'https://mcp.linear.app/mcp');
  assert.deepEqual(s.linear.http_headers, { 'X-Team': 'eng' });
  assert.equal(Object.keys(s).length, 2);
});

test('turns get each connector through the proxy, none in Plan mode, and never a secret', () => {
  const c = { id: 'abc', name: 'docs', transport: 'local', command: 'npx', args: ['-y', 'x'], env: ['TOKEN'], enabled: true };
  const off = { ...c, id: 'def', name: 'off', enabled: false };
  const got = turnServers([c, off], { agent: 'codex', mode: 'auto', cwd: HOME, home: '/w' });
  assert.deepEqual(Object.keys(got), ['docs']);
  assert.equal(got.docs.command, process.execPath);
  assert.match(got.docs.args[0], /mcp-connector\.js$/);
  assert.equal(got.docs.args[1], 'abc');
  assert.deepEqual(got.docs.env, { ELECTRON_RUN_AS_NODE: '1', WISP_HOME: '/w' });
  assert.deepEqual(turnServers([c], { agent: 'codex', mode: 'plan', cwd: HOME, home: '/w' }), {});
  assert.deepEqual(turnServers([c], { agent: 'cursor', mode: 'auto', cwd: HOME, home: '/w' }), {}, 'cursor takes none');
});

test('a harness that has a server by that name in its own config keeps its own', () => {
  fs.writeFileSync(path.join(HOME, '.claude.json'), JSON.stringify({ mcpServers: { docs: { command: 'npx', args: ['mcp-docs'] } } }));
  try {
    assert.ok(ownNames(null).claude.has('docs'));
    const c = { id: 'abc', name: 'docs', transport: 'local', command: 'npx', enabled: true };
    assert.deepEqual(turnServers([c], { agent: 'claude', mode: 'auto', cwd: HOME, home: '/w' }), {});
    assert.deepEqual(Object.keys(turnServers([c], { agent: 'codex', mode: 'auto', cwd: HOME, home: '/w' })), ['docs']);
  } finally {
    fs.rmSync(path.join(HOME, '.claude.json'));
  }
});

// Writes the connector and its secrets where the proxy reads them.
function saveAt(home, body) {
  const secrets = new Secrets(home);
  const { connector, sets } = normalizeConnector(body, []);
  storeSecrets(secrets, connector, sets);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ connectors: [connector] }));
  return connector;
}

test('a local connector starts through the proxy with its secret env', async () => {
  const home = tmp('conn-local');
  const c = saveAt(home, { name: 'fake', command: process.execPath, args: [FAKE], env: { TOKEN: 's3cret' } });
  const r = await probe(c, home);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.tools, ['echo_s3cret', 'add']);
});

test('a local connector that can’t start says why', async () => {
  const home = tmp('conn-bad');
  const c = saveAt(home, { name: 'nope', command: 'wisp-no-such-command-xyz' });
  const r = await probe(c, home);
  assert.equal(r.ok, false);
  assert.match(r.error, /not found|not recognized|ENOENT|exit/); // Windows: cmd says it isn't recognized
});

// Streamable HTTP: JSON for initialize, an event stream for tools/list, a session id, a bearer header.
function remoteServer() {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const d of req) raw += d;
    seen.push({ method: req.method, auth: req.headers.authorization, session: req.headers['mcp-session-id'], version: req.headers['mcp-protocol-version'] });
    if (req.method === 'DELETE') return res.end();
    if (req.headers.authorization !== 'Bearer t0k') return (res.statusCode = 401), res.end();
    const m = JSON.parse(raw);
    if (m.method === 'initialize') {
      res.setHeader('mcp-session-id', 'sess-1');
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'r', version: '1' } } }));
    }
    if (m.id == null) return (res.statusCode = 202), res.end();
    res.setHeader('content-type', 'text/event-stream');
    res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'search' }] } })}\n\n`);
    res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}/mcp` })));
}

test('a remote connector is bridged over Streamable HTTP with its headers', async () => {
  const { server, seen, url } = await remoteServer();
  try {
    const home = tmp('conn-remote');
    const c = saveAt(home, { name: 'remote', url, headers: { Authorization: 'Bearer t0k' } });
    const r = await probe(c, home);
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.tools, ['search']);
    const after = seen.filter((s) => s.method === 'POST').slice(1);
    assert.ok(after.length >= 2 && after.every((s) => s.session === 'sess-1' && s.version === '2025-03-26'), 'later requests carry the session and version');
    // A wrong token is a clear refusal, not a hang.
    const bad = saveAt(home, { name: 'remote', url, headers: { Authorization: 'Bearer nope' } });
    const r2 = await probe(bad, home);
    assert.equal(r2.ok, false);
    assert.match(r2.error, /Needs sign-in/);
    assert.equal(r2.auth, true);
  } finally {
    server.close();
  }
});

// --- Through the API ---

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
let srv;
let base;
before(async () => {
  const { startServer } = await import('../server/index.js');
  const port = await freePort();
  srv = await startServer({ port, handleSignals: false });
  base = `http://127.0.0.1:${port}/api`;
});
after(() => {
  srv?.shutdown();
  srv?.server.close();
});
async function api(p, body, method = body ? 'POST' : 'GET') {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

test('the API keeps secret values on the server and tests what it saved', async () => {
  const add = await api('/connectors', { name: 'fake', command: process.execPath, args: [FAKE], env: { TOKEN: 'tok-123' } });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  assert.ok(!JSON.stringify(add.body).includes('tok-123'));
  const c = add.body.connectors[0];
  assert.deepEqual(c.env, [{ key: 'TOKEN', set: true }]);
  const cfg = fs.readFileSync(path.join(process.env.WISP_HOME, 'config.json'), 'utf8');
  assert.ok(!cfg.includes('tok-123'), 'not in config.json');
  assert.match(fs.readFileSync(path.join(process.env.WISP_HOME, 'secrets.json'), 'utf8'), /tok-123/);
  const t = await api(`/connectors/${c.id}/test`, {});
  assert.deepEqual(t.body.connectors[0].test.tools, ['echo_tok-123', 'add']);
  const off = await api(`/connectors/${c.id}`, { enabled: false }, 'PATCH');
  assert.equal(off.body.connectors[0].enabled, false);
  assert.ok(off.body.connectors[0].test, 'switching it off keeps the last test');
  assert.equal((await api('/connectors', { name: 'fake', command: 'x' })).status, 400);
  await api(`/connectors/${c.id}`, null, 'DELETE');
  assert.deepEqual((await api('/connectors')).body.connectors, []);
  assert.doesNotMatch(fs.readFileSync(path.join(process.env.WISP_HOME, 'secrets.json'), 'utf8'), /tok-123/, 'its secrets go with it');
});

test('servers in the harnesses’ configs are offered, imported with their secrets, or dismissed', async () => {
  fs.mkdirSync(path.join(HOME, '.cursor'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { Docs: { command: process.execPath, args: [FAKE], env: { TOKEN: 'from-cursor' } }, other: { url: 'https://h.example/mcp' } } }));
  fs.writeFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), '[mcp_servers.docs]\ncommand = "npx"\n'); // helpers point CODEX_HOME at a temp dir
  const v = (await api('/connectors')).body;
  const docs = v.found.find((f) => f.name === 'docs');
  assert.deepEqual(docs.from, ['Codex', 'Cursor'], 'one entry for a name, with every config it’s in');
  assert.ok(!JSON.stringify(v.found).includes('from-cursor'), 'the page sees key names only');
  const imp = await api('/connectors/import', { names: ['docs'], dismiss: ['other'] });
  assert.deepEqual(imp.body.found, []);
  const c = imp.body.connectors.find((x) => x.name === 'docs');
  assert.ok(c);
  assert.deepEqual(c.own, ['codex'], 'Codex has its own docs and keeps it');
});

// An MCP server behind OAuth: metadata, dynamic registration, PKCE, refresh. `valid` is the one
// access token it takes; changing it makes the next call a 401 the proxy has to refresh past.
function oauthServer() {
  const st = { valid: 'tok1', codes: new Map(), refreshed: 0 };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const d of req) raw += d;
    const base = `http://127.0.0.1:${server.address().port}`;
    const u = new URL(req.url, base);
    const json = (code, body) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(body)));
    if (u.pathname === '/.well-known/oauth-protected-resource/mcp') return json(200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['mcp'] });
    if (u.pathname === '/.well-known/oauth-authorization-server') return json(200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register` });
    if (u.pathname === '/register') return json(201, { client_id: 'cid-1', ...JSON.parse(raw) });
    if (u.pathname === '/authorize') {
      const code = `code-${st.codes.size}`;
      st.codes.set(code, u.searchParams.get('code_challenge'));
      assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(u.searchParams.get('scope'), 'mcp');
      res.writeHead(302, { location: `${u.searchParams.get('redirect_uri')}?code=${code}&state=${u.searchParams.get('state')}` });
      return res.end();
    }
    if (u.pathname === '/token') {
      const f = new URLSearchParams(raw);
      if (f.get('grant_type') === 'authorization_code') {
        const challenge = (await import('node:crypto')).createHash('sha256').update(f.get('code_verifier')).digest('base64url');
        if (st.codes.get(f.get('code')) !== challenge) return json(400, { error: 'invalid_grant' });
        return json(200, { access_token: st.valid, refresh_token: 'r1', expires_in: 3600 });
      }
      if (f.get('grant_type') === 'refresh_token' && f.get('refresh_token') === 'r1') {
        st.refreshed++;
        return json(200, { access_token: st.valid, expires_in: 3600 });
      }
      return json(400, { error: 'invalid_grant' });
    }
    if (u.pathname === '/mcp') {
      if (req.headers.authorization !== `Bearer ${st.valid}`) {
        res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
        return res.end();
      }
      const m = JSON.parse(raw);
      if (m.id == null) return (res.statusCode = 202), res.end();
      return json(200, { jsonrpc: '2.0', id: m.id, result: m.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'o', version: '1' } } : { tools: [{ name: 'insights' }] } });
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, st, url: `http://127.0.0.1:${server.address().port}/mcp` })));
}

test('a remote connector signs in with OAuth, and its token is refreshed when it runs out', async () => {
  const { server, st, url } = await oauthServer();
  try {
    const add = await api('/connectors', { name: 'analytics', url });
    const id = add.body.connectors.find((c) => c.name === 'analytics').id;
    const row = async () => (await api('/connectors')).body.connectors.find((c) => c.id === id);
    await until(async () => (await row()).test, { what: 'first check' });
    assert.equal((await row()).test.auth, true, 'a 401 asks for a sign-in');
    const origin = base.replace(/\/api$/, '');
    const { url: signin } = (await api(`/connectors/${id}/signin`, { origin })).body;
    assert.match(signin, /\/authorize\?/);
    const back = (await fetch(signin, { redirect: 'manual' })).headers.get('location');
    assert.ok(back.startsWith(`${origin}/api/connectors/oauth/callback?`));
    const page = await (await fetch(back)).text();
    assert.match(page, /Signed in to analytics/);
    await until(async () => (await row()).test?.ok, { what: 'check after sign-in' });
    const r = await row();
    assert.deepEqual(r.test.tools, ['insights']);
    assert.equal(r.signedIn.host, new URL(url).host);
    assert.ok(!JSON.stringify((await api('/connectors')).body).includes('tok1'), 'the token never reaches the page');
    // The server stops taking tok1: the proxy gets a fresh one from wisp and carries on.
    st.valid = 'tok2';
    const again = await api(`/connectors/${id}/test`, {});
    assert.equal(again.body.connectors.find((c) => c.id === id).test.ok, true);
    assert.equal(st.refreshed, 1);
    // An old or reused callback is refused, and says what to do.
    assert.match(await (await fetch(back)).text(), /too old or was already used/);
    await api(`/connectors/${id}/signin`, null, 'DELETE');
    assert.equal((await row()).signedIn, null);
  } finally {
    server.close();
  }
});

test('an agent lists and adds connectors, and the user fills in its key on a card, never through the agent', async () => {
  const s = (await api('/sessions', { prompt: 'look at math.js', cwd: makeRepo(), agent: 'claude', worktree: false })).body;
  await until(async () => (await api(`/sessions/${s.id}`)).body.state !== 'running', { what: 'task ends' });
  const tok = { 'content-type': 'application/json', 'x-wisp-token': srv.token };
  const internal = async (p, body, method = body ? 'POST' : 'GET') => (await fetch(`${base}/internal/connectors/${s.id}${p}`, { method, headers: tok, body: body && JSON.stringify(body) })).json();
  assert.equal((await fetch(`${base}/internal/connectors/${s.id}`)).status, 403, 'only with wisp’s token');
  // Values are refused: they would sit in the transcript.
  assert.match((await internal('', { name: 'fake2', command: `${process.execPath} ${FAKE}`, env: { TOKEN: 'x' } })).error, /names only/);
  const add = await internal('', { name: 'fake2', transport: 'local', command: `${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)}`, env: ['TOKEN'] });
  assert.match(add.text, /Added fake2/);
  assert.match(add.text, /needs TOKEN/);
  assert.match((await internal('')).text, /\*\*fake2\*\*.*needs TOKEN/);
  const card = await internal('/signin', { name: 'fake2', why: 'From the team vault' });
  assert.ok(card.id);
  const ask = srv.store.get(s.id).ask;
  assert.equal(ask.connector.kind, 'keys');
  assert.deepEqual(ask.connector.keys, [{ key: 'TOKEN', field: 'env', set: false }]);
  // The card saves the key straight to wisp; once it works, the agent's call is answered.
  const id = (await api('/connectors')).body.connectors.find((c) => c.name === 'fake2').id;
  await api(`/connectors/${id}`, { env: { TOKEN: 'from-card' } }, 'PATCH');
  let answer;
  await until(async () => (answer = await (await fetch(`${base}/internal/ask/${card.id}`, { headers: tok })).json()).answer, { what: 'card answered' });
  assert.match(answer.answer, /^Done: fake2 works \(2 tools\)/);
  assert.equal(srv.store.get(s.id).ask, undefined);
  assert.match((await internal('/signin', { name: 'fake2' })).text, /already works/);
  // A crew member's job or a subagent can't add any.
  srv.store.get(s.id).crew = 'm1';
  assert.match((await internal('', { name: 'other', url: 'https://h.example/mcp' })).error, /Only a task the user started/);
  delete srv.store.get(s.id).crew;
  await api(`/connectors/${id}`, null, 'DELETE');
});
