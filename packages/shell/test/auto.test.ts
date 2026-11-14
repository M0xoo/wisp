import { expect, test } from 'vitest';
import { autoPick, neverRule, overrideOf, popOf, routeOf, routeTip, shortLabel, type AutoPreview } from '../src/frame/auto.ts';

test('picking_your_own_harness_after_autos_preview_tells_auto_what_it_had_shown', () => {
  const p: AutoPreview = { pick: { agent: 'claude', model: 'sonnet', effort: 'high', key: 'claude:sonnet:high', label: 'Claude Code · Sonnet · High' }, type: 'bugfix', why: 'Balanced' };
  expect(autoPick(p)).toEqual({ agent: 'claude', label: 'Sonnet · High' });
  expect(autoPick({ pick: null, why: 'Nothing can run' })).toBeUndefined();
  // still on Auto, or the same pick: nothing to learn
  expect(overrideOf(p, { agent: 'auto', model: '' })).toBeUndefined();
  expect(overrideOf(p, { agent: 'claude', model: '' })).toBeUndefined();
  expect(overrideOf(p, { agent: 'claude', model: 'sonnet' })).toBeUndefined();
  // another harness, or another model on the same one
  expect(overrideOf(p, { agent: 'codex', model: '' })).toEqual({ key: 'claude:sonnet:high', type: 'bugfix' });
  expect(overrideOf(p, { agent: 'claude', model: 'opus' })).toEqual({ key: 'claude:sonnet:high', type: 'bugfix' });
  // no preview shown: nothing
  expect(overrideOf(undefined, { agent: 'codex', model: '' })).toBeUndefined();
  expect(overrideOf({ ...p, type: '' }, { agent: 'codex', model: '' })).toEqual({ key: 'claude:sonnet:high' });
});

const WORDS: Record<string, string> = {
  'shell.auto.goal.balanced': 'Balanced',
  'shell.auto.goal.best': 'Best',
  'shell.auto.head': 'Auto · {goal} → {label}',
  'shell.auto.previewed': ', as previewed',
  'shell.auto.record': '{pct}% on your {type} tasks ({n})',
  'shell.auto.expected': '{pct}% expected on {type} tasks',
  'shell.auto.usd': '~${usd}',
  'shell.auto.suggest': 'worth trying {label}',
};
const say = (k: string, v?: Readonly<Record<string, string | number>>): string => (WORDS[k] ?? k).replace(/\{(\w+)\}/g, (_, x: string) => String(v?.[x] ?? ''));

test('a_routed_rows_logo_says_why_auto_picked_it_as_v1_did', () => {
  const body = { ext: { 'wisp.router': { route: { goal: 'best', type: 'bugfix', label: 'Sonnet · High', chance: 0.82, n: 12, usd: 0.4 } } } };
  const r = routeOf(body);
  expect(r && routeTip(r, say)).toBe('Auto · Best → Sonnet · High · 82% on your bugfix tasks (12) · ~$0.40');
  expect(routeTip({ label: 'Opus', chance: 0.5, type: 'feature', why: 'as previewed · High thinking for Best · cheapest that works', suggest: { label: 'GPT-5' } }, say)).toBe(
    'Auto · Balanced → Opus, as previewed · cheapest that works · worth trying GPT-5',
  );
  // moved to another harness since, or never routed: no route
  expect(routeOf({ ext: { 'wisp.router': { route: { switched: true } } } })).toBeUndefined();
  expect(routeOf({})).toBeUndefined();
});

test('the popover says why without what its title says, the odds once, Worth a try only when it is not the pick, four others at most_v1_auto_pop', () => {
  const alt = (agent: string, model: string, chance: number) => ({ agent, model, effort: 'high', key: `${agent}:${model}`, label: `${agent} · ${model} · High`, chance, usd: 0.3 });
  const p = {
    pick: { agent: 'claude', model: '', effort: '', key: 'claude:', label: 'Claude Code' },
    why: 'your usual pick (4 of yours) · Medium thinking for Balanced',
    type: 'feature',
    chance: 0.83,
    usd: 0.111,
    minutes: 1.4,
    suggest: { ...alt('claude', 'opus', 0.89), why: '89% expected from public benchmarks' },
    alternatives: [alt('claude', 'opus', 0.89), alt('codex', 'a', 0.88), alt('codex', 'b', 0.85), alt('claude', 'c', 0.5), alt('x', 'd', 0.4), alt('y', 'e', 0.3)],
  };
  const pop = popOf(p);
  expect(pop.why).toBe('Your usual pick (4 of yours)');
  expect([pop.chance, pop.usd, pop.minutes]).toEqual(['83%', '~$0.11', 1]);
  expect(pop.suggest?.key).toBe('claude:opus');
  expect(pop.others.map((a) => a.key)).toEqual(['codex:a', 'codex:b', 'claude:c', 'x:d']); // the suggestion isn't repeated
  // a why that already gives the odds: not twice
  expect(popOf({ ...p, why: '87% expected from public benchmarks' }).chance).toBe('');
  // the suggestion is the pick: no Worth a try
  expect(popOf({ ...p, suggest: { ...p.suggest, key: 'claude:' } }).suggest).toBeNull();
  expect(shortLabel({ label: 'Claude Code · Opus 4.7 · Medium', model: 'opus' })).toBe('Opus 4.7 · Medium');
  expect(neverRule({ agent: 'codex', model: '' }, 'bug')).toBe('codex:@bug');
});
