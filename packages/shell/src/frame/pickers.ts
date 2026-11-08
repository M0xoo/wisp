// What the prompt box and the reply box offer to pick (v1 launcher.js, composer.js): the mode, the
// harness, who the lead may delegate to, when it starts. Pure: the entries and their words.

import type { IconName, MenuEntry } from '@wisp/ui';
import type { ShellContext } from '../contract.ts';
import type { HarnessUiDef } from '../contract.ts';
import { harnessOf } from './harness.ts';

export type Mode = 'plan' | 'edits' | 'auto';
export const MODES: readonly Mode[] = ['plan', 'edits', 'auto'];
export const MODE_ICON: Readonly<Record<Mode, IconName>> = { plan: 'plan', edits: 'pen', auto: 'spark' };

export const modeMenu = (t: ShellContext['t'], on: Mode): MenuEntry[] =>
  MODES.map((m) => ({ value: m, label: t(`shell.mode.${m}`), hint: t(`shell.mode.${m}.hint`), icon: MODE_ICON[m], checked: m === on }));

/** The harnesses: Auto (wisp picks per task) and each one the harness plugins registered. */
export const agentName = (t: ShellContext['t'], all: readonly HarnessUiDef[], a: string): string => (a === 'auto' ? t('shell.home.auto') : harnessOf(all, a).name);
export const agentMenu = (t: ShellContext['t'], all: readonly HarnessUiDef[], on: string, withAuto = true): MenuEntry[] =>
  [...(withAuto ? ['auto'] : []), ...all.map((h) => h.id)].map((a) => ({ value: a, label: agentName(t, all, a), checked: a === on }));

/** Delegate: the agents the lead may hand parts of the task to (a toggle each). */
export const teamMenu = (t: ShellContext['t'], all: readonly HarnessUiDef[], on: ReadonlySet<string>): MenuEntry[] =>
  all.map((h) => ({ value: h.id, label: t('shell.team.copies', { name: h.name }), checked: on.has(h.id) }));

/** When it starts, if not now. */
export const WHENS = ['hour', 'evening', 'morning'] as const;
export type When = (typeof WHENS)[number];
export const whenMenu = (t: ShellContext['t']): MenuEntry[] => WHENS.map((w) => ({ value: w, label: t(`shell.when.${w}`), icon: 'clock' as const }));

/** The time a `when` names, from `now` (local time): in an hour, today 18:00 (or tomorrow), tomorrow 9:00. */
export function whenAt(w: When, now: number): number {
  const d = new Date(now);
  if (w === 'hour') return now + 3_600_000;
  if (w === 'evening') {
    d.setHours(18, 0, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}
