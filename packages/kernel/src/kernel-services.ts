// Kernel services (plan §6.1): interfaces injected into plugins through `ctx.service(name)`. An
// install may override any of them: the grid swaps `proc` for a gVisor spawner, tests swap `clock`
// and `proc` for simulated ones. Plugins never spawn processes or open HTTP listeners themselves:
// `tools/check` refuses `node:child_process`, `node:http(s)`/`node:net` servers and global `fetch`
// in plugins/*/host. Plain file I/O through node:fs is allowed; it is the same on every install.

import type { Disposable, Json } from './contract.ts';

// ---------- proc: every child process wisp starts ----------

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** a PTY of this size instead of pipes (wisp-native, or the Python fallback) */
  pty?: { cols: number; rows: number };
  /** kill the whole tree when the owning scope ends (default true) */
  tree?: boolean;
  stdin?: 'pipe' | 'ignore';
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface Child {
  readonly pid: number;
  onStdout(fn: (chunk: Uint8Array) => void): Disposable;
  onStderr(fn: (chunk: Uint8Array) => void): Disposable;
  write(data: string | Uint8Array): void;
  closeStdin(): void;
  resize(cols: number, rows: number): void;
  kill(signal?: 'SIGTERM' | 'SIGKILL' | 'SIGINT'): void;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ProcService {
  /** resolves `bin` on PATH (Windows .cmd shims included), as v1's resolveCommand did */
  which(bin: string, env?: Record<string, string | undefined>): Promise<string | null>;
  spawn(bin: string, args: readonly string[], opts?: SpawnOptions): Child;
  /** run to completion, never blocking the event loop */
  exec(bin: string, args: readonly string[], opts?: SpawnOptions & { input?: string; maxBuffer?: number }): Promise<ExecResult>;
}

// ---------- http: the server's edge ----------

export interface HttpRequestContext {
  readonly method: string;
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  /** who is asking: decides the capability set (ADR-0008) */
  readonly caller: { set: string; session?: string };
  body(): Promise<unknown>;
  rawBody(): Promise<Uint8Array>;
  /** the underlying node objects, only for streaming routes (SSE, proxies, uploads) */
  readonly raw: { req: unknown; res: unknown };
}

export type HttpResult =
  | { status: number; json: Json | unknown; headers?: Record<string, string> }
  | { status: number; text: string; type?: string; headers?: Record<string, string> }
  | { status: number; bytes: Uint8Array; type: string; headers?: Record<string, string> }
  | { stream: true }; // the handler answered through `raw` itself

export interface RouteOptions {
  /** false: not public API, left out of OpenAPI on purpose */
  doc?: boolean;
  /** the permission a caller's capability set must hold (default deny) */
  permission: string;
  summary?: string;
  /** narrows a pattern further: a route whose `when` says no is skipped */
  when?: (params: Readonly<Record<string, string>>) => boolean;
}

export interface HttpService {
  /** `route('GET', '/sessions/:id', …)`; patterns are under /api, matched by whole segments */
  route(method: string | readonly string[], pattern: string, handler: (ctx: HttpRequestContext) => Promise<HttpResult> | HttpResult, opts: RouteOptions): Disposable;
  /** routes outside /api (hooks, webhooks, previews): the full path pattern */
  raw(method: string | readonly string[], pattern: string, handler: (ctx: HttpRequestContext) => Promise<HttpResult> | HttpResult, opts: RouteOptions): Disposable;
  readonly url: string; // http://127.0.0.1:<port>
}

// ---------- secrets, notify, net ----------

export interface SecretsService {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix?: string): Promise<string[]>;
}

export interface NotifyService {
  /** a notice to every client (toast, finished, reminder): carried as a `notice` frame */
  notice(kind: string, data: Json): void;
}

export interface NetService {
  fetch(url: string, init?: RequestInit & { timeoutMs?: number }): Promise<Response>;
}

// ---------- paths ----------

export interface PathsService {
  /** ~/.wisp, or WISP_HOME */
  readonly home: string;
  /** a folder this plugin owns under home (`<home>/plugins/<id>` unless the plugin maps a v1 path) */
  dir(...parts: string[]): string;
}

export const SERVICE_NAMES = ['store', 'proc', 'http', 'secrets', 'notify', 'net', 'paths', 'blob'] as const;
export type ServiceName = (typeof SERVICE_NAMES)[number];
