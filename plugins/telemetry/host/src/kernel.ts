// The kernel services this plugin uses, typed as the edge implements them (apps/server/src/services/
// basic.ts, apps/server/src/http/router.ts and edge.ts). @wisp/kernel doesn't export these shapes yet;
// once it does, this file re-exports them. They are structural, so the edge's objects fit unchanged.
// definePlugin is local for the same reason: the kernel index doesn't export one.
import type { Caller, Disposable, Json, PluginDef } from '@wisp/kernel';

export const definePlugin = <T extends PluginDef>(d: T): T => d;

/** HTTP out (`net`): the global fetch with a timeout. */
export interface NetService {
  fetch(url: string, init?: RequestInit & { timeoutMs?: number }): Promise<Response>;
}

/** `paths`: ~/.wisp, or WISP_HOME. */
export interface PathsService {
  readonly home: string;
  dir(...parts: string[]): string;
}

/**
 * `app`: what this wisp is. Asked of the edge in the report (it isn't a kernel service yet): the
 * published version, the folder wisp-agents is installed in, the port it listens on.
 */
export interface AppService {
  readonly version: string;
  readonly root: string;
  port(): number;
  /** stop everything and exit (an update relaunches the new copy once the port frees up) */
  shutdown(code?: number): void;
}

/** A kernel service, or undefined when this install has none by that name. */
export function maybeService<T>(ctx: { service<S>(name: string): S }, name: string): T | undefined {
  try {
    return ctx.service<T>(name);
  } catch {
    return undefined;
  }
}

export interface RouteOptions {
  permission: string;
  doc?: boolean;
  summary?: string;
}

export interface HttpRequestContext {
  readonly method: string;
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly caller: Caller;
  /** the JSON body, {} when empty */
  body(): Promise<unknown>;
}

export interface HttpResult {
  status: number;
  json: Json;
}

export type Handler = (c: HttpRequestContext) => Promise<HttpResult> | HttpResult;

/** `http`: routes under /api (patterns without the prefix); the edge checks `permission` first. */
export interface HttpService {
  route(method: string, pattern: string, handler: Handler, opts: RouteOptions): Disposable;
}

const CODE: Readonly<Record<number, string>> = { 400: 'invalid', 403: 'forbidden', 404: 'not_found', 409: 'conflict' };

/** v1's `bad(message, status)`: the edge answers `status` with `{ error: message }`. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  /** the status again, so it survives the kernel's dispatch (which keeps code, message and details) */
  readonly details: { status: number };
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = CODE[status] ?? (status >= 500 ? 'internal' : 'invalid');
    this.details = { status };
  }
}

export const bad = (message: string, status = 400): HttpError => new HttpError(message, status);

/** The JSON body as a record ({} for anything else). */
export const record = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Fields set to undefined dropped: what JSON.stringify would send anyway, typed as Json. */
export function compact(o: Record<string, Json | undefined>): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
}
