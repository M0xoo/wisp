// F-page-13 (v1 receipt.js subagentParts / subagentTip, 0.57.0): Claude Code ran subagents: the trail says which and
// where the tokens went, by model.
import { expect, test } from 'vitest';
import en from '../src/i18n/en.cards.json';
import { agentsOf } from '../src/cards/agents.ts';

const t = (k: string, v?: Readonly<Record<string, string | number>>): string => ((en as Record<string, string>)[k] ?? k).replace(/\{(\w+)\}/g, (_, x: string) => String(v?.[x] ?? ''));

test('a_turn_whose_claude_ran_subagents_says_which_and_the_tokens_by_model_v1_0_57', () => {
  const stats = {
    outputTokens: 14_000,
    models: { 'claude-opus-5-5': { input: 1200, output: 14_000, cacheRead: 900_000, cacheWrite: 40_000 }, 'claude-haiku-4-5': { input: 300, output: 27_000, cacheRead: 200_000 } },
    subagents: [
      { type: 'Explore', calls: 3, read: 200_300, output: 27_000, model: 'claude-haiku-4-5' },
      { type: 'general-purpose', calls: 1, read: 5000 },
    ],
  };
  const a = agentsOf(stats, t);
  expect(a?.parts).toEqual(['3 Explore agents', 'Haiku 4.5', '27k of 41k output']);
  expect(a?.tip).toBe(
    'Subagents: 3 Explore agents on Haiku 4.5: 27k of 41k output tokens, 200k read; 1 general-purpose agent: 5k read. By model: Haiku 4.5 27k out / 200k in, Opus 5.5 14k out / 941k in',
  );
  // no subagent ran: nothing beside the receipt
  expect(agentsOf({ outputTokens: 10, models: stats.models }, t)).toBeNull();
  expect(agentsOf(null, t)).toBeNull();
  // its output not known apart from the main thread's: the type and model, no share
  expect(agentsOf({ subagents: [{ type: 'Plan', calls: 1, read: 10 }] }, t)?.parts).toEqual(['1 Plan agent']);
});
