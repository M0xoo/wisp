// A session row as the list reads it. The server's row keeps its hot columns at the top (`id`, `title`,
// `state`, `updated_at`…), the rest in `body`, and the list's own view in `summary` (camelCase: `status`,
// `preview`, `updatedAt`, `queued`, `held`…). The list's `Session` is that summary, so the three are
// flattened: body, then the columns, then the summary on top. One flat row per server row, kept while
// the row is unchanged, so memoised sections and keyed rows stay put.

import type { Plan, SessionRow } from '../types.ts';

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
  // whose crew job it is: the crew's note in `ext` (CrewExt), read as v1's `crew`
  const job = obj(obj(out['ext'])?.['wisp.crew']);
  if (job && typeof job['id'] === 'string' && out['crew'] === undefined) out['crew'] = { id: job['id'], ...(typeof job['job'] === 'string' && { job: job['job'] }) };
  const flat = out as unknown as SessionRow;
  cache.set(raw, flat);
  return flat;
}

/** wisp.later's topic: its plans (`later_plan`) and the follow-ups on tasks. */
export const LATER_TOPIC = 'plugin:wisp.later:later';

/** A task or reminder that hasn't started, as wisp.later keeps it (`later_plan` rows: `{id, body}`). */
interface LaterPlan {
  readonly id?: string;
  readonly kind?: string;
  readonly at?: number | null;
  readonly setAt?: number;
  readonly draft?: boolean;
  readonly title?: string;
  readonly text?: string;
  readonly body?: { readonly prompt?: string; readonly agent?: string; readonly cwd?: string } | null;
}

/** A `later_plan` row as the list draws it: Scheduled (a time, or after a task) or Drafts. */
export function listPlan(row: unknown): Plan | undefined {
  const r = row as { readonly id?: string; readonly body?: LaterPlan } | undefined;
  const p: LaterPlan | undefined = r?.body && typeof r.body === 'object' && 'kind' in r.body ? r.body : (r as LaterPlan | undefined);
  const id = p?.id ?? r?.id;
  if (!p || !id) return undefined;
  const task = p.kind !== 'reminder';
  const title = (task ? (p.title ?? (p.body?.prompt ?? '').split('\n')[0]) : p.text) ?? '';
  const cwd = p.body?.cwd ?? '';
  const project = cwd.split('/').filter(Boolean).pop();
  return { id, kind: p.draft ? 'draft' : task ? 'task' : 'reminder', title, at: p.at ?? p.setAt ?? 0, ...(p.body?.agent && { agent: p.body.agent }), ...(project && { project }) };
}
