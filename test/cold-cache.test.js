// The cold-cache line (web/js/cold-cache.js): which tasks get it, from which turn, and when.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { coldCache, coldLine, coldLineAhead, coldLineShort, coldReply, GRACE, LARGE, limitColdLine } = await import('../web/js/cold-cache.js');

const H = 3_600_000;
const M = 60_000;
const T0 = 1_800_000_000_000;

const stats = (contextTokens, cacheTtlMs = H, extra = {}) => ({ inputTokens: 10, outputTokens: 500, cacheReadTokens: 8_800_000, contextTokens, cacheTtlMs, ...extra });
const turn = (st, extra = {}) => ({ status: 'done', agent: 'claude', endedAt: T0, stats: st, ...extra });
const task = (turns, extra = {}) => ({ agent: 'claude', agentSessionId: 'sess-1', state: 'review', turns, ...extra });
const big = () => task([turn(stats(480_000))]);

test('the constants say what was measured', () => {
  assert.equal(LARGE, 100_000);
  assert.equal(GRACE, 1.25);
});

test('a task under the threshold says nothing: 99,999 no, 100,000 yes', () => {
  assert.equal(coldCache(task([turn(stats(99_999))]), T0 + 9 * H), null);
  assert.equal(coldCache(task([turn(stats(100_000))]), T0 + 9 * H).tokens, 100_000);
});

test('1h: warm just under coldAt, cold at it, and TTL alone is not enough', () => {
  const coldAt = T0 + H * GRACE;
  const r = coldCache(big(), coldAt - 1);
  assert.deepEqual(r, { tokens: 480_000, ttlMs: H, coldAt, cold: false });
  assert.equal(coldCache(big(), coldAt).cold, true);
  assert.equal(coldCache(big(), T0 + H).cold, false, 'at the TTL itself it may well be alive (21 of 38)');
  assert.equal(coldCache(big(), T0 + 75 * M).cold, true, 'past 75 min: 0 of 52');
});

test('5m: warm just under coldAt, cold at it', () => {
  const s = task([turn(stats(200_000, 5 * M))]);
  const coldAt = T0 + 5 * M * GRACE;
  assert.equal(coldCache(s, coldAt - 1).cold, false);
  assert.equal(coldCache(s, coldAt).cold, true);
  assert.equal(coldCache(s, coldAt).ttlMs, 5 * M);
});

test('the object comes back warm too, so a caller can schedule on coldAt', () => {
  assert.equal(typeof coldCache(big(), T0).coldAt, 'number');
  assert.equal(coldCache(big(), T0).cold, false);
});

test('at defaults to now', () => {
  assert.equal(coldCache(task([turn(stats(480_000), { endedAt: Date.now() - 2 * H })])).cold, true);
  assert.equal(coldCache(task([turn(stats(480_000), { endedAt: Date.now() })])).cold, false);
});

test('unknown TTL: no line, even with a context size', () => {
  const st = stats(480_000);
  delete st.cacheTtlMs;
  assert.equal(coldCache(task([turn(st)]), T0 + 9 * H), null);
});

test('Codex-shaped stats never show it: nothing reports cacheTtlMs', () => {
  const st = { inputTokens: 480_000, cachedInputTokens: 400_000, outputTokens: 900, totals: { thread: 'x' } };
  assert.equal(coldCache(task([turn(st, { agent: 'codex' })], { agent: 'codex' }), T0 + 9 * H), null);
});

test('no turns, no stats, no task', () => {
  assert.equal(coldCache(null), null);
  assert.equal(coldCache(undefined), null);
  assert.equal(coldCache(task([]), T0), null);
  assert.equal(coldCache({ agent: 'claude', agentSessionId: 'x', state: 'review' }, T0), null);
  assert.equal(coldCache(task([turn(null)]), T0), null);
});

test('a later turn that worked but has no number: the number is stale, no guess', () => {
  const later = { inputTokens: 5, outputTokens: 40 };
  assert.equal(coldCache(task([turn(stats(480_000)), turn(later, { endedAt: T0 + H })]), T0 + 9 * H), null);
  // Context without a TTL is no number either (a turn that wrote nothing to the cache).
  assert.equal(coldCache(task([turn(stats(480_000)), turn({ outputTokens: 40, contextTokens: 500_000 }, { endedAt: T0 + H })]), T0 + 9 * H), null);
});

