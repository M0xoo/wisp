// The one file of @wisp/sync that does I/O: it attaches a SyncServer to node:http. apps/server mounts
//   GET  /api/events  → events()   the SSE stream (the hello rides on its query)
//   POST /api/events  → message()  sub, unsub, window, mutate for an open stream (X-Wisp-Client)
//   POST /api/cmd     → command()  a command outside any stream, by Idempotency-Key
// and answers the host outputs (snapshotRequest, windowRequest, command, activity) through input().

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CommandRequest, CommandResponse } from '@wisp/protocol';
import { SyncServer } from './server.ts';
import { retryField } from './sse.ts';
import type { ConnectQuery, ConnId, ServerInput, ServerOutput } from './types.ts';

export type HostOutput<C> = Exclude<ServerOutput<C>, { kind: 'send' } | { kind: 'closeConn' }>;

export interface NodeSyncOptions<C> {
  sync: SyncServer<C>;
  /** the outputs the host carries out; their answers come back through input() */
  onOutput(out: HostOutput<C>): void;
  /** two requests speak for the same caller (a POST may only drive its own stream) */
  sameCaller?(a: C, b: C): boolean;
  now?(): number;
  retryMs?: number;
  maxBodyBytes?: number;
}

const QUERY_KEYS = ['proto_min', 'proto_max', 'client_id', 'build', 'epoch', 'cursor', 'topics', 'fresh', 'passive'] as const;

export class NodeSync<C> {
  #o: NodeSyncOptions<C>;
  #res = new Map<ConnId, ServerResponse>();
  #queue: ServerInput<C>[] = [];
  #running = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #wakeAt: number | null = null;
  #n = 0;

  constructor(opts: NodeSyncOptions<C>) {
    this.#o = opts;
  }

  #now(): number {
    return this.#o.now?.() ?? Date.now();
  }

  /** Feeds one input; outputs are carried out before the next input runs (no re-entry). */
  input(i: ServerInput<C>): void {
    this.#queue.push(i);
    if (this.#running) return;
    this.#running = true;
    try {
      for (let next = this.#queue.shift(); next !== undefined; next = this.#queue.shift()) {
        for (const out of this.#o.sync.handle(next, this.#now())) this.#carry(out);
      }
    } finally {
      this.#running = false;
    }
    this.#schedule();
  }

  #carry(out: ServerOutput<C>): void {
    if (out.kind === 'send') {
      const res = this.#res.get(out.conn);
      if (res === undefined) return;
      res.write(out.frame);
      // the machine counts what it wrote; the socket says what is really still waiting
      this.#queue.push({ kind: 'drained', conn: out.conn, bufferedBytes: res.writableLength });
    } else if (out.kind === 'closeConn') {
      const res = this.#res.get(out.conn);
      this.#res.delete(out.conn);
      res?.end();
    } else this.#o.onOutput(out);
  }

  #schedule(): void {
    const at = this.#o.sync.nextWakeAt();
    if (at === this.#wakeAt) return;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#wakeAt = at;
    if (at === null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#wakeAt = null;
      this.input({ kind: 'tick' });
    }, Math.max(0, at - this.#now()));
    this.#timer.unref?.();
  }

  /** GET /api/events?topics=…&cursor=… (Last-Event-ID when the browser reconnects by itself) */
  events(req: IncomingMessage, res: ServerResponse, caller: C): void {
    const url = new URL(req.url ?? '/', 'http://x');
    const query: ConnectQuery = {};
    for (const k of QUERY_KEYS) {
      const v = url.searchParams.get(k);
      if (v !== null) query[k] = v;
    }
    const last = req.headers['last-event-id'];
    if (typeof last === 'string') query.last_event_id = last;
    const conn = `c${++this.#n}`;
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.socket?.setNoDelay(true);
    res.write(retryField(this.#o.retryMs ?? 2000));
    this.#res.set(conn, res);
    res.on('drain', () => this.input({ kind: 'drained', conn, bufferedBytes: res.writableLength }));
    res.on('close', () => {
      this.#res.delete(conn);
      this.input({ kind: 'close', conn });
    });
    this.input({ kind: 'connect', conn, caller, query });
  }

  /** POST /api/events: one ClientMessage or an array, for the stream named by X-Wisp-Client. */
  async message(req: IncomingMessage, res: ServerResponse, caller: C): Promise<void> {
    const client = req.headers['x-wisp-client'];
    const conn = typeof client === 'string' ? this.#o.sync.connOf(client) : undefined;
    const owner = conn === undefined ? undefined : this.#o.sync.callerOf(conn);
    if (conn === undefined || owner === undefined) return json(res, 404, { code: 'not_found', message: 'no open stream for this client' });
    if (!(this.#o.sameCaller ?? Object.is)(owner, caller)) return json(res, 403, { code: 'forbidden', message: 'not your stream' });
    const body = await readJson(req, this.#o.maxBodyBytes ?? 1 << 20);
    if (!body.ok) return json(res, body.status, body.error);
    for (const message of Array.isArray(body.value) ? body.value : [body.value]) this.input({ kind: 'message', conn, message });
    res.writeHead(202).end();
  }

  /** Ends every stream and the timer (the plugin's scope calls this on switch-off). */
  close(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    for (const res of this.#res.values()) res.end();
    this.#res.clear();
  }
}

type Run<C> = (cmd: string, args: unknown, call: { mid: string; caller: C }) => Promise<CommandResponse>;

const STATUS: Record<string, number> = { invalid: 400, forbidden: 403, not_found: 404, conflict: 409, vetoed: 409, unavailable: 503, timeout: 504 };

/** POST /api/cmd {cmd, args} with an Idempotency-Key: the HTTP fallback of `mutate` (plan §4.5). */
export async function command<C>(req: IncomingMessage, res: ServerResponse, caller: C, run: Run<C>, maxBodyBytes = 1 << 20): Promise<void> {
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || key === '' || key.length > 128) return fail(res, 'invalid', 'an Idempotency-Key header is required');
  const body = await readJson(req, maxBodyBytes);
  if (!body.ok) return json(res, body.status, { ok: false, error: body.error });
  const v = body.value as Partial<CommandRequest> | null;
  if (typeof v !== 'object' || v === null || typeof v.cmd !== 'string' || v.cmd === '') return fail(res, 'invalid', 'the body is {cmd, args}');
  let out: CommandResponse;
  try {
    out = await run(v.cmd, v.args, { mid: key, caller });
  } catch (err) {
    out = { ok: false, error: { code: 'internal', message: err instanceof Error ? err.message : String(err), retry: true } };
  }
  json(res, out.ok ? 200 : (STATUS[out.error.code] ?? 500), out);
}

function fail(res: ServerResponse, code: string, message: string): void {
  json(res, STATUS[code] ?? 400, { ok: false, error: { code, message } });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) }).end(text);
}

type Body = { ok: true; value: unknown } | { ok: false; status: number; error: { code: string; message: string } };

async function readJson(req: IncomingMessage, max: number): Promise<Body> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = chunk as Buffer;
    size += b.length;
    if (size > max) return { ok: false, status: 413, error: { code: 'invalid', message: `the body is over ${max} bytes` } };
    chunks.push(b);
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  } catch {
    return { ok: false, status: 400, error: { code: 'invalid', message: 'the body is not JSON' } };
  }
}
