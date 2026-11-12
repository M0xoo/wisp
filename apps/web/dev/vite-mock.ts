// `npm run dev:web`: the mock peer (mock-peer.ts) behind the same HTTP edge the Rust wisp has, so the
// app's real httpTransport runs against it:
//   GET  /api/events?<hello>     the SSE stream (one frame per event, `id:` the cursor)
//   POST /api/events             sub / unsub / window / mutate for the stream named by X-Wisp-Client
//   POST /__mock/stream?id=      start a streaming turn (default: the first running task)
//   POST /__mock/fail?cmd=       the next run of that command is refused (see a rollback)
//   POST /__mock/reset           the mock starts over from its seed (?seed=computers: a second computer,
//                                 Studio, at /api/peer/studio, and a project here; MOCK_COMPUTERS=1 starts that way;
//                                 ?seed=first-run: no tasks yet; ?seed=usage: a lead's usage and context fill;
//                                 New task's first run; MOCK_FIRST_RUN=1 starts that way)
// MOCK_SESSIONS=5000 adds that many plain tasks (a long list); MOCK_PEER names the peer.
// MOCK_SEED=<design/v1-reference/seed.json> replays v1's reference data (qa/parity.mjs), with the
// mock's clock starting at the capture time.

import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin, PreviewServer, ViteDevServer } from 'vite';
import type { ClientMessage } from '@wisp/protocol';
import { encodeFrame, heartbeat } from '@wisp/sync';
import { createMockPeer, type MockPeer, type MockTimers } from './mock-peer.ts';
import { STUDIO, v1Captured, type V1Seed } from './seed.ts';
import { resetGit } from './mock-git.ts';

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

const MOCK_APP = `<!doctype html><meta charset="utf-8"><title>Login</title><body style="font:15px system-ui;margin:0;display:grid;place-items:center;height:100vh;background:#fafaf9"><form style="display:grid;gap:10px;width:260px"><h2 style="margin:0 0 6px">Sign in</h2><input placeholder="Email" style="padding:9px;border:1px solid #ddd;border-radius:8px"><input type="password" placeholder="Password" style="padding:9px;border:1px solid #ddd;border-radius:8px"><button style="padding:9px;border:0;border-radius:8px;background:#171717;color:#fff">Sign in</button></form></body>`;

/** A dev server's first lines (vite's), then quiet: what Preview reads the address from. */
function runStream(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const host = String(req.headers.host ?? 'localhost:5173').replace(/^[^:]+/, 'localhost');
  const send = (event: string, data: unknown): boolean => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('hello', { cols: 100, rows: 24 });
  const lines = ['\r\n> app@0.1.0 dev\r\n> vite\r\n\r\n', `  VITE v7.3.7  ready in 312 ms\r\n\r\n  ➜  Local:   http://${host}/__mock/app\r\n`];
  const timers = lines.map((l, i) => setTimeout(() => send('data', l), 150 * (i + 1)));
  req.on('close', () => timers.forEach(clearTimeout));
}

type Seed = 'first-run' | 'computers' | 'media' | 'env' | 'usage' | undefined;

/** An answer's picture (v1 /sessions/:id/file): a drawn SVG naming the path; a video isn't there. */
function mediaFile(url: URL, res: ServerResponse): void {
  const p = url.searchParams.get('path') ?? '';
  if (!/\.(png|jpe?g|gif|webp|svg)$/i.test(p)) return void res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
  const hue = [...p].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 0);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="700"><rect width="1200" height="700" fill="hsl(${hue} 60% 55%)"/><text x="600" y="370" font-family="sans-serif" font-size="56" text-anchor="middle" fill="white">${p.replace(/[<&]/g, '')}</text></svg>`;
  res.writeHead(200, { 'content-type': 'image/svg+xml' }).end(svg);
}

function middleware(box: { peer: MockPeer; others: Map<string, MockPeer>; fresh: (seed?: Seed) => { peer: MockPeer; others: Map<string, MockPeer> } }) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const url = new URL(req.url ?? '/', 'http://mock');
    const peer = box.peer;
    if (url.pathname === '/__mock/reset') {
      const made = box.fresh((url.searchParams.get('seed') ?? undefined) as Seed);
      box.peer = made.peer;
      box.others = made.others;
      resetGit();
      return void res.writeHead(204).end();
    }
    // another computer's wisp, as the app reaches it through this one (`/api/peer/<machine>/…`)
    const via = url.pathname.match(/^\/api\/peer\/([^/]+)(\/.*)$/);
    const other = via ? box.others.get(decodeURIComponent(via[1] ?? '')) : undefined;
    if (other && via?.[2] === '/api/events' && req.method === 'GET') return events(other, req, res, url);
    if (other && via?.[2] === '/api/events' && req.method === 'POST') return void post(other, req, res);
    if (url.pathname === '/api/events' && req.method === 'GET') return events(peer, req, res, url);
    if (url.pathname === '/api/events' && req.method === 'POST') return void post(peer, req, res);
    // the side panel's Preview: the app's output (a dev server saying where it listens), then the app itself
    if (/^(\/api\/peer\/[^/]+)?\/api\/sessions\/[^/]+\/file$/.test(url.pathname) && req.method === 'GET') return mediaFile(url, res);
    const run = url.pathname.match(/^\/api\/sessions\/[^/]+\/run$/);
    if (run && req.method === 'GET') return runStream(req, res);
    if (url.pathname === '/__mock/app') return void res.writeHead(200, { 'content-type': 'text/html' }).end(MOCK_APP);
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
  const fresh = (
    seed: Seed = process.env['MOCK_FIRST_RUN'] === '1' ? 'first-run' : process.env['MOCK_COMPUTERS'] === '1' ? 'computers' : undefined,
  ): { peer: MockPeer; others: Map<string, MockPeer> } => {
    const computers = seed === 'computers';
    const peer = createMockPeer({
      sessions: Number(process.env['MOCK_SESSIONS'] ?? 0),
      ...(process.env['MOCK_PEER'] && { peer: process.env['MOCK_PEER'] }),
      ...(seed === 'first-run' ? { firstRun: true } : computers ? { computers: true } : seed === 'media' ? { media: true } : seed === 'env' ? { env: true } : seed === 'usage' ? { usage: true } : v1Seed()),
    });
    // Studio: a wisp of its own with no tasks yet (and no projects: Run on sets one up there)
    const others = new Map<string, MockPeer>(computers ? [[STUDIO, createMockPeer({ peer: STUDIO, name: 'Studio', firstRun: true })]] : []);
    return { peer, others };
  };
  // POST /__mock/reset starts it over from its seed (the QA gates, between presses)
  const first = fresh();
  const box = { peer: first.peer, others: first.others, fresh };
  return {
    name: 'wisp-mock-peer',
    configureServer: (server: ViteDevServer) => void server.middlewares.use(middleware(box)),
    configurePreviewServer: (server: PreviewServer) => void server.middlewares.use(middleware(box)),
  };
}
