// Where a turn's tokens went (the receipt). As claude 2.1.316 streams it (captured): result.modelUsage
// has the tokens per model, subagents' and side calls' included, and adds up over every result of
// the process (a background task's wake-up result holds the first one's too), so each result keeps
// only what's new since the last. result.usage is the main thread's alone. Subagents: each Agent (or
// Task) call, or task_started, gives its subagent_type; the messages carrying its id as
// parent_tool_use_id give their model and what they read. Their output_tokens are a snapshot from
// the stream's start (1 for a whole answer), so a model's output comes from modelUsage: what that
// model wrote minus the main thread's usage (when it's the main thread's model), shared among the
// subagents on it by their messages' counts. An Agent result that carries its own usage
// (tool_use_result.usage) wins. A web-fetch agent on a run whose init had no WebFetch (Claude Code's
// tengu_clever_orbit experiment, CC#106743) is marked `instead: 'WebFetch'`.

import { num, rec, str } from '@wisp/harness-kit';

/** Subagents on Haiku (Settings → Usage, subagentModel): '' is the task's own model. */
export const SUBAGENT_MODELS = ['', 'haiku', 'sonnet'] as const;

export interface ModelTokens {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const n0 = (x: unknown): number => {
  const v = num(x);
  return v !== undefined && v > 0 ? v : 0;
};
const MODEL_KEYS = { input: 'inputTokens', output: 'outputTokens', cacheRead: 'cacheReadInputTokens', cacheWrite: 'cacheCreationInputTokens' } as const;
type Key = keyof typeof MODEL_KEYS;
const KEYS = Object.keys(MODEL_KEYS) as Key[];

/** → per model, most output first, what's new since `prev` (the last result's modelUsage), or undefined. */
export function modelsOf(modelUsage: unknown, prev?: unknown): ModelTokens[] | undefined {
  if (!modelUsage || typeof modelUsage !== 'object') return undefined;
  const was = rec(prev);
  const list = Object.entries(rec(modelUsage))
    .map(([model, u]) => {
      const e: ModelTokens = { model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      for (const k of KEYS) e[k] = Math.max(0, n0(rec(u)[MODEL_KEYS[k]]) - n0(rec(was[model])[MODEL_KEYS[k]]));
      return e;
    })
    .filter((m) => m.input + m.output + m.cacheRead + m.cacheWrite > 0)
    .sort((a, b) => b.output - a.output);
  return list.length ? list : undefined;
}

/** A modelsOf list back in modelUsage's shape, for modelsOf's prev. */
export const modelUsageOf = (list: readonly ModelTokens[] | undefined): Record<string, Record<string, number>> | undefined =>
  list && Object.fromEntries(list.map((m) => [m.model, Object.fromEntries(KEYS.map((k) => [MODEL_KEYS[k], m[k]]))]));

/** The counters a conversation had after its last turn (stats.totals). */
export interface Counted {
  costUsd: number;
  models?: ModelTokens[] | undefined;
}

export function asCounted(v: unknown): Counted | null {
  const r = rec(v);
  const cost = num(r['costUsd']);
  if (cost === undefined) return null;
  const models = Array.isArray(r['models']) ? (r['models'] as unknown[]).map(rec).map((m) => ({ model: str(m['model']), input: n0(m['input']), output: n0(m['output']), cacheRead: n0(m['cacheRead']), cacheWrite: n0(m['cacheWrite']) })) : undefined;
  return { costUsd: cost, ...(models && { models }) };
}

/**
 * On --resume the CLI starts from the conversation's saved counters: total_cost_usd and modelUsage
 * hold its earlier runs too, while usage is this run's alone. It can also start from zero (another
 * account's login folder), so prior (the last turn's stats.totals) counts only when the counters
 * grew by at least what this run's main thread wrote.
 */
export function restoredFrom(msg: Record<string, unknown>, prior: Counted | null): boolean {
  const total = num(msg['total_cost_usd']);
  if (!prior || !(total !== undefined && total >= prior.costUsd)) return false;
  const now = Object.values(rec(msg['modelUsage'])).reduce<number>((a, u) => a + n0(rec(u)['outputTokens']), 0);
  const was = (prior.models ?? []).reduce((a, m) => a + n0(m.output), 0);
  return now - was >= n0(rec(msg['usage'])['output_tokens']);
}

/**
 * The counters this process started from, from its first result, or null: it started from zero.
 * unknownPrior: a chat that ran elsewhere (bring-in). Its counters hold all it ever spent and the
 * chat can't be read to learn how much, so that first result is the baseline: one turn undercounts,
 * rather than a whole conversation overcounting on one turn.
 */
export function countedFrom(msg: Record<string, unknown>, prior: Counted | null, unknownPrior = false): Counted | null {
  if (restoredFrom(msg, prior)) return prior;
  const total = num(msg['total_cost_usd']);
  return unknownPrior && !prior && total !== undefined ? { costUsd: total, models: modelsOf(msg['modelUsage']) } : null;
}

export const costSince = (msg: Record<string, unknown>, counted: Counted): number => Math.max(0, Math.round(((num(msg['total_cost_usd']) ?? Number.NaN) - counted.costUsd) * 1e7) / 1e7);

export interface SubagentRow {
  type: string;
  calls: number;
  read: number;
  output: number;
  model: string;
  same?: true;
  instead?: 'WebFetch';
}

export { subagentTally } from './subagents.ts';
