// A stream-json `result` line → the turn's result event (v1 adapters/claude.js resultEvent,
// compactedResult, notCompacted and the early-result rule).

import { num, rec, str } from '@wisp/harness-kit';
import type { HarnessEvent, HarnessStats } from '@wisp-plugin/runtime-api';

export type Result = Extract<HarnessEvent, { type: 'result' }> & { stats: HarnessStats };
type Msg = Record<string, unknown>;

/** "38k", "1.2M": a token count in words (v1 web/js/receipt.js tokenWords). */
export function tokenWords(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}

/**
 * A failed sign-in can end with is_error false (subtype success, zero API time), which would read as
 * a finished task. Only when no model answered: a real API duration is the agent's own answer,
 * whatever it says, and the words alone never count there.
 */
const unanswered = (msg: Msg, authFailed: string, signedOut: (t: string) => boolean): boolean => {
  const api = num(msg['duration_api_ms']);
  return !(api !== undefined && api > 0) && (!!authFailed || (api === 0 && signedOut(str(msg['result']))));
};

const put = (stats: HarnessStats, key: string, v: unknown): void => {
  if (v !== undefined) stats[key] = v;
};

export function resultEvent(msg: Msg, authFailed: string, signedOut: (t: string) => boolean): Result {
  const usage = rec(msg['usage']);
  const stats: HarnessStats = {};
  put(stats, 'costUsd', msg['total_cost_usd']);
  put(stats, 'durationMs', msg['duration_ms']);
  put(stats, 'turns', msg['num_turns']);
  put(stats, 'inputTokens', usage['input_tokens']);
  put(stats, 'outputTokens', usage['output_tokens']);
  // Not in inputTokens (Anthropic counts them apart): the turn's receipt adds them up.
  if (num(usage['cache_read_input_tokens']) !== undefined) stats.cacheReadTokens = usage['cache_read_input_tokens'] as number;
  if (num(usage['cache_creation_input_tokens']) !== undefined) stats.cacheWriteTokens = usage['cache_creation_input_tokens'] as number;
  const subtype = msg['subtype'];
  return {
    type: 'result',
    text: str(msg['result']) || authFailed,
    isError: !!msg['is_error'] || (!!subtype && subtype !== 'success') || unanswered(msg, authFailed, signedOut),
    ...(authFailed && { authFailed: true }),
    ...(msg['stop_reason'] ? { stopReason: str(msg['stop_reason']) } : {}),
    stats,
  };
}

/** A compaction's result says nothing itself (result: ''): the boundary has the numbers. */
function compactedResult(ev: Result, boundary: Msg): void {
  const pre = num(boundary['pre_tokens']);
  const post = num(boundary['post_tokens']);
  const known = pre !== undefined && post !== undefined;
  ev.stats['compact'] = known ? { pre, post } : {};
  if (!ev.text.trim()) ev.text = known ? `Compacted from ${tokenWords(pre)} to ${tokenWords(post)} tokens.` : 'Compacted.';
}

/** stats.compact.none: nothing shrank, so the context stays as it was (contextTokens stays unset). */
function notCompacted(ev: Result, error: string | undefined): void {
  ev.stats['compact'] = { none: true };
  ev.text = error || ev.text.trim() || 'Nothing was compacted.';
}

export interface TurnContext {
  contextTokens: number;
  cacheTtlMs: number;
  compacted: boolean;
  boundary: Msg | null;
  unshrunk: { error: string } | null;
}

/**
 * Whether this result ends the turn, finishing `ev` when it does. On --resume, background tasks the
 * last run left behind come back as a task notification queued ahead of our prompt. The CLI answers
 * it with an empty, zero-turn result, then goes on to the prompt and reports a second result. Ending
 * the turn on the first one would drop the real answer, so it's held ('early') in case it's all we
 * get. A compaction reports the same empty, zero-turn result, and that one is final: it never goes on
 * to a prompt. A boundary or local_command says which one this is.
 */
export function finalResult(ev: Result, msg: Msg, turn: TurnContext): 'early' | 'final' {
  const local = msg['local_command'] === 'compact';
  if (!ev.isError && !ev.text.trim() && !msg['num_turns'] && !turn.boundary && !local && !turn.unshrunk) return 'early';
  // A turn that auto-compacted on its way has a boundary too: that one is an ordinary answer.
  if (!ev.isError && turn.boundary && (local || !msg['num_turns'])) compactedResult(ev, turn.boundary);
  // A /compact that didn't: "Not enough messages to compact." ends in success with no boundary.
  else if (!ev.isError && (local || (turn.unshrunk && !ev.text.trim()))) notCompacted(ev, turn.unshrunk?.error);
  if (turn.contextTokens || turn.compacted) ev.stats['contextTokens'] = turn.contextTokens;
  if (turn.cacheTtlMs) ev.stats['cacheTtlMs'] = turn.cacheTtlMs;
  // One process can report several results.
  Object.assign(turn, { contextTokens: 0, cacheTtlMs: 0, compacted: false, boundary: null, unshrunk: null });
  return 'final';
}
