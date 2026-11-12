// A task's usage (TRY-16, web/js/task-usage.js): its tokens and plan share with its subagents', and
// how full its context is, from the CLI's own numbers only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextOf, contextShare, contextWords, lineParts, planWithSubs, taskUsage, tokensOf } from '../web/js/task-usage.js';
import { contextWindowOf } from '../server/adapters/claude.js';
import { summarize } from '../server/runner.js';

const turn = (stats, extra = {}) => ({ id: Math.random().toString(36).slice(2), status: 'done', stats, ...extra });

test('claude: the context window is the main thread’s model’s, from modelUsage', () => {
  const usage = { 'claude-opus-5-5': { inputTokens: 900, contextWindow: 1_000_000 }, 'claude-haiku-5-5': { inputTokens: 90_000, contextWindow: 200_000 } };
  assert.equal(contextWindowOf(usage, 'claude-opus-5-5'), 1_000_000, 'the init model, even when a subagent read more');
  assert.equal(contextWindowOf(usage, 'claude-opus-5-5[1m]'), 1_000_000, 'the [1m] suffix is the same model');
  assert.equal(contextWindowOf(usage, ''), 200_000, 'no init model: the model that read most');
  assert.equal(contextWindowOf({ 'claude-opus-5-5': { inputTokens: 1 } }, 'claude-opus-5-5'), 0, 'an old CLI without contextWindow: unknown');
  assert.equal(contextWindowOf(undefined, 'x'), 0);
});

test('the context is the newest measured turn’s, with the window of the turn that said it', () => {
  const turns = [turn({ contextTokens: 80_000, contextWindow: 200_000, outputTokens: 10 }), turn({ contextTokens: 124_000, outputTokens: 5 })];
  assert.deepEqual(contextOf(turns), { tokens: 124_000, window: 200_000 }, 'a turn without the window takes the one before');
  assert.equal(contextShare(contextOf(turns)), 0.62);
  assert.equal(contextWords(contextOf(turns)), '62% context');
  // A compaction says 0: the context is small again, not unknown.
  assert.deepEqual(contextOf([...turns, turn({ contextTokens: 0 })]), { tokens: 0, window: 200_000 });
  assert.equal(contextWords({ tokens: 0, window: 200_000 }), 'Compacted', 'not 0%: the summary’s size is unknown');
  // A later turn that worked without a number (another harness): no guess.
  assert.equal(contextOf([...turns, turn({ inputTokens: 900, outputTokens: 40 })]), null);
  // One still running doesn't count yet; one that did no work changes nothing.
  assert.deepEqual(contextOf([...turns, turn({}), { status: 'running' }]), { tokens: 124_000, window: 200_000 });
  assert.equal(contextWords({ tokens: 124_000, window: 0 }), '124k context', 'an unknown window says the tokens');
  assert.equal(contextOf([]), null);
});

test('the details line adds the subagents’ plan share to the task’s, then the context', () => {
  const s = { id: 'lead', plan: { seven_day: 0.04, five_hour: 0.18 }, tokens: 900_000, context: { tokens: 124_000, window: 200_000 } };
  const subs = [{ id: 'a', parentId: 'lead', plan: { seven_day: 0.02, five_hour: 0.03 }, tokens: 300_000 }];
  assert.deepEqual(planWithSubs(s, subs), { seven_day: 0.06, five_hour: 0.21 });
  assert.deepEqual(lineParts(s, subs), ['6% of weekly', '21% of 5-hour', '62% context'], 'longest window first');
  // No plan traced (a harness that doesn't report windows): the tokens stand in, the subagents' in them.
  assert.deepEqual(lineParts({ tokens: 900_000 }, [{ tokens: 300_000 }]), ['1.2M tokens']);
  assert.deepEqual(lineParts({}, []), [], 'nothing measured: nothing to say');
});

