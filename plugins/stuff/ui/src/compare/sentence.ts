// What can honestly be said against run A, in numbers only (v1 compare-metrics compareSentence): it
// never says which run is better, and it never takes one run each for more than that. Plus the
// words for Try it two ways' differences and a run's variant.

import { byAge, letter, listed, runMetrics, type T } from './metrics.ts';
import type { Metrics, Run, Trial } from './types.ts';

const NEAR = 0.05; // a difference under this share says nothing about one run each
const NEAR_MS = 5000;

/** The same as a duration in a sentence: "40s", "3 min", "1h 5m". */
export function spanWords(t: T, ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return t('stuff.compare.span.s', { s });
  const m = Math.round(s / 60);
  return m < 60 ? t('stuff.compare.span.m', { m }) : t('stuff.compare.span.h', { h: Math.floor(m / 60), m: m % 60 });
}

/** "62% fewer tokens": a percent, never the 100% of a number that isn't gone. */
function change(a: number, b: number): number {
  const by = Math.round((Math.abs(b - a) / a) * 100);
  return b < a ? Math.min(by, 99) : by;
}

function deltas(t: T, a: Metrics, b: Metrics, name: string): string {
  const parts: string[] = [];
  const at = a.tokens ?? 0;
  const bt = b.tokens ?? 0;
  const tokens = at > 0 && bt > 0;
  if (tokens && Math.abs(bt - at) / at >= NEAR) parts.push(t(bt < at ? 'stuff.compare.fewerTokens' : 'stuff.compare.moreTokens', { n: change(at, bt) }));
  if (a.cost !== null && a.cost > 0 && b.cost !== null && Math.abs(b.cost - a.cost) / a.cost >= NEAR) parts.push(t(b.cost < a.cost ? 'stuff.compare.costLess' : 'stuff.compare.costMore', { n: change(a.cost, b.cost) }));
  const time = a.time !== null && b.time !== null;
  if (a.time !== null && b.time !== null && Math.abs(b.time - a.time) >= NEAR_MS) parts.push(t(b.time < a.time ? 'stuff.compare.tookLess' : 'stuff.compare.tookLonger', { span: spanWords(t, Math.abs(b.time - a.time)) }));
  if (parts.length) return t('stuff.compare.thanA', { name, parts: listed(t, parts) });
  return tokens && time ? t('stuff.compare.aboutSame', { name }) : '';
}

function testsClause(t: T, runs: readonly Metrics[]): string {
  const done = runs.filter((r) => !r.live && !r.unfinished);
  const passed = done[0]?.tests?.passed ?? 0;
  if (runs.some((r) => r.live) || done.length < 2 || passed <= 0) return '';
  if (!done.every((r) => r.tests && !r.tests.failed && r.tests.passed === passed)) return '';
  return t('stuff.compare.passed', { who: done.length === 2 ? t('stuff.compare.both') : t('stuff.compare.all', { n: done.length }), count: passed });
}

/** Takes runs or runMetrics of them. '' when there's nothing honest to say yet. */
export function compareSentence(t: T, list: readonly (Run | Metrics)[]): string {
  const runs = byAge(list).map((x) => ('turns' in x ? runMetrics(x) : x));
  const [a, ...rest] = runs;
  if (!a) return '';
  const said = new Set<string>(); // a clause several runs share is said once
  rest.forEach((b, i) => {
    const name = letter(i + 1);
    if (a.live || b.live) return;
    if (a.unfinished || b.unfinished) said.add(t('stuff.compare.unfinished', { who: listed(t, [...(a.unfinished ? ['A'] : []), ...(b.unfinished ? [name] : [])]) }));
    else if (a.followUps !== b.followUps) said.add(t('stuff.compare.followUps', { name }));
    else if (a.agent !== b.agent) said.add(t('stuff.compare.harnesses'));
    else said.add(deltas(t, a, b, name));
  });
  said.add(testsClause(t, runs));
  said.delete('');
  return said.size ? [...said, t('stuff.compare.noise')].join(' ') : '';
}

const SUBAGENT_NAME: Readonly<Record<string, string>> = { haiku: 'Haiku', sonnet: 'Sonnet' };
const level = (t: T, e: string): string => (!e ? t('stuff.compare.default') : e === 'xhigh' ? 'X-High' : e.charAt(0).toUpperCase() + e.slice(1));

/** Try it two ways: a run's variant in words, for Compare's columns. Its subagents on the task's
 *  model only say so when the setting would have them on another (defaults.subagentModel). */
export function variantWords(t: T, v: Trial['variant'] | undefined, setting = ''): string[] {
  const out: string[] = [];
  if (v?.subagentModel) out.push(t('stuff.compare.variant.subagents', { name: SUBAGENT_NAME[v.subagentModel] ?? v.subagentModel }));
  else if (v?.subagentModel === '' && setting) out.push(t('stuff.compare.variant.subagentsTask'));
  if (v?.skills === 'off') out.push(t('stuff.compare.variant.skillsOff'));
  return out;
}

export interface DiffersNames {
  readonly agent?: (id: string) => string;
  readonly model?: (id: string) => string;
  readonly account?: (id: string) => string;
  /** what '' subagents run on: run A's model */
  readonly taskModel?: string;
}

/** session.trial.differs in words: "Subagents: Opus → Haiku · Skills: on → off". */
export function differsWords(t: T, differs: Trial['differs'], names: DiffersNames = {}): string {
  if (!differs?.length) return t('stuff.compare.sameSetup');
  const id = (x: string): string => x;
  const rows: Readonly<Record<string, readonly [string, (x: string) => string]>> = {
    agent: [t('stuff.compare.differs.agent'), names.agent ?? id],
    model: [t('stuff.compare.differs.model'), (x) => (x ? (names.model ?? id)(x) : t('stuff.compare.default'))],
    effort: [t('stuff.compare.differs.effort'), (x) => level(t, x)],
    account: [t('stuff.compare.differs.account'), names.account ?? ((x) => x || t('stuff.compare.default'))],
    subagentModel: [t('stuff.compare.differs.subagents'), (x) => SUBAGENT_NAME[x] ?? (x || names.taskModel || t('stuff.compare.taskModel'))],
    skills: [t('stuff.compare.differs.skills'), id],
  };
  return differs.map(({ key, values }) => `${rows[key]?.[0] ?? key}: ${values.map(rows[key]?.[1] ?? String).join(' → ')}`).join(' · ');
}
