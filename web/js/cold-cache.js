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

// Compact now: a large warm Claude task can shrink before its cache lapses, so the next reply reads
// a summary instead of the whole conversation. One click, never by itself.
export const COMPACT_MIN = 200_000;
// Estimates, from reports/2026-11-05-rerank23: the summary writes about 20k output, the next turn
// writes about 30k to the cache.
const COMPACT_OUTPUT = 20_000;
const COMPACT_WRITE = 30_000;
// USD per million tokens, API list, by the main thread's model: input, cache read, output.
const PRICES = {
  'claude-opus-5-5': [4, 0.2, 20],
  'claude-sonnet-5-5': [2, 0.2, 10],
  'claude-fable-5-1': [10, 0.25, 50],
  'claude-fable-5': [10, 0.25, 50],
};
const WRITE_1H = 2; // a cache write, as a multiple of input
const WRITE_5M = 1.25;

export const bareModel = (id) => String(id || '').replace(/\[1m\]$/i, '').replace(/-\d{8}$/, '');

// The model the main thread ran on: stats.models has its subagents' too, and most output doesn't
// say which is which. A context this large is the main thread's, so it's the one that read most.
export function mainModel(st) {
  const subs = new Set((st?.subagents || []).filter((x) => !x.same && x.model).map((x) => bareModel(x.model)));
  const read = (m) => (m.input || 0) + (m.cacheRead || 0) + (m.cacheWrite || 0);
  return (st?.models || []).map((m) => ({ id: bareModel(m.model), read: read(m) })).filter((m) => !subs.has(m.id)).sort((a, b) => b.read - a.read)[0]?.id || '';
}

// When the offer ends: the TTL, not the cold line's coldAt. 17 of 38 caches were already gone at
// 60-75 min, and compacting a dead cache reads the whole conversation at the price it's meant to save.
export function compactUntil(s, at = Date.now()) {
  const c = coldCache(s, at);
  return c ? c.coldAt - c.ttlMs * (GRACE - 1) : 0;
}

// { tokens, compact, cold } when this task can be compacted now, or null. compact and cold are the
// USD estimates of compacting now and of the same reply after the cache lapses; null on a model
// with no price here, which shows tokens only.
export function compactOffer(s, at = Date.now()) {
  if (s?.agent !== 'claude' || s.sideOf || s.parentId || s.delegated || s.relay || s.kind || s.tui) return null; // the relay doesn't carry by: 'compact'
  const c = coldCache(s, at);
  if (!c || c.tokens < COMPACT_MIN || at >= compactUntil(s, at)) return null;
  const turns = s.turns;
  const last = turns.at(-1);
  if (last.limit || last.stats?.compact?.none) return null; // a limited session can't compact; one that just failed won't now
  const price = PRICES[mainModel(turns.findLast((t) => t.stats?.contextTokens && t.stats.cacheTtlMs).stats)];
  if (!price) return { tokens: c.tokens, compact: null, cold: null };
  const [input, read, output] = price;
  const write = input * (c.ttlMs > 300_000 ? WRITE_1H : WRITE_5M);
  return { tokens: c.tokens, compact: (c.tokens * read + COMPACT_OUTPUT * output + COMPACT_WRITE * write) / 1e6, cold: (c.tokens * write) / 1e6 };
}

const about = (tokens) => tokenWords(Math.round(tokens / 10_000) * 10_000); // 483214 → "480k"

export const coldLine = (tokens) => `Cache gone cold: this reply re-reads about ${about(tokens)}`;
// When the bar can't hold coldLine: the number is the point, so this form keeps it.
export const coldLineShort = (tokens) => `Cache cold: re-reads about ${about(tokens)}`;
const usd = (x) => `$${x.toFixed(2)}`;
// Beside Compact now: both prices, or the size alone on a model with no price here.
export const compactNote = (o) => (o.compact == null ? `About ${about(o.tokens)} tokens` : `About ${usd(o.compact)} now, ${usd(o.cold)} once the cache is cold`);
// Their tooltip: the note stays short, and on a plan those dollars are only a comparison.
export const compactTip = (o) => `Shrinks this conversation to a summary, so the next reply reads that instead.${o.compact == null ? '' : ' Estimates at API list prices. On a plan you pay no dollars: it counts against your usage window.'}`;
export const coldLineAhead = (tokens) => `Cache will have gone cold by then: this reply re-reads about ${about(tokens)}`;
export const coldLineMaybe = (tokens) => `Cache may have gone cold by then: if so, this reply re-reads about ${about(tokens)}`;

// The usage-limit card's line for a reply at the reset, or ''. GRACE doesn't hold here: of 3 tasks
// that woke at a reset, 2 went cold inside a 1h TTL (34 and 55 min), so inside it the card says may.
// Already cold, the reply box says so (coldReply) and the card doesn't say it twice.
export function limitColdLine(s, until, now = Date.now()) {
  const c = coldCache(s, until);
  if (!c || now >= c.coldAt) return '';
  return c.cold ? coldLineAhead(c.tokens) : coldLineMaybe(c.tokens);
}
