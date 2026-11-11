import { expect, test } from 'vitest';
import { handoffTargets, limitTarget, vendorOf } from '../src/cards/vendors.ts';

test('a_refused_turn_goes_only_to_a_harness_on_another_vendors_model_with_that_model_pinned', () => {
  expect([vendorOf('claude-sonnet-4.5', 'copilot'), vendorOf('openrouter/openai/gpt-5', 'opencode'), vendorOf('o4-mini', 'x'), vendorOf('opus', 'x'), vendorOf('gemini-3-pro', 'x'), vendorOf('', 'grok'), vendorOf('default', 'claude'), vendorOf('', 'copilot')]).toEqual(['anthropic', 'openai', 'openai', 'anthropic', 'google', 'xai', 'anthropic', '']);
  const agents = [
    { id: 'claude', available: true },
    { id: 'copilot', available: true, models: [{ id: 'claude-sonnet-4.5' }, { id: 'gpt-5' }] },
    { id: 'opencode', available: true, models: [{ id: 'anthropic/claude-opus' }] },
    { id: 'codex', available: false },
    { id: 'grok', available: true },
    { id: 'wisp', available: true },
  ];
  // a Claude refusal: Copilot pinned to gpt-5 (its default could be Claude), never opencode (only Claude), never
  // codex (not set up), grok on its own vendor
  expect(handoffTargets({ from: 'claude', agents })).toEqual([
    { agent: 'copilot', model: 'gpt-5', vendor: 'openai' },
    { agent: 'grok', model: '', vendor: 'xai' },
  ]);
  // a configured model counts first; max caps the list
  expect(handoffTargets({ from: 'claude', agents, models: { copilot: 'gemini-3-pro' }, max: 1 })).toEqual([{ agent: 'copilot', model: 'gemini-3-pro', vendor: 'google' }]);
  // the refusing vendor unknown: a target still needs a known one
  expect(handoffTargets({ from: 'copilot', agents: [{ id: 'opencode', available: true }, { id: 'codex', available: true }] })).toEqual([{ agent: 'codex', model: '', vendor: 'openai' }]);
  // the limit card: the first other harness that's set up
  expect(limitTarget('claude', agents)?.agent).toBe('copilot');
  expect(limitTarget('claude', [{ id: 'claude', available: true }])).toBeUndefined();
});
