// The kernel services this plugin uses, as the structural slices it needs (plan §6.1: `ctx.service`).
// Typed here rather than imported so the plugin states exactly what it relies on; the kernel's
// http and proc services satisfy them.

export interface Req {
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly caller: { set: string; session?: string };
  body(): Promise<unknown>;
  /** node's IncomingMessage and ServerResponse, for the event streams */
  readonly raw: { req: unknown; res: unknown };
}

export type Result = { status: number; json: unknown } | { stream: true };
export type Handler = (c: Req) => Promise<Result> | Result;

export interface Http {
  route(method: string, pattern: string, handler: Handler, opts: { permission: string; summary?: string }): { dispose(): void };
}

/** A body as an object, whatever was sent (v1 routes read missing fields as undefined). */
export const asObj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export const json = (status: number, body: unknown): Result => ({ status, json: body });

/** The node response an SSE route writes to, as far as a Sink needs it. */
interface NodeRes {
  writeHead(status: number, headers: Record<string, string>): unknown;
  write(s: string): unknown;
  end(s?: string): unknown;
  on(ev: 'close', fn: () => void): unknown;
}

const isNodeRes = (v: unknown): v is NodeRes => typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>)['writeHead'] === 'function';

/** Open an event stream on the raw response, as v1 did (no proxy buffering, no cache). */
export function sseSink(raw: { res: unknown }): { write(s: string): void; end(s?: string): void; onClose(fn: () => void): void } {
  if (!isNodeRes(raw.res)) throw new Error('an event stream needs the raw response');
  const res = raw.res;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  return { write: (s) => void res.write(s), end: (s) => void res.end(s), onClose: (fn) => void res.on('close', fn) };
}
