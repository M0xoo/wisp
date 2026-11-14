// Auto's rules as the UI applies them (v1 web/js/features/auto.js, auto-preview.js, feed.js
// autoPill). Pure: no client, no DOM. Strings come from the catalogue through t().

import { t } from './i18n.ts';
import type { ArmReport, PreviewArgs, PreviewPick, PreviewResult, RouteAlt, RouterSettings, SessionRow, Suggest } from './types.ts';

type Labelled = Pick<ArmReport, 'agent' | 'model' | 'label'>;

/** Never / Prefer act on a model at every level: 'claude:opus'. 'codex:' is its default model. */
export const modelRule = (a: Pick<ArmReport, 'agent' | 'model'>): string => `${a.agent}:${a.model || ''}`;

/** A rule with '@kind' is for one kind of task (from the launcher's preview), listed apart. */
export const coversModel = (rule: string, a: Pick<ArmReport, 'agent' | 'model'>): boolean => !rule.includes('@') && (rule === modelRule(a) || rule.startsWith(`${modelRule(a)}:`));

/** "Claude Code · Opus 5.5 · High" → "Claude Code". */
export const harnessOf = (label: string): string => label.split(' · ')[0] ?? label;

/** The model's name without its level: "Opus 5.5", or "Codex’s default model". */
export const modelName = (a: Labelled): string => (a.model ? (a.label.split(' · ')[1] ?? a.model) : t('wisp.router.default-model', { harness: harnessOf(a.label) }));

/** "Claude Code · Opus 4.7 · Medium" → "Opus 4.7 · Medium": the logo already says the harness. */
export const shortLabel = (p: Labelled): string => (p.model ? p.label.split(' · ').slice(1).join(' · ') : p.label);

const TYPE_WORD: Readonly<Record<string, string>> = { ui: 'UI' };
export const typeWord = (type: string): string => TYPE_WORD[type] ?? type;

/** Never pick this model for this kind of task. */
export const neverRule = (p: Pick<PreviewPick, 'agent' | 'model'>, type: string): string => `${p.agent}:${p.model || ''}@${type}`;

export type RuleKind = 'blocked' | 'prefer';
export type RuleSet = Pick<RouterSettings, 'blocked' | 'prefer'>;

export const ruleOn = (set: RuleSet, kind: RuleKind, a: Pick<ArmReport, 'agent' | 'model'>): boolean => set[kind].some((x) => coversModel(x, a));

/**
 * Never / Prefer flipped for a model. The two exclude each other for a model; turning one on drops
 * every rule that covered that model at any level. Kind rules ('@ui') are left alone.
 */
export function toggleRule(set: RuleSet, kind: RuleKind, a: Pick<ArmReport, 'agent' | 'model'>): RuleSet {
  const other: RuleKind = kind === 'blocked' ? 'prefer' : 'blocked';
  const on = !ruleOn(set, kind, a);
  const mine = set[kind].filter((x) => !coversModel(x, a));
  const theirs = on ? set[other].filter((x) => !coversModel(x, a)) : [...set[other]];
  const next = on ? [...mine, modelRule(a)] : mine;
  return kind === 'blocked' ? { blocked: next, prefer: theirs } : { blocked: theirs, prefer: next };
}

export interface KindRule {
  rule: string;
  /** "Opus 5.5" or "Codex" */
  what: string;
  kind: string;
}

/** The '@kind' rules under the table: "Never Opus 5.5 for UI tasks". */
export function kindRules(blocked: readonly string[], arms: readonly Labelled[]): KindRule[] {
  return blocked
    .filter((x) => x.includes('@'))
    .map((rule) => {
      const [what = '', kind = ''] = rule.split('@');
      const a = arms.find((y) => modelRule(y) === what || y.agent === what);
      const name = a ? (what.includes(':') ? modelName(a) : harnessOf(a.label)) : what;
      return { rule, what: name, kind: typeWord(kind) };
    });
}

