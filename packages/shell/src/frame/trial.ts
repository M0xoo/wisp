// Try it two ways (v1 #650 runner-picker.js What's different, compare-metrics.js variantWords/differsWords; v1 #771:
// the run added with + is the copy; F-comp-31, ADR-0056): run B's one changed setting in the launcher, the trial the
// launch sends, a run's variant in words for its row and Compare's column, and what differed. Pure, DOM-free.
import type { MenuEntry } from '@wisp/ui';

type T = (key: string, params?: Readonly<Record<string, string | number>>) => string;

/** What run B changes: '' subagents is the task's own model; skills 'off' or none. */
export interface Variant {
  readonly subagentModel?: string;
  readonly skills?: string;
}

export interface TrialDiff {
  readonly key: string;
  readonly values: readonly string[];
}

/** The link each run carries (runtime's `summary.trial`). */
export interface TrialLink {
  readonly group: string;
  readonly run: number;
  readonly runs?: readonly string[];
  /** none on the instant row, until the peer's arrives */
  readonly differs?: readonly TrialDiff[];
  readonly kept?: string | null;
}

const SUBAGENT_NAME: Readonly<Record<string, string>> = { haiku: 'Haiku', sonnet: 'Sonnet' };
/** a menu value of What's different (never a harness id: those have no ':') */
const SUB = 'vary:sub:';
const SKILLS = 'vary:skills:';

/** `runtime.subagentModel` as a run would follow it: '' unless Haiku or Sonnet. */
export const settingModel = (v: unknown): string => (v === 'haiku' || v === 'sonnet' ? v : '');

/**
 * The run's menu adds What's different when it's a copy of the lead on a harness that runs variants (its plugin
 * says `variants`) and it's the only extra run: Subagents (Task's model, Haiku, Sonnet) and Skills (On, Off), each
 * showing what the run would really use, the setting included.
 */
export function varyMenu(t: T, can: readonly string[], v: Variant | undefined, setting: string): MenuEntry[] {
  const out: MenuEntry[] = [];
  const subs = v?.subagentModel ?? setting;
  if (can.includes('subagentModel'))
    out.push({
      kind: 'group',
      id: 'vary-subagents',
      label: t('shell.try.subagents'),
      items: ['', 'haiku', 'sonnet'].map((m) => ({ value: `${SUB}${m}`, label: m ? (SUBAGENT_NAME[m] ?? m) : t('shell.try.taskModel'), checked: subs === m })),
    });
  if (can.includes('skills'))
    out.push({
      kind: 'group',
      id: 'vary-skills',
      label: t('shell.try.skills'),
      items: [
        { value: `${SKILLS}on`, label: t('shell.try.on'), checked: v?.skills !== 'off' },
        { value: `${SKILLS}off`, label: t('shell.try.off'), hint: t('shell.try.offHint'), checked: v?.skills === 'off' },
      ],
    });
  return out;
}

/** A pick from the run's menu: the new variant, or undefined when it wasn't a What's different item. */
export function pickVary(v: Variant | undefined, value: string): Variant | undefined {
  if (value.startsWith(SUB)) return { ...v, subagentModel: value.slice(SUB.length) };
  if (value.startsWith(SKILLS)) {
    const { skills: _skills, ...rest } = v ?? {};
    return value.endsWith(':off') ? { ...rest, skills: 'off' } : rest;
  }
  return undefined;
}

/** Run B really differs from run A (as A runs: the setting for its subagents, skills on). */
export function differs(v: Variant | undefined, setting: string): boolean {
  if (!v) return false;
  return (v.subagentModel !== undefined && v.subagentModel !== setting) || v.skills === 'off';
}

/**
 * What the launch sends: a trial (runtime.trial) when the one extra run is the lead's harness with a change that
 * really differs; otherwise undefined (a plain compare, or one run).
 */
export function trialVary(lead: string, runs: readonly string[], v: Variant | undefined, setting: string): Variant | undefined {
  if (runs.length !== 1 || runs[0] !== lead || !v || !differs(v, setting)) return undefined;
  return { ...(v.subagentModel !== undefined && { subagentModel: v.subagentModel }), ...(v.skills === 'off' && { skills: 'off' }) };
}

/** A run's variant in words, for its row, its chip and Compare's column ("Subagents on Haiku", "Skills off"). */
export function variantWords(t: T, v: Variant | undefined): string[] {
  const out: string[] = [];
  if (v?.subagentModel) out.push(t('shell.try.subagentsOn', { name: SUBAGENT_NAME[v.subagentModel] ?? v.subagentModel }));
  else if (v?.subagentModel === '') out.push(t('shell.try.subagentsTask'));
  if (v?.skills === 'off') out.push(t('shell.try.skillsOff'));
  return out;
}

/** summary.trial.differs in words: "Subagents: Opus → Haiku · Skills: on → off". `taskModel`: run A's model. */
export function differsWords(t: T, d: readonly TrialDiff[] | undefined, taskModel = ''): string {
  if (!d?.length) return t('shell.try.same');
  const value = (key: string, x: string): string => {
    if (key === 'subagentModel') return SUBAGENT_NAME[x] ?? (x || taskModel || t('shell.try.taskModel'));
    if (key === 'skills') return t(x === 'off' ? 'shell.try.offWord' : 'shell.try.onWord');
    return x;
  };
  const label = (key: string): string => (key === 'subagentModel' ? t('shell.try.subagents') : key === 'skills' ? t('shell.try.skills') : key);
  return d.map(({ key, values }) => `${label(key)}: ${values.map((x) => value(key, x)).join(' → ')}`).join(' · ');
}

/** The trial link on a row, if it carries one. */
export function trialOf(summary: Readonly<Record<string, unknown>> | undefined): TrialLink | undefined {
  const t = summary?.['trial'];
  return t && typeof t === 'object' && typeof (t as TrialLink).group === 'string' ? (t as TrialLink) : undefined;
}

/** A row's variant (runtime's `summary.variant`). */
export function variantOf(summary: Readonly<Record<string, unknown>> | undefined): Variant | undefined {
  const v = summary?.['variant'];
  return v && typeof v === 'object' ? (v as Variant) : undefined;
}

/** A trial's runs in run order (A, B), whatever order they were created in; other groups by age. */
export function runOrder<R extends { readonly created_at: number; readonly summary: Readonly<Record<string, unknown>> }>(rows: readonly R[]): R[] {
  return [...rows].sort((a, b) => (trialOf(a.summary)?.run ?? 0) - (trialOf(b.summary)?.run ?? 0) || a.created_at - b.created_at);
}
