#!/usr/bin/env node
// One connector (server/connectors.js), as the stdio MCP server a harness starts:
// `node mcp-connector.js <id>` with WISP_HOME set. It reads the connector and its secrets from
// there, so neither is in the harness's arguments. A local one runs its command with the secrets
// in its env, on this stdio. A remote one is bridged: each JSON-RPC line goes to the server as a
// Streamable HTTP POST (or the older SSE transport for a URL ending in /sse), and what comes back,
// JSON or an event stream, goes out as lines. Node built-ins only.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const id = process.argv[2];
const home = process.env.WISP_HOME;
const read = (f) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, f), 'utf8'));
  } catch {
    return {};
  }
};
const c = (read('config.json').connectors || []).find((x) => x.id === id);
if (!home || !c) {
  console.error(`wisp: no connector ${id || ''} here any more. Check Settings → Connectors`);
  process.exit(1);
}
const secrets = read('secrets.json')[`connector:${id}`] || {};
const pick = (prefix, keys) => Object.fromEntries((keys || []).map((k) => [k, secrets[`${prefix}:${k}`] ?? '']));

if (c.transport === 'local') runLocal();
else runRemote();

function runLocal() {
  const env = { ...process.env, ...pick('env', c.env) };
  delete env.ELECTRON_RUN_AS_NODE; // was for this proxy, not for the server
  delete env.WISP_HOME;
  // npx, uvx … are .cmd shims on Windows.
  // ~ as a shell would: the example commands use it, and nothing here goes through a shell.
  const tilde = (a) => String(a).replace(/^~(?=$|[\\/])/, os.homedir());
  const child = spawn(tilde(c.command), (c.args || []).map(tilde), { env, stdio: 'inherit', shell: process.platform === 'win32' });
  child.on('error', (e) => {
    console.error(`wisp: couldn’t start ${c.command}: ${e.code === 'ENOENT' ? 'not found on PATH' : e.message}`);
    process.exit(127);
  });
  child.on('exit', (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => child.kill(s));
}

function runRemote() {
  const headers = pick('header', c.headers);
  const out = (msg) => process.stdout.write(`${typeof msg === 'string' ? msg : JSON.stringify(msg)}\n`);
  // A request that failed still needs an answer, or the harness waits for it until its timeout.
  const fail = (msg, text) => {
    if (msg?.id != null && msg.method) out({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: `${c.name}: ${text}` } });
    else console.error(`wisp: ${c.name}: ${text}`);
  };
  let session = '';
  let version = '';
  const legacy = /\/sse\/?$/.test(new URL(c.url).pathname) ? openLegacy() : null;

  // SSE: "data:" lines up to a blank line make one event.
  async function events(body, onEvent) {
    const dec = new TextDecoder();
    let buf = '';
    let ev = { event: 'message', data: [] };
    for await (const chunk of body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.search(/\r?\n/)) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + (buf[i] === '\r' ? 2 : 1));
        if (!line) {
          if (ev.data.length) onEvent(ev.event, ev.data.join('\n'));
          ev = { event: 'message', data: [] };
        } else if (line.startsWith('data:')) ev.data.push(line.slice(5).replace(/^ /, ''));
        else if (line.startsWith('event:')) ev.event = line.slice(6).trim();
      }
    }
  }

  // The 2024 transport: a GET stream that names an endpoint to POST to, and carries the replies.
  function openLegacy() {
    let ready;
    const endpoint = new Promise((r) => (ready = r));
    fetch(c.url, { headers: { ...headers, accept: 'text/event-stream' } })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return events(res.body, (event, data) => {
          if (event === 'endpoint') ready(new URL(data, c.url).href);
          else out(data);
        });
      })
      .then(() => process.exit(0))
      .catch((e) => {
        console.error(`wisp: ${c.name}: ${e.message}`);
        process.exit(1);
      });
    return { endpoint };
  }

  // Replies go out as they are; initialize's says which protocol version later requests carry.
  function deliver(msg, text) {
    if (msg.method === 'initialize') {
      try {
        const body = JSON.parse(text);
        version = [body].flat().find((m) => m?.result?.protocolVersion)?.result.protocolVersion || version;
      } catch {}
    }
    for (const m of text.startsWith('[') ? JSON.parse(text) : [text]) out(m);
  }

  async function post(msg) {
    try {
      if (legacy) {
        const res = await fetch(await legacy.endpoint, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(msg) });
        if (!res.ok) fail(msg, `HTTP ${res.status}`);
        return;
      }
      const res = await fetch(c.url, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session && { 'mcp-session-id': session }), ...(version && { 'mcp-protocol-version': version }) },
        body: JSON.stringify(msg),
      });
      session = res.headers.get('mcp-session-id') || session;
      if (res.status === 401 || res.status === 403) return fail(msg, `the server refused the sign-in (HTTP ${res.status}). Check its headers in Settings → Connectors`);
      if (!res.ok) return fail(msg, `HTTP ${res.status} ${res.statusText}`.trim());
      if (res.status === 202 || !res.body) return;
      const type = res.headers.get('content-type') || '';
      if (type.includes('text/event-stream')) {
        await events(res.body, (event, data) => event === 'message' && deliver(msg, data));
      } else {
        const text = (await res.text()).trim();
        if (text) deliver(msg, text);
      }
    } catch (e) {
      fail(msg, e.cause?.code === 'ENOTFOUND' ? `can’t find ${new URL(c.url).host}` : e.message);
    }
  }

  let started = Promise.resolve();
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      // Everything after initialize waits for its reply: that's where the session id comes from.
      if (msg.method === 'initialize') started = post(msg);
      else started.then(() => post(msg));
    }
  });
  process.stdin.on('end', () => {
    // Let the server forget the session; don't wait long for it.
    if (session && !legacy) fetch(c.url, { method: 'DELETE', headers: { ...headers, 'mcp-session-id': session }, signal: AbortSignal.timeout(2000) }).catch(() => {}).finally(() => process.exit(0));
    else process.exit(0);
  });
}
