// The cold-cache line: before a reply to a large idle task, say the provider's prompt cache has
// lapsed and how much the reply reads back. Only ever words: nothing here holds, asks or pauses a
// send. DOM-free and shared, like limit-hold.js. Harness-agnostic: it reads only a turn's stats, so
// a harness that doesn't report cacheTtlMs (Codex, every one but Claude today) never shows the line.

import { tokenWords } from './receipt.js';

// Tokens, not a share of the window: the line names a re-read worth deciding on. At or just under
// the median cold write (99k on the owner's own transcripts, 119k in 1,169 follow-ups, against 1-6k warm) and above where a
// fresh task starts, so small tasks stay quiet.
export const LARGE = 100_000;

// The cache outlives its TTL: in 1,500 transcripts, by gap since the last request, a 1h cache was
// still alive in 21 of 38 cases at 60-75 min, and in 0 of 52 past 75 min. The TTL alone over-claims.
export const GRACE = 1.25;

// { tokens, ttlMs, coldAt, cold } for a task idle with a known context, or null. Returned warm too
// (cold: false): a caller can read coldAt.
export function coldCache(s, at = Date.now()) {
  if (!s?.agentSessionId || s.tui || s.state === 'running' || s.ask) return null; // no session: the reply starts fresh
  const turns = s.turns || [];
  if (turns.some((t) => t.status === 'running' || t.status === 'held')) return null;
  const from = turns.findLastIndex((t) => t.stats?.contextTokens && t.stats.cacheTtlMs);
  if (from < 0) return null;
  const [numbered, ...later] = turns.slice(from);
  // A later turn that worked without a number moved the context on: don't guess. One that did no
  // work (a limit hit on its first request, a stop) changed nothing, unless it compacted: that
  // reports contextTokens 0, whatever its output, and the task just shrank.
  if (later.some((t) => t.stats?.outputTokens > 0 || t.stats?.contextTokens === 0)) return null;
  const ended = [numbered, ...later].filter((t) => t.endedAt);
  if (!ended.length) return null;
  const agentOf = (t) => t.agent || s.agent;
  if (agentOf(numbered) !== s.agent || agentOf(ended.at(-1)) !== s.agent) return null;
  const { contextTokens: tokens, cacheTtlMs: ttlMs } = numbered.stats;
  if (tokens < LARGE) return null;
  // Any ended turn may have refreshed the cache, even one that did no work.
  const coldAt = Math.max(...ended.map((t) => t.endedAt)) + ttlMs * GRACE;
  return { tokens, ttlMs, coldAt, cold: at >= coldAt };
}

// The same object when it's cold and the reply stays here, else null. run: the reply's own runner
// (S.replyRunners), moving: it goes to another place, terminal: the task is open in a terminal, where
// the turns don't show when the cache was last used. A reply elsewhere re-reads nothing here. Another
// model on the same agent and account stays: it's this conversation that reads back.
export function coldReply(s, { run, moving, terminal } = {}, at = Date.now()) {
  if (moving || terminal) return null;
  if (run && (run.agent !== s?.agent || (run.account || '') !== (s?.account || ''))) return null;
  const c = coldCache(s, at);
  return c?.cold ? c : null;
}

const about = (tokens) => tokenWords(Math.round(tokens / 10_000) * 10_000); // 483214 → "480k"

export const coldLine = (tokens) => `Cache gone cold: this reply re-reads about ${about(tokens)}`;
// When the bar can't hold coldLine: the number is the point, so this form keeps it.
export const coldLineShort = (tokens) => `Cache cold: re-reads about ${about(tokens)}`;
export const coldLineAhead = (tokens) => `Cache will have gone cold by then: this reply re-reads about ${about(tokens)}`;