test('the whole of it: the task’s tokens, its CLI subagents by type, wisp’s by name', () => {
  const full = {
    turns: [
      turn({ inputTokens: 1000, cacheReadTokens: 9000, cacheWriteTokens: 0, outputTokens: 500, totals: {}, subagents: [{ type: 'Explore', calls: 2, model: 'claude-haiku-5-5', output: 300, read: 4000 }] }),
      turn({ inputTokens: 500, cacheReadTokens: 4500, outputTokens: 200, totals: {}, subagents: [{ type: 'Explore', calls: 1, model: 'claude-haiku-5-5', output: 100, read: 2000 }] }),
      { status: 'running' },
    ],
  };
  const s = { id: 'lead', plan: { seven_day: 0.04 }, context: { tokens: 50_000, window: 200_000 } };
  const subs = [{ id: 'k1', title: 'Write the tests', name: 'tester', tokens: 40_000, plan: { seven_day: 0.01 } }];
  const u = taskUsage(full, s, subs);
  assert.deepEqual(u.own, { read: 15_000, cached: 13_500, output: 700, tokens: 15_700, cache: 0.9 });
  assert.equal(u.tokens, 55_700, 'the subagents’ tasks counted in');
  assert.equal(u.subTokens, 40_000);
  assert.equal(u.turns, 2, 'the running turn has no numbers yet');
  assert.deepEqual(u.plan, [{ window: 'seven_day', used: 0.05, own: 0.04 }]);
  assert.deepEqual(u.agents, [{ type: 'Explore', model: 'claude-haiku-5-5', calls: 3, output: 400 }]);
  assert.deepEqual(u.subs, [{ id: 'k1', name: 'tester', title: 'Write the tests', tokens: 40_000, plan: [{ window: 'seven_day', used: 0.01 }] }]);
  assert.deepEqual(u.context, { tokens: 50_000, window: 200_000 });
  assert.deepEqual(tokensOf([]), { read: 0, cached: 0, output: 0 });
  // Before the task's turns load, the popover says what the line said.
  assert.equal(taskUsage(undefined, { tokens: 900 }, []).tokens, 900);
});

test('the task view carries its tokens and context, and nothing when nothing was measured', () => {
  const s = { id: 'x', title: 'T', agent: 'claude', cwd: '/tmp', state: 'review', turns: [turn({ inputTokens: 100, cacheReadTokens: 900, outputTokens: 50, contextTokens: 1000, contextWindow: 200_000 })], createdAt: 1, updatedAt: 1 };
  const v = summarize(s, null);
  assert.equal(v.tokens, 1050);
  assert.deepEqual(v.context, { tokens: 1000, window: 200_000 });
  const empty = summarize({ ...s, turns: [] }, null);
  assert.ok(!('tokens' in empty) && !('context' in empty));
  // A lead's wisp subagents aren't in the list: its view says what each took.
  const share = (agent, used) => ({ plan: [{ window: 'seven_day', used, agent, account: 'default' }] });
  const sub = { id: 'k', title: 'Tests', member: 'tester', parentId: 'x', agent: 'claude', cwd: '/tmp', state: 'done', turns: [turn({ inputTokens: 10, outputTokens: 5 }, share('claude', 0.02))] };
  const codex = { ...sub, id: 'c', member: 'reviewer', agent: 'codex', turns: [turn({ inputTokens: 20, outputTokens: 5 }, share('codex', 0.1))] };
  const other = { ...sub, id: 'o', parentId: 'y' };
  const store = { get: (id) => ({ k: sub, c: codex, o: other })[id], projectFor: () => null };
  const lead = summarize({ ...s, children: { tester: 'k', reviewer: 'c' }, turns: [...s.turns, turn({}, { delegations: [{ sessionId: 'o' }] })] }, store);
  assert.deepEqual(
    lead.subUsage,
    [
      { id: 'k', name: 'tester', title: 'Tests', agent: 'claude', tokens: 15, plan: { seven_day: 0.02 } },
      { id: 'c', name: 'reviewer', title: 'Tests', agent: 'codex', tokens: 25, plan: { seven_day: 0.1 }, samePlan: false },
    ],
    'only its own subagents; one on another harness is on another plan',
  );
  // The line adds only the share of the same plan: Codex's weekly isn't Claude's.
  assert.deepEqual(planWithSubs({ plan: { seven_day: 0.04 } }, lead.subUsage), { seven_day: 0.06 });
  assert.equal(summarize(sub, store).subUsage, undefined, 'a subagent has none');
});
