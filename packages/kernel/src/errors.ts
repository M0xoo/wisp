// The one error shape (plan §3.1 rule 8): whatever a plugin throws reaches the edge as a WireError.
import type { Json, WireError, WispErrorCode } from './contract.ts';

const RETRY: ReadonlySet<string> = new Set(['unavailable', 'timeout', 'service_gone', 'plugin_off']);

export class KernelError extends Error {
  readonly code: WispErrorCode | (string & {});
  readonly retry: boolean;
  readonly details: Json | undefined;
  constructor(code: WispErrorCode | (string & {}), message: string, details?: Json, retry?: boolean) {
    super(message);
    this.name = 'KernelError';
    this.code = code;
    this.retry = retry ?? RETRY.has(code);
    this.details = details;
  }
  toWire(): WireError {
    return { code: this.code, message: this.message, retry: this.retry, ...(this.details !== undefined && { details: this.details }) };
  }
}

export const fail = (code: WispErrorCode | (string & {}), message: string, details?: Json): KernelError => new KernelError(code, message, details);

function isWireLike(e: unknown): e is { code: string; message: string; retry?: unknown; details?: Json } {
  if (typeof e !== 'object' || e === null) return false;
  const o = e as Record<string, unknown>;
  return typeof o['code'] === 'string' && typeof o['message'] === 'string';
}

/** Anything thrown, as a KernelError: ours pass through, `{code, message}` keeps its code, the rest is `internal`. */
export function toKernelError(e: unknown): KernelError {
  if (e instanceof KernelError) return e;
  if (isWireLike(e)) return new KernelError(e.code, e.message, e.details, typeof e.retry === 'boolean' ? e.retry : undefined);
  if (e instanceof Error) return new KernelError('internal', e.message);
  return new KernelError('internal', String(e));
}

export const toWireError = (e: unknown): WireError => toKernelError(e).toWire();