test('a later turn that ended on a compact reports 0: the older number is gone, with no output too', () => {
  for (const outputTokens of [0, 40]) {
    const s = task([turn(stats(480_000)), turn({ outputTokens, contextTokens: 0, cacheTtlMs: H }, { endedAt: T0 + H })]);
    assert.equal(coldCache(s, T0 + 9 * H), null);
  }
  assert.equal(coldCache(task([turn({ outputTokens: 0, contextTokens: 0 })]), T0 + 9 * H), null, 'on its own: no number');
});

test('the latest number wins', () => {
  const s = task([turn(stats(480_000)), turn(stats(600_000, 5 * M), { endedAt: T0 + H })]);
  const r = coldCache(s, T0 + 9 * H);
  assert.equal(r.tokens, 600_000);
  assert.equal(r.ttlMs, 5 * M);
  assert.equal(r.coldAt, T0 + H + 5 * M * GRACE);
});

test('a limit hit on the first request keeps the older number', () => {
  for (const later of [null, undefined, { outputTokens: 0, inputTokens: 0 }]) {
    const s = task([turn(stats(480_000)), turn(later, { status: 'error', limit: { until: T0 + 5 * H }, endedAt: T0 + 2 * M })]);
    assert.equal(coldCache(s, T0 + 9 * H).tokens, 480_000);
  }
});

test('a stopped later turn keeps the number and moves the clock: it may have refreshed the cache', () => {
  const s = task([turn(stats(480_000)), turn(null, { status: 'stopped', endedAt: T0 + 30 * M })]);
  const r = coldCache(s, T0 + 9 * H);
  assert.equal(r.tokens, 480_000);
  assert.equal(r.coldAt, T0 + 30 * M + H * GRACE);
});

test('the clock is the latest endedAt from the number’s turn on, not simply the last turn’s', () => {
  const s = task([turn(stats(480_000)), turn(null, { status: 'stopped', endedAt: T0 + 30 * M }), turn(null, { status: 'error', endedAt: T0 + 10 * M }), turn(null, { status: 'stopped', endedAt: null })]);
  assert.equal(coldCache(s, T0).coldAt, T0 + 30 * M + H * GRACE);
});

test('a number with no ended turn has no clock', () => {
  assert.equal(coldCache(task([turn(stats(480_000), { endedAt: null })]), T0 + 9 * H), null);
});

test('handed to another agent: the reply re-reads nothing here', () => {
  // The task moved on and nothing ran there yet: the number's turn isn't the task's agent.
  assert.equal(coldCache(task([turn(stats(480_000))], { agent: 'codex' }), T0 + 9 * H), null);
  // The latest ended turn was another agent's, that did no work, and the task came back.
  assert.equal(coldCache(task([turn(stats(480_000)), turn(null, { agent: 'codex', status: 'stopped', endedAt: T0 + M })]), T0 + 9 * H), null);
  // A turn with no agent of its own is the task's.
  assert.equal(coldCache(task([turn(stats(480_000), { agent: undefined })]), T0 + 9 * H).tokens, 480_000);
});

test('no agentSessionId: the reply starts fresh, nothing is re-read', () => {
  assert.equal(coldCache(task([turn(stats(480_000))], { agentSessionId: null }), T0 + 9 * H), null);
});

test('terminal session, running, held and asking tasks say nothing', () => {
  const at = T0 + 9 * H;
  assert.equal(coldCache(task([turn(stats(480_000))], { tui: true }), at), null);
  assert.equal(coldCache(task([turn(stats(480_000))], { state: 'running' }), at), null);
  assert.equal(coldCache(task([turn(stats(480_000))], { ask: { id: 'a', question: 'Which?' } }), at), null);
  assert.equal(coldCache(task([turn(stats(480_000)), turn(null, { status: 'running', endedAt: null })]), at), null);
  assert.equal(coldCache(task([turn(stats(480_000)), turn(null, { status: 'held', endedAt: null })]), at), null);
  assert.equal(coldCache(task([turn(null, { status: 'held', endedAt: null }), turn(stats(480_000))]), at), null, 'any turn, not only the last');
});

test('coldReply: cold and staying here gives the coldCache object', () => {
  const at = T0 + 9 * H;
  assert.deepEqual(coldReply(big(), {}, at), coldCache(big(), at));
  assert.equal(coldReply(big(), {}, at).cold, true);
});

test('coldReply: warm, or nothing to say, is null', () => {
  assert.equal(coldReply(big(), {}, T0), null);
  assert.equal(coldReply(task([turn(stats(99_999))]), {}, T0 + 9 * H), null);
  assert.equal(coldReply(null, {}, T0 + 9 * H), null);
});

