import { expect, test } from 'vitest';
import { effortsFor, harnessesFor, modelsFor, runnerWords, type AgentOffer } from '../src/frame/runner.ts';

const AGENTS: AgentOffer[] = [
  { id: 'codex', name: 'Codex', available: true, models: [{ id: 'gpt-5.5', label: 'GPT-5.5' }], efforts: ['low', 'high'] },
  { id: 'cursor', name: 'Cursor', available: false, models: [], efforts: [] },
  { id: 'claude', name: 'Claude Code', available: true, models: [{ id: 'opus', label: 'Opus 5.5', efforts: ['low', 'medium', 'high', 'max'] }, { id: 'haiku', label: 'Haiku 5.5' }], efforts: ['low', 'high'] },
];

test('the_harness_model_picker_searches_every_harnesses_models_and_offers_the_picks_thinking_levels', () => {
  // set up ones first; a model's name finds its harness
  expect(harnessesFor(AGENTS, '').map((a) => a.id)).toEqual(['codex', 'claude', 'cursor']);
  expect(harnessesFor(AGENTS, 'opus').map((a) => a.id)).toEqual(['claude']);
  // the Default first; a query narrows, the harness's own name keeps them all
  expect(modelsFor(AGENTS, 'claude', '').map((m) => m.id)).toEqual(['', 'opus', 'haiku']);
  expect(modelsFor(AGENTS, 'claude', 'hai').map((m) => m.id)).toEqual(['haiku']);
  expect(modelsFor(AGENTS, 'claude', 'claude').length).toBe(3);
  expect(modelsFor(AGENTS, 'nope', '')).toEqual([]);
  // a model's own levels, else the harness's
  expect(effortsFor(AGENTS, { agent: 'claude', model: 'opus', effort: '' })).toEqual(['low', 'medium', 'high', 'max']);
  expect(effortsFor(AGENTS, { agent: 'claude', model: 'haiku', effort: '' })).toEqual(['low', 'high']);
  expect(runnerWords(AGENTS, { agent: 'claude', model: 'opus', effort: 'high' }, (id) => (id === 'claude' ? 'Claude Code' : id))).toBe('Claude Code · Opus 5.5 · high');
});
