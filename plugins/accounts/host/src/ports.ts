// The kernel services this plugin uses, as the structural slices it needs (plan §6.1: `ctx.service`).
// Typed here rather than imported so the plugin states exactly what it relies on; the kernel's proc,
// http and paths services satisfy them. Plus the small helpers every module here shares.

import { fail, type Scope } from '@wisp/kernel';

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export interface Child {
  readonly pid: number;
  onStdout(fn: (chunk: Uint8Array) => void): { dispose(): void };
  onStderr(fn: (chunk: Uint8Array) => void): { dispose(): void };
  write(data: string | Uint8Array): void;
  closeStdin(): void;
  kill(signal?: string): void;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
}

/** The proc service: every child process goes through it (AGENTS.md). */
export interface Proc {
  exec(bin: string, args: readonly string[], opts?: { cwd?: string; env?: Record<string, string | undefined>; input?: string; timeoutMs?: number }): Promise<ExecResult>;
  spawn(bin: string, args: readonly string[], opts?: { cwd?: string; env?: Record<string, string | undefined>; stdin?: 'pipe' }): Child;
}

export interface Req {
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly caller: { set: string; session?: string };
  body(): Promise<unknown>;
}
export type Result = { status: number; json: unknown };
export type Handler = (c: Req) => Promise<Result> | Result;
export interface Http {
  route(method: string, pattern: string, handler: Handler, opts: { permission: string; summary?: string }): { dispose(): void };
}

/** wisp's own folder (~/.wisp): accounts.json and the accounts/ login folders live in it. */
export interface Paths {
  readonly home: string;
}

/** wisp.telemetry's service, the one method used (telemetry.service@1; optional). */
export interface Telemetry {
  track(event: string, props?: Record<string, string | number | boolean | undefined>): void;
}
export const TELEMETRY = { id: 'telemetry.service', major: 1, permissions: { track: 'telemetry:track' } } as const;

/** What the plugin reads from the machine: the server's env, the user's home, the OS. */
export interface Machine {
  env: Record<string, string | undefined>;
  userHome: string;
  platform: string;
}

/** Cancellable timers owned by a scope: the kernel's scope.timeout can't be cancelled, a child scope can. */
export type Later = (ms: number, fn: () => void) => () => void;
export function laterIn(scope: Scope): Later {
  return (ms, fn) => {
    const s = scope.child('timer');
    s.timeout(ms, () => {
      s.dispose();
      fn();
    });
    return () => s.dispose();
  };
}

const CODE_OF: Readonly<Record<number, string>> = { 400: 'invalid', 404: 'not_found', 409: 'conflict', 502: 'unavailable' };

/** v1's `bad(msg, status)`: an error the route answers with that status and `{ error: msg }`. */
export const bad = (message: string, status = 400): Error => fail(CODE_OF[status] ?? 'invalid', message, { status });

const STATUS_OF: Readonly<Record<string, number>> = { invalid: 400, not_found: 404, forbidden: 403, conflict: 409, vetoed: 409, unavailable: 503 };

/** The HTTP status a thrown error stands for: the one bad() named, else its code's. */
export function statusOf(e: unknown): number {
  const o = rec(e);
  const s = rec(o['details'])['status'];
  if (typeof s === 'number') return s;
  return STATUS_OF[typeof o['code'] === 'string' ? o['code'] : ''] ?? 500;
}

export const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
export const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(rec(e)['message'] ?? e));

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][A-Z0-9]|\r/g;
/** A CLI's output without its colours, links and carriage returns. */
export const clean = (s: string): string => s.replace(ANSI, '');

/** Single-quote for a POSIX shell (v1 shq.js). */
export const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
