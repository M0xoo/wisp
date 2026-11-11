import { expect, test } from 'vitest';
import { autoPick, overrideOf, routeOf, routeTip, type AutoPreview } from '../src/frame/auto.ts';

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
