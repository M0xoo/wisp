// Small text helpers every channel uses (v1 server/util.js: truncate, bad).

/** At most n characters, the last one an ellipsis when it was cut. */
export const truncate = (s: unknown, n: number): string => {
  const t = String(s || '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export type WireCode = 'invalid' | 'forbidden' | 'not_found' | 'unavailable';

/** An error with an HTTP status and the wire's code: what a route answers and a channel says. */
export interface StatusError extends Error {
  status: number;
  code: WireCode;
}

const codeOf = (status: number): WireCode => (status === 400 ? 'invalid' : status === 403 ? 'forbidden' : status === 404 ? 'not_found' : 'unavailable');

/** v1's bad(): a refusal with its status. Returned, so callers write `throw bad(…)`. */
export const bad = (msg: string, status = 400): StatusError => Object.assign(new Error(msg), { status, code: codeOf(status) });

/** The message of anything thrown. */
export const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The HTTP status an error carries, if any. */
export const statusOf = (err: unknown): number | undefined => {
  const s = typeof err === 'object' && err !== null ? (err as { status?: unknown }).status : undefined;
  return typeof s === 'number' ? s : undefined;
};
