// The pure rules of budget's windows (v1 test/budget.test.js, its pure cases): the pace, the stop
// line per harness, the hold's words, an early reset, units of work, the tool set's hash, the median.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { median } from '../src/receipt.ts';
import { sha1Hex, toolSet } from '../src/tools.ts';
import { drainWhy, holdWhy, paceOf, resetEarly, stopAtOf, stopFor, unattended, unitsOf } from '../src/windows.ts';

const H = 3600_000;

test('pace: when the window runs out at the rate since it started, if before the reset', () => {
  const now = 1_000 * H;
  // 5-hour window, 3 h in, 72% gone: 100% about 1 h 10 min from now, before the reset in 2 h.
  const hit = paceOf({ used: 0.72, resetsAt: now + 2 * H, ms: 5 * H }, now);
  assert.equal(Math.round(((hit ?? 0) - now) / 60_000), 70);
  assert.equal(paceOf({ used: 0.3, resetsAt: now + 2 * H, ms: 5 * H }, now), null, 'lasts past the reset');
  assert.equal(paceOf({ used: 0.5, resetsAt: now + 4.9 * H, ms: 5 * H }, now), null, 'too early to tell');
  assert.equal(paceOf({ used: 1, resetsAt: now + H, ms: 5 * H }, now), null, 'already used up');
  assert.equal(paceOf({ used: 0.5, resetsAt: now - 1, ms: 5 * H }, now), null, 'reset already');
});

test('Automations stop at: fixed choices, and the hold in words', () => {
  assert.equal(stopAtOf('off'), null);
  assert.equal(stopAtOf('75'), 0.75);
  assert.equal(stopAtOf('80'), null, 'only the choices Settings offers');
  const h = { label: 'Weekly', used: 0.9, stop: 0.75 };
  assert.equal(holdWhy(h, 'Claude Code'), 'Claude Code’s weekly window is at 90%, past your 75%');
  assert.equal(holdWhy(h, 'Claude Code', 'Work'), 'Claude Code (Work)’s weekly window is at 90%, past your 75%');
});

test('a harness’s own Automations stop at line: same (or unset) follows autoStop, anything else wins', () => {
  assert.equal(stopFor({ autoStop: '75' }, 'claude'), 0.75);
  assert.equal(stopFor({ autoStop: '75', autoStopClaude: 'same' }, 'claude'), 0.75);
  assert.equal(stopFor({ autoStop: '75', autoStopCodex: '50' }, 'codex'), 0.5);
  assert.equal(stopFor({ autoStop: '75', autoStopCodex: 'off' }, 'codex'), null, 'off for Codex only');
  assert.equal(stopFor({ autoStop: '75', autoStopCodex: 'off' }, 'claude'), 0.75);
  assert.equal(stopFor({ autoStop: 'off', autoStopCodex: '90' }, 'codex'), 0.9);
  assert.equal(stopFor({ autoStop: '75', autoStopCodex: '80' }, 'codex'), 0.75, 'not a choice: the row above');
  assert.equal(stopFor({ autoStop: '50' }, 'opencode'), 0.5, 'a harness without its own row');
});

test('an early reset: much less used and a new period, before the old reset; Codex’s drift alone isn’t one', () => {
  const now = 1_000 * H;
  const was = { used: 0.8, resetsAt: now + 3 * 24 * H };
  assert.equal(resetEarly(was, { used: 0.02, resetsAt: now + 7 * 24 * H }, now), true, 'a banked reset');
  assert.equal(resetEarly(was, { used: 0.5, resetsAt: now + 7 * 24 * H }, now), true, '30 points back');
  assert.equal(resetEarly(was, { used: 0.02, resetsAt: was.resetsAt + 2 * 60_000 }, now), false, 'drift of a few minutes');
  assert.equal(resetEarly(was, { used: 0.7, resetsAt: now + 7 * 24 * H }, now), false, 'barely lower');
  assert.equal(resetEarly({ used: 0.8, resetsAt: now - H }, { used: 0, resetsAt: now + 7 * 24 * H }, now), false, 'its reset had passed: the normal roll');
  assert.equal(resetEarly({ used: 0.03, resetsAt: now + H }, { used: 0, resetsAt: now + 6 * H }, now), false, 'nothing was used to begin with');
  assert.equal(resetEarly(undefined, { used: 0, resetsAt: now + H }, now), false);
});

test('units of work: the cost where the harness says it, else tokens in millions; a baseline is none', () => {
  assert.equal(unitsOf({ costUsd: 0.4, inputTokens: 9e6 }), 0.4);
  assert.equal(unitsOf({ inputTokens: 2e6, cachedInputTokens: 1e6, outputTokens: 5e5 }), 1.5);
  assert.equal(unitsOf({ costUsd: 3, baseline: true }), 0);
  assert.equal(unitsOf(null), 0);
});

test('Drain watch’s words for the phone, and who counts as nobody by hand', () => {
  const d = { since: Date.UTC(2026, 0, 1, 14, 5), label: 'Weekly', runs: 2, du: 0.06, units: 2, ratio: 3, failed: { runs: 1, du: 0.03 } };
  assert.match(drainWhy(d, 'Claude Code', '', 'claude'), /2 runs took 6% of Claude Code’s weekly window for \$2\.00 of work: 3\.0× its usual share .*1 of them ended in an error and still took 3%/);
  assert.match(drainWhy({ ...d, units: 0.05 }, 'Codex', 'Work', 'codex'), /of Codex \(Work\)’s weekly window for 0\.05M tokens of work/);
  assert.deepEqual([undefined, 'user', 'channel', 'compact', 'later', 'crew', 'trigger', 'goal', 'agent'].map((by) => unattended(by)), [false, false, false, false, false, true, true, true, true]);
});

test('toolSet: sorted, deduped, wisp’s own MCP tools left out; a repeat keeps only the hash', () => {
  const a = toolSet(['WebFetch', 'Read', 'Read', 'mcp__wisp__ask_user', 'mcp__github__create_issue']);
  assert.deepEqual(a.list, ['Read', 'WebFetch', 'mcp__github__create_issue']);
  assert.match(a.hash, /^[0-9a-f]{12}$/);
  assert.equal(toolSet(['Read', 'mcp__github__create_issue', 'WebFetch', 'mcp__wisp__delegate']).hash, a.hash, 'order and wisp tools don’t move the hash');
  assert.notEqual(toolSet(['Read']).hash, a.hash);
  assert.deepEqual(toolSet(['WebFetch', 'Read', 'mcp__github__create_issue'], [a.hash]), { hash: a.hash });
});

test('the tool set’s hash is v1’s: SHA-1, the same digits node:crypto gives', () => {
  for (const s of ['', 'a', 'Read\nWebFetch\nmcp__github__create_issue', 'é→✓'.repeat(40), 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'x'.repeat(1000)]) {
    assert.equal(sha1Hex(s), createHash('sha1').update(s).digest('hex'), JSON.stringify(s.slice(0, 20)));
  }
});

test('median: the middle one, or the mean of the two in the middle', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), 0);
});