test('coldReply: a reply run on the same agent and account shows, whatever its model', () => {
  const at = T0 + 9 * H;
  assert.equal(coldReply(big(), { run: { agent: 'claude', account: '', model: 'haiku', effort: 'low' } }, at).tokens, 480_000);
  assert.equal(coldReply(big(), { run: { agent: 'claude' } }, at).tokens, 480_000, 'no account on either side');
  assert.equal(coldReply(task([turn(stats(480_000))], { account: 'work' }), { run: { agent: 'claude', account: 'work' } }, at).tokens, 480_000);
});

test('coldReply: a reply going elsewhere, or a task in a terminal, re-reads nothing here', () => {
  const at = T0 + 9 * H;
  assert.equal(coldReply(big(), { run: { agent: 'codex', account: '' } }, at), null, 'another agent');
  assert.equal(coldReply(big(), { run: { agent: 'claude', account: 'work' } }, at), null, 'another account');
  assert.equal(coldReply(task([turn(stats(480_000))], { account: 'work' }), { run: { agent: 'claude', account: '' } }, at), null, 'back to the default account');
  assert.equal(coldReply(big(), { moving: true }, at), null, 'another place');
  assert.equal(coldReply(big(), { terminal: true }, at), null, 'in a terminal');
});

test('the lines round to the nearest 10k first', () => {
  assert.equal(coldLine(483_214), 'Cache gone cold: this reply re-reads about 480k');
  assert.equal(coldLine(1_234_567), 'Cache gone cold: this reply re-reads about 1.2M');
  assert.equal(coldLine(100_000), 'Cache gone cold: this reply re-reads about 100k');
  assert.equal(coldLine(104_999), 'Cache gone cold: this reply re-reads about 100k');
  assert.equal(coldLine(105_000), 'Cache gone cold: this reply re-reads about 110k');
  assert.equal(coldLine(996_000), 'Cache gone cold: this reply re-reads about 1M');
  assert.equal(coldLineAhead(483_214), 'Cache will have gone cold by then: this reply re-reads about 480k');
  assert.equal(coldLineAhead(1_234_567), 'Cache will have gone cold by then: this reply re-reads about 1.2M');
});

test('the short form keeps the same rounded number', () => {
  assert.equal(coldLineShort(483_214), 'Cache cold: re-reads about 480k');
  assert.equal(coldLineShort(1_234_567), 'Cache cold: re-reads about 1.2M');
  assert.equal(coldLineShort(996_000), 'Cache cold: re-reads about 1M');
});

test('a phone: the line folds with the bar, not with .awake, so a kept draft stays still', () => {
  const css = fs.readFileSync(new URL('../web/css/split.css', import.meta.url), 'utf8');
  const fold = css.match(/^(body\.split\.stack #feed \.item\.open \.composer:not\(\.awake\)[^\n]*?) \.c-bar\b/m)?.[1];
  assert.ok(fold, 'the rule that folds the bar');
  assert.ok(css.includes(`${fold} > .c-hint:has(> .c-cold-row)`), 'the line folds on the same conditions');
});

// Tasks that woke at a reset went cold at 34 and 55 minutes of a 1h TTL: a stopped task's cache
// doesn't keep to the check above, so the card says so whatever the TTL says.
test('the limit card: inside the TTL it may have gone cold, past it it will have', () => {
  const coldAt = T0 + H * GRACE;
  assert.equal(limitColdLine(big(), T0 + 34 * M, T0 + M), 'Cache may have gone cold by then: if so, this reply re-reads about 480k');
  assert.equal(limitColdLine(big(), T0 + 2 * M, T0 + M), 'Cache may have gone cold by then: if so, this reply re-reads about 480k', 'however soon the reset');
  assert.equal(limitColdLine(big(), coldAt, T0 + M), 'Cache will have gone cold by then: this reply re-reads about 480k');
  assert.equal(limitColdLine(big(), T0 + 3 * H, T0 + M), coldLineAhead(480_000));
});

test('the limit card leaves a cache that has already gone cold to the reply box', () => {
  const coldAt = T0 + H * GRACE;
  assert.equal(limitColdLine(big(), T0 + 9 * H, coldAt - 1), coldLineAhead(480_000));
  assert.equal(limitColdLine(big(), T0 + 9 * H, coldAt), '');
  assert.equal(coldReply(big(), {}, coldAt).tokens, 480_000, 'the box has it');
});

test('the limit card stays quiet where the line never shows', () => {
  assert.equal(limitColdLine(task([turn(stats(99_999))]), T0 + 3 * H, T0 + M), '');
  assert.equal(limitColdLine(task([turn({ outputTokens: 40 })]), T0 + 3 * H, T0 + M), '');
});
