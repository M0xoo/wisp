// `npm run dev:web`: the mock peer (mock-peer.ts) behind the same HTTP edge the Rust wisp has, so the
// app's real httpTransport runs against it:
//   GET  /api/events?<hello>     the SSE stream (one frame per event, `id:` the cursor)
//   POST /api/events             sub / unsub / window / mutate for the stream named by X-Wisp-Client
//   POST /__mock/stream?id=      start a streaming turn (default: the first running task)
//   POST /__mock/fail?cmd=       the next run of that command is refused (see a rollback)
//   POST /__mock/reset           the mock starts over from its seed
// MOCK_SESSIONS=5000 adds that many plain tasks (a long list); MOCK_PEER names the peer.
// MOCK_SEED=<design/v1-reference/seed.json> replays v1's reference data (qa/parity.mjs), with the
// mock's clock starting at the capture time.

import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin, PreviewServer, ViteDevServer } from 'vite';
import type { ClientMessage } from '@wisp/protocol';
import { encodeFrame, heartbeat } from '@wisp/sync';
import { createMockPeer, type MockPeer, type MockTimers } from './mock-peer.ts';
import { v1Captured, type V1Seed } from './seed.ts';

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let s = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (s += c));
    req.on('end', () => resolve(s));
    req.on('error', reject);
  });
}

function events(peer: MockPeer, req: IncomingMessage, res: ServerResponse, url: URL): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const conn = peer.connect(Object.fromEntries(url.searchParams), (f) => res.write(encodeFrame(f.id, f.messages)));
  const hb = setInterval(() => res.write(heartbeat()), 15_000);
  req.on('close', () => {
    clearInterval(hb);
    conn.close();
  });
}

async function post(peer: MockPeer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const client = String(req.headers['x-wisp-client'] ?? '');
  try {
    peer.receive(client, JSON.parse(await body(req)) as ClientMessage);
    res.writeHead(204).end();
  } catch (err) {
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 'invalid', message: String(err) }));
  }
}

function middleware(box: { peer: MockPeer; fresh: () => MockPeer }) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const url = new URL(req.url ?? '/', 'http://mock');
    const peer = box.peer;
    if (url.pathname === '/__mock/reset') {
      box.peer = box.fresh();
      return void res.writeHead(204).end();
    }
    if (url.pathname === '/api/events' && req.method === 'GET') return events(peer, req, res, url);
    if (url.pathname === '/api/events' && req.method === 'POST') return void post(peer, req, res);
    if (url.pathname === '/__mock/stream') {
      const id = peer.stream(url.searchParams.get('id') ?? undefined, { tokens: Number(url.searchParams.get('tokens') ?? 160), everyMs: Number(url.searchParams.get('every') ?? 16) });
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id }));
    }
    if (url.pathname === '/__mock/fail') {
      peer.failNext(url.searchParams.get('cmd') ?? '');
      return void res.writeHead(204).end();
    }
    next();
  };
}

/** v1's seed and a clock that starts at its capture time, when MOCK_SEED names one */
function v1Seed(): { v1: V1Seed; timers: MockTimers } | undefined {
  const file = process.env['MOCK_SEED'];
  if (!file) return undefined;
  const v1 = JSON.parse(readFileSync(file, 'utf8')) as V1Seed;
  const offset = v1Captured(v1) - Date.now();
  return { v1, timers: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>), now: () => Date.now() + offset } };
}

export function mockPeer(): Plugin {
  const fresh = (): MockPeer => createMockPeer({ sessions: Number(process.env['MOCK_SESSIONS'] ?? 0), ...(process.env['MOCK_PEER'] && { peer: process.env['MOCK_PEER'] }), ...v1Seed() });
  // POST /__mock/reset starts it over from its seed (the QA gates, between presses)
  const box = { peer: fresh(), fresh };
  return {
    name: 'wisp-mock-peer',
    configureServer: (server: ViteDevServer) => void server.middlewares.use(middleware(box)),
    configurePreviewServer: (server: PreviewServer) => void server.middlewares.use(middleware(box)),
  };
}
