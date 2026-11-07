// wisp's MCP server is a harness's child that waits on wisp: when either goes, the wait must end.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MCP = fileURLToPath(new URL('../server/mcp-ask.js', import.meta.url));
const GATE = new URL('../server/opencode-gate.js', import.meta.url).href;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// A stand-in for wisp: `handle` answers each request. Its port stays free to take again.
async function fake(handle, port = 0) {
  const server = http.createServer((req, res) => {
    const json = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify(body));
    };
    req.resume();
    req.on('end', () => handle(req, json));
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return {
    port: server.address().port,
    close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }),
  };
}

let spawned = [];
afterEach(() => {
  for (const p of spawned) p.kill('SIGKILL'); // a failing test leaves no orphan of its own
  spawned = [];
});

function mcp(url, env = {}) {
  const srv = spawn(process.execPath, [MCP], { env: { ...process.env, WISP_URL: url, WISP_TOKEN: 't', WISP_SESSION: 's', WISP_APPROVE: '1', ...env }, stdio: ['pipe', 'pipe', 'ignore'] });
  spawned.push(srv);
  const replies = new Map();
  let buf = '';
  srv.stdout.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) if (buf.slice(0, i).trim()) { const r = JSON.parse(buf.slice(0, i)); replies.set(r.id, r); }
  });
  const exited = new Promise((r) => srv.once('exit', r));
  return {
    srv,
    call: (id, name, args) => srv.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`),
    reply: async (id, ms = 5000) => {
      for (const end = Date.now() + ms; !replies.has(id) && Date.now() < end; ) await delay(20);
      return replies.get(id);
    },
    // True if it left within ms.
    left: async (ms = 5000) => {
      return Promise.race([exited.then(() => true), delay(ms).then(() => false)]);
    },
  };
}

// Until a wait is under way, not just until a guess at how long a loaded machine takes to start one.
const polled = async (seen, n = 2) => {
  for (let i = 0; seen.length < n && i < 1500; i++) await delay(20);
  assert.ok(seen.length >= n, 'it polled');
};

const asking = (seen) => (req, json) => {
  seen.push(req.url);
  if (req.method === 'POST') return json(200, { id: 'q1' });
  json(200, { pending: true });
};

test('the harness goes while a question waits, and wisp is gone too: the MCP server exits', async () => {
  const seen = [];
  const wisp = await fake(asking(seen));
  const m = mcp(`http://127.0.0.1:${wisp.port}`);
  m.call(1, 'ask_user', { question: 'q?' });
  await polled(seen);
  await wisp.close();
  m.srv.stdin.end(); // what a killed harness leaves: the pipe's far end closed
  assert.equal(await m.left(), true, 'it should exit, not poll a dead port for good');
});

test('the harness goes while a question waits and wisp stays: the MCP server exits', async () => {
  const seen = [];
  const wisp = await fake(asking(seen));
  const m = mcp(`http://127.0.0.1:${wisp.port}`);
  m.call(1, 'ask_user', { question: 'q?' });
  await polled(seen);
  m.srv.stdin.end();
  assert.equal(await m.left(), true);
  await wisp.close();
});

test('a wisp that refuses the token is not this run\'s wisp: the wait ends, whatever the tool', async () => {
  // Each start of wisp makes a new token, so a 403 never turns back into an answer.
  let refuse = false;
  const seen = [];
  const wisp = await fake((req, json) => {
    if (refuse) return json(403, { error: 'bad token' });
    if (req.url.startsWith('/api/internal/delegate')) {
      seen.push(req.url);
      return req.method === 'POST' ? json(200, { delegations: [{ id: 'd1', name: 'a' }] }) : json(200, { done: false, text: 'still' });
    }
    asking(seen)(req, json);
  });
  const m = mcp(`http://127.0.0.1:${wisp.port}`);
  m.call(1, 'ask_user', { question: 'q?' });
  m.call(2, 'approve', { tool_name: 'Bash', input: {}, tool_use_id: 'u' });
  m.call(3, 'delegate', { tasks: [{ prompt: 'x' }] });
  await polled(seen, 5); // the three calls, and a poll or two
  refuse = true;
  const [asked, approved, delegated] = await Promise.all([m.reply(1, 6000), m.reply(2, 6000), m.reply(3, 6000)]);
  assert.match(asked?.result.content[0].text ?? 'no reply', /did not answer/);
  assert.equal(JSON.parse(approved?.result.content[0].text ?? '{}').behavior, 'deny', 'the gate fails closed');
  assert.equal(delegated?.result.isError, true);
  assert.match(delegated.result.content[0].text, /403/);
  await wisp.close();
});

test('a wisp that stays down ends the wait; one back in time answers it', async () => {
  // Stays down: WISP_GONE_S shortens the five minutes.
  const seen = [];
  const a = await fake(asking(seen));
  const m = mcp(`http://127.0.0.1:${a.port}`, { WISP_GONE_S: '2' });
  m.call(1, 'ask_user', { question: 'q?' });
  await polled(seen);
  await a.close();
  const r = await m.reply(1, 8000);
  assert.match(r?.result.content[0].text ?? 'no reply', /did not answer/);

  // Comes back within it, with the answer: this wait isn't lost to a blip.
  let answer = false;
  const heard = [];
  const handle = (req, json) => (answer ? json(200, { answer: 'yes' }) : asking(heard)(req, json));
  const b = await fake(handle);
  const n = mcp(`http://127.0.0.1:${b.port}`, { WISP_GONE_S: '20' });
  n.call(1, 'ask_user', { question: 'q?' });
  await polled(heard);
  await b.close();
  await delay(2000); // a failed poll or two
  answer = true;
  const again = await fake(handle, b.port);
  const back = await n.reply(1, 6000);
  assert.match(back?.result.content[0].text ?? 'no reply', /The user answered: yes/);
  await again.close();
});

test('the OpenCode gate stops waiting on a wisp that is gone, and refuses the write', async () => {
  let refuse = false;
  const wisp = await fake((req, json) => {
    if (refuse) return json(403, { error: 'bad token' });
    if (req.method === 'POST') return json(200, { id: 'g1' });
    refuse = true; // the second poll on is another wisp
    json(200, { pending: true });
  });
  const script = `import(${JSON.stringify(GATE)}).then(async ({ WispGate }) => {
    const h = await WispGate();
    await h['tool.execute.before']({ tool: 'bash', callID: 'c' }, { args: { command: 'ls' } }).then(() => console.log('ALLOWED'), (e) => console.log('REFUSED', e.message));
  });`;
  const p = spawn(process.execPath, ['-e', script], { env: { ...process.env, WISP_URL: `http://127.0.0.1:${wisp.port}`, WISP_TOKEN: 't', WISP_SESSION: 's' }, stdio: ['ignore', 'pipe', 'inherit'] });
  spawned.push(p);
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  await Promise.race([new Promise((r) => p.once('exit', r)), delay(8000)]);
  assert.match(out, /REFUSED/);
  await wisp.close();
});
