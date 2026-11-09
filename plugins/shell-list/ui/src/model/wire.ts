// A session row as the list reads it. The server's row keeps its hot columns at the top (`id`, `title`,
// `state`, `updated_at`…), the rest in `body`, and the list's own view in `summary` (camelCase: `status`,
// `preview`, `updatedAt`, `queued`, `held`…). The list's `Session` is that summary, so the three are
// flattened: body, then the columns, then the summary on top. One flat row per server row, kept while
// the row is unchanged, so memoised sections and keyed rows stay put.

import type { SessionRow } from '../types.ts';

const cache = new WeakMap<object, SessionRow>();

const camel = (k: string): string => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

export function flatSession(raw: SessionRow): SessionRow;
export function flatSession(raw: SessionRow | undefined): SessionRow | undefined;
export function flatSession(raw: SessionRow | undefined): SessionRow | undefined {
  const top = obj(raw);
  if (!raw || !top) return raw;
  const body = obj(top['body']);
  const summary = obj(top['summary']);
  // a row already flat (the tests' fixtures, an optimistic patch) is its own
  if (!body && !summary) return raw;
  const had = cache.get(raw);
  if (had) return had;
  const out: Record<string, unknown> = { ...body };
  for (const [k, v] of Object.entries(top)) if (k !== 'body' && k !== 'summary') out[camel(k)] = v;
  Object.assign(out, summary);
  const flat = out as unknown as SessionRow;
  cache.set(raw, flat);
  return flat;
}