export type Outcome = 'waiting' | 'worked' | 'finished' | 'partly' | 'failed';
export const outcomeOf = (r: number | null): Outcome => (r === null ? 'waiting' : r >= 0.9 ? 'worked' : r >= 0.5 ? 'finished' : r >= 0.25 ? 'partly' : 'failed');

export const pct = (x: number): string => `${Math.round(x * 100)}%`;
export const usd = (x: number): string => (x ? `~$${x.toFixed(2)}` : '');
export const cost = (x: number): string => (x ? `$${x.toFixed(2)}` : '$0');

/** Where a row's number comes from: your own runs once there are a few, else the benchmarks. */
export type Source = 'mine' | 'prior' | 'family' | null;
export const sourceOf = (a: Pick<ArmReport, 'n' | 'prior' | 'inherited'>): Source => (a.n >= 3 ? 'mine' : a.prior ? 'prior' : a.inherited ? 'family' : null);

/** Arms worth a row: one gone from this computer stays while it has history. */
export const shownArms = (arms: readonly ArmReport[]): ArmReport[] => arms.filter((a) => a.state !== 'gone' || a.n > 0);

/** "bug 80% (4) · UI 55% (2)" */
export const byTypeLine = (a: Pick<ArmReport, 'byType'>): string =>
  Object.entries(a.byType)
    .map(([type, x]) => `${typeWord(type)} ${pct(x.chance)} (${x.n})`)
    .join(' · ');

export const TIER_WORD: Readonly<Record<number, 'small' | 'everyday' | 'frontier'>> = { 1: 'small', 2: 'everyday', 3: 'frontier' };

// ---------- the launcher's preview ----------

/** Typing waits for a pause; the same question twice asks once. */
export const previewSig = (q: PreviewArgs): string => JSON.stringify([q.prompt.trim(), q.attachments, q.goal ?? '', q.team ?? false, q.machine ?? '']);
export const PREVIEW_DEBOUNCE = 300;

/** The popover's why without what its title already says ("High thinking for Balanced"), capitalised. */
export function popoverWhy(why: string): string {
  const s = why
    .split(' · ')
    .filter((x) => !/ thinking for /.test(x))
    .join(' · ');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

/** The facts line: chance (unless the why gives one), cost, time. */
export function facts(r: Extract<PreviewResult, { pick: PreviewPick }>): string[] {
  const why = popoverWhy(r.why);
  return [!/\d%/.test(why) ? t('wisp.router.preview.likely', { pct: pct(r.chance) }) : '', usd(r.usd), r.minutes ? t('wisp.router.preview.minutes', { n: Math.round(r.minutes) }) : ''].filter(Boolean);
}

/** Worth a try (a better model that isn't your habit), then up to four others. */
export function choices(r: Extract<PreviewResult, { pick: PreviewPick }>): { suggest: Suggest | null; alternatives: RouteAlt[] } {
  const suggest = r.suggest && r.suggest.key !== r.pick.key ? r.suggest : null;
  return { suggest, alternatives: r.alternatives.filter((a) => a.key !== suggest?.key).slice(0, 4) };
}

// ---------- the row ----------

export type AutoPill = { id: 'pick'; tip: string } | { id: 'handed' | 'moved'; tip: string };

/** What Auto found after the run: the best-of-2 pick, a hand-over (v1 feed.js autoPill). */
export function autoPills(s: SessionRow, nameOf: (id: string) => string | undefined, agentName: (agent: string) => string): AutoPill[] {
  const a = s.auto;
  if (!a || s.pending) return [];
  const out: AutoPill[] = [];
  if (a.pick?.winner) out.push({ id: 'pick', tip: t('wisp.router.pill.pick-tip', { why: a.pick.why ?? '' }) });
  if (a.escalatedTo) {
    const to = nameOf(a.escalatedTo) ?? t('wisp.router.pill.another');
    const key = a.reason === 'limit' ? 'wisp.router.pill.moved-tip' : a.reason === 'error' ? 'wisp.router.pill.error-tip' : 'wisp.router.pill.tests-tip';
    out.push({ id: a.reason === 'limit' ? 'moved' : 'handed', tip: t(key, { from: agentName(s.agent), to }) });
  }
  return out;
}
