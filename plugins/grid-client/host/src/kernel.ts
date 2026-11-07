// The kernel services this plugin uses, as narrow structural types. @wisp/kernel's index (being built
// in parallel) will export the full ones; `ctx.service<T>(name)` takes any T, so only the members used
// here have to match. Swap these for `import type { … } from '@wisp/kernel'` once it exports them.

import type { Caller, Disposable, Json, PluginDef } from '@wisp/kernel';

export interface HttpRequestContext {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  caller: Caller;
  body(): Promise<unknown>;
}
export type HttpResult = { status: number; json: unknown };
export interface RouteOptions {
  permission: string;
  summary?: string;
}
export interface HttpService {
  route(method: string, pattern: string, handler: (c: HttpRequestContext) => Promise<HttpResult> | HttpResult, opts: RouteOptions): Disposable;
  /** this wisp's own address ('http://127.0.0.1:<port>'): the tunnel hands its streams there */
  readonly url: string;
}

export interface SecretsService {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface NotifyService {
  notice(kind: string, data: Json): void;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}
export interface Child {
  readonly pid: number;
  onStdout(fn: (chunk: Uint8Array) => void): Disposable;
  onStderr(fn: (chunk: Uint8Array) => void): Disposable;
  write(data: string): void;
  kill(signal?: string): void;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
}
export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: 'pipe' | 'ignore';
  /** on a terminal of its own (wisp-native's PTY): `claude setup-token` only prints its link there */
  pty?: { cols: number; rows: number };
  /** keeps running after this process (an apt restore in a sandbox) */
  detached?: boolean;
  /** stdout and stderr appended to this file instead of piped */
  logFile?: string;
}
export interface ProcService {
  which(bin: string): Promise<string | null>;
  exec(bin: string, args: readonly string[], opts?: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number; input?: string }): Promise<ExecResult>;
  spawn(bin: string, args: readonly string[], opts?: SpawnOptions): Child;
}

export interface PathsService {
  /** wisp's home (~/.wisp) */
  readonly home: string;
}

/** `definePlugin` from @wisp/kernel once its index exports it; the identity until then. */
export const definePlugin = <T extends PluginDef>(d: T): T => d;
