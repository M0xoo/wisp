// `npm run dev:web`: the mock peer (mock-peer.ts) behind the same HTTP edge the Rust wisp has, so the
// app's real httpTransport runs against it:
//   GET  /api/events?<hello>     the SSE stream (one frame per event, `id:` the cursor)
//   POST /api/events             sub / unsub / window / mutate for the stream named by X-Wisp-Client
//   POST /__mock/stream?id=      start a streaming turn (default: the first running task)
//   POST /__mock/fail?cmd=       the next run of that command is refused (see a rollback)
// MOCK_SESSIONS=5000 adds that many plain tasks (a long list); MOCK_PEER names the peer.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin, PreviewServer, ViteDevServer } from 'vite';
import type { ClientMessage } from '@wisp/protocol';
import { encodeFrame, heartbeat } from '@wisp/sync';
import { createMockPeer, type MockPeer } from './mock-peer.ts';

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

function middleware(peer: MockPeer) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const url = new URL(req.url ?? '/', 'http://mock');
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

export function mockPeer(): Plugin {
  const peer = createMockPeer({ sessions: Number(process.env['MOCK_SESSIONS'] ?? 0), ...(process.env['MOCK_PEER'] && { peer: process.env['MOCK_PEER'] }) });
  return {
    name: 'wisp-mock-peer',
    configureServer: (server: ViteDevServer) => void server.middlewares.use(middleware(peer)),
    configurePreviewServer: (server: PreviewServer) => void server.middlewares.use(middleware(peer)),
  };
}
