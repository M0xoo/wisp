// A task's usage in its details (frame/task-usage.ts, v1 #785 TRY-16; v1 test/task-usage.test.js's scenarios).
import { expect, test } from 'vitest';
import { contextWords, modelWords, planWords, rowUsage, taskUsage, tokensOf, usageSections } from '../src/frame/task-usage.ts';
import { SHELL_STRINGS } from '../src/i18n/en.ts';

const cat = SHELL_STRINGS as Readonly<Record<string, string>>;
const t = (k: string, v?: Readonly<Record<string, string | number>>): string => (cat[k] ?? k).replace(/\{(\w+)\}/g, (_, w: string) => String(v?.[w] ?? ''));

test('the_details_line_says_the_plan_share_with_the_subagents_then_the_context_v1_785', () => {
  // the server summed the lead's share with its same-plan subagent's (usage.plan)
  const u = rowUsage({ tokens: 900_000, plan: { seven_day: 0.04, five_hour: 0.18 }, usage: { tokens: 1_200_000, plan: { seven_day: 0.06, five_hour: 0.21 } }, context: { tokens: 124_000, window: 200_000 } });
  expect(planWords(u, t)).toBe('6% of weekly · 21% of 5-hour');
  expect(contextWords(u.context, t)).toBe('62% context');
  // no plan traced (a harness that doesn't report windows): the tokens stand in, the subagents' in them
  expect(planWords(rowUsage({ tokens: 900_000, usage: { tokens: 1_200_000 } }), t)).toBe('1.2M tokens');
  // nothing measured: nothing to say
  expect(taskUsage(rowUsage({}), () => [], t, () => undefined, () => undefined)).toBeUndefined();
});

test('the_context_line_says_compacted_and_the_tokens_when_the_window_is_unknown_v1_785', () => {
  expect(contextWords({ tokens: 0, window: 200_000 }, t)).toBe('Compacted');
  expect(contextWords({ tokens: 124_000, window: 0 }, t)).toBe('124k context');
  const u = taskUsage(rowUsage({ context: { tokens: 170_000, window: 200_000 } }), () => [], t, () => undefined, () => undefined);
  expect(u?.plan).toBeUndefined();
  expect(u?.context).toMatchObject({ text: '85% context', share: 0.85, hi: true });
  // a foreign shape reads as nothing
  expect(rowUsage({ context: 'full', subUsage: 'x', plan: [1] })).toEqual({});
});

test('the_card_says_the_tasks_tokens_the_plan_split_the_context_and_each_subagent_v1_785', () => {
  const opened: string[] = [];
  const u = rowUsage({
    tokens: 15_700,
    plan: { seven_day: 0.04 },
    usage: { tokens: 55_700, plan: { seven_day: 0.05 } },
    context: { tokens: 50_000, window: 200_000 },
    subUsage: [
      { id: 'k1', name: 'tester', title: 'Write the tests', agent: 'claude', tokens: 40_000, plan: { seven_day: 0.01 } },
      { id: 'c1', name: 'reviewer', title: 'Review', agent: 'codex', tokens: 0, samePlan: false },
    ],
  });
  const models = { 'claude-opus-5-5': { input: 1000, cacheRead: 9000, cacheWrite: 0, output: 500 } };
  const turns = [{ inputTokens: 1000, cacheTokens: 9000, outputTokens: 500, models }, { inputTokens: 500, cacheTokens: 4500, outputTokens: 200, models: { 'claude-opus-5-5': { input: 500, cacheRead: 4500, output: 200 } } }, undefined];
  const [mine, plan, context, inTurns, subs] = usageSections(u, turns, t, (id) => opened.push(id));
  expect(inTurns?.rows).toEqual([]);
  expect(mine?.rows.map((r) => [r.label, r.value])).toEqual([
    ['Tokens, subagents in', '56k'],
    ['Read', '15k'],
    ['From the cache', '90%'],
    ['Written', '700'],
    ['Turns', '2'],
  ]);
  expect(plan?.rows.map((r) => [r.label, r.value, r.title])).toEqual([['Of weekly', '5%', '4% by the task, 1% by its subagents']]);
  expect(context?.rows[0]).toMatchObject({ label: 'In use', value: '50k of 200k', bar: { share: 0.25, hi: false } });
  expect(subs?.rows.map((r) => [r.label, r.value])).toEqual([
    ['tester', '40k · 1% of weekly'],
    ['reviewer', '—'],
  ]);
  expect(subs?.rows[1]?.title).toContain('another plan');
  subs?.rows[0]?.onOpen?.();
  expect(opened).toEqual(['k1']);
});

test('a_turns_reads_and_writes_folded_together_give_no_cache_share_v1_785', () => {
  // runtime folds cache reads and writes into cacheTokens when a harness gives no per-model counts
  expect(tokensOf([{ inputTokens: 100, cacheTokens: 900, outputTokens: 50 }])).toEqual({ read: 1000, cached: null, output: 50, turns: 1 });
  expect(tokensOf([])).toEqual({ read: 0, cached: null, output: 0, turns: 0 });
  // per-model counts below the usage total: the usage total is the turn's, and its cache share isn't known
  expect(tokensOf([{ inputTokens: 100, cacheTokens: 900, outputTokens: 50, models: { m: { input: 10, cacheRead: 90, output: 5 } } }]).cached).toBeNull();
});

test('the_card_lists_claude_codes_own_subagents_by_type_as_v1_785', () => {
  // the row's `agents`: runtime's fold of each turn's stats.subagents, by type and model, most output first
  const u = rowUsage({
    tokens: 15_700,
    agents: [
      { type: 'Explore', model: 'claude-haiku-5-5', calls: 3, output: 400 },
      { type: 'web-fetch', model: 'claude-opus-5-5[1m]', calls: 1, output: 0 },
      { type: 'Plan', calls: 1, output: 12_000 },
      { type: '', calls: 2 },
      { type: 'Bad', calls: 0 },
    ],
  });
  expect(u.agents).toHaveLength(3);
  const [, , , inTurns] = usageSections(u, [], t, () => undefined);
  expect(inTurns?.title).toBe('Subagents in its turns');
  expect(inTurns?.rows.map((r) => [r.label, r.value])).toEqual([
    ['3 Explore agents · Haiku 5.5', '400 out'],
    ['1 web-fetch agent · Opus 5.5 (1M)', '—'],
    ['1 Plan agent', '12k out'],
  ]);
  expect(inTurns?.rows[0]?.title).toBe('Ran inside the task’s turns: their tokens are in the task’s');
  expect(inTurns?.rows[0]?.onOpen).toBeUndefined();
  expect(modelWords('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
  expect(modelWords('sonnet')).toBe('Sonnet');
  expect(rowUsage({ agents: 'x' }).agents).toBeUndefined();
});
