// Small helpers shared by the automations host: the error the kernel maps to the wire, ids, modes.

import { randomUUID } from 'node:crypto';
import type { Json } from '@wisp/kernel';
import type { Mode } from '@wisp-plugin/automations-api';

/** `{code, message}` is what the kernel puts on the wire; `status` is what v1's HTTP routes answered. */
export class PluginError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: 'invalid' | 'not_found' | 'conflict' | 'forbidden' | 'unavailable', message: string) {
    super(message);
    this.code = code;
    this.status = { invalid: 400, not_found: 404, conflict: 409, forbidden: 403, unavailable: 503 }[code];
  }
}

/** v1 `bad(msg)`: a refusal the caller reads. */
export const bad = (message: string): PluginError => new PluginError('invalid', message);

export const MODES: ReadonlySet<string> = new Set(['plan', 'edits', 'auto']);
export const isMode = (m: unknown): m is Mode => typeof m === 'string' && MODES.has(m);

/** v1 newId: 12 hex characters. */
export const newId = (): string => randomUUID().replace(/-/g, '').slice(0, 12);

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** plain JSON for a row or the wire (drops undefined, functions) */
export const json = <T>(v: T): Json => JSON.parse(JSON.stringify(v ?? null)) as Json;

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
