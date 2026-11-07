// Small helpers the runtime shares (v1 server/util.js, the parts the runtime used).

import { randomBytes } from 'node:crypto';

/**
 * A new id: 32 hex characters, the first 12 the creation time in ms, so ids sort by time and append
 * to the B-tree (plan §4.1). Hex only, so v1's mention and route patterns (`[a-z0-9]{6,40}`) match.
 * v1 ids (12 hex characters) import unchanged.
 */
export function newId(now: number = Date.now()): string {
  return Math.floor(now).toString(16).padStart(12, '0').slice(-12) + randomBytes(10).toString('hex');
}

/** A short id for queue items and asks (v1 newId: 12 hex characters). */
export const shortId = (): string => randomBytes(6).toString('hex');

/** One line, at most n characters. */
export function clip(s: unknown, n = 80): string {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** At most n characters, newlines kept. */
export const truncate = (s: unknown, n: number): string => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** What a failure's hero says: the error's first line. The rest stays in its terminal block. */
export const firstLine = (text: unknown): string => clip(String(text ?? '').split('\n').find((l) => l.trim()) ?? '', 200);

/**
 * The runtime's error: `{code, message, retry}` on the wire (the kernel passes a code through), and
 * the HTTP status v1 answered with, for the v1 route adapters.
 */
export class RuntimeError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retry: boolean;
  readonly details: Record<string, unknown> | undefined;
  constructor(message: string, status = 400, details?: Record<string, unknown>) {
    super(message);
    this.name = 'RuntimeError';
    this.status = status;
    this.code = CODES[status] ?? 'invalid';
    this.retry = status === 429 || status === 503;
    this.details = details;
  }
}

const CODES: Record<number, string> = { 400: 'invalid', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 429: 'unavailable', 503: 'unavailable' };

/** v1 bad(): an error the HTTP layer answers with `status` and its message. */
export const bad = (message: string, status = 400, details?: Record<string, unknown>): RuntimeError => new RuntimeError(message, status, details);

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v));
