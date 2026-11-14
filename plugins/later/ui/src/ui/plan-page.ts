// The plan page's state, DOM-free (v1 plan-view.js paintDirty / paintSide): its title, the box's text against
// the plan's (dirty, empty), the hint under the box, when it starts, and what it runs on.
import { aheadLabel } from '../format.ts';
import { t, type Key } from '../i18n.ts';
import type { Plan } from '../types.ts';
import { planText, planTitle, runLine } from '../format.ts';

export interface PlanPageState {
  readonly title: string;
  /** what the box shows: the draft being typed, else the plan's */
  readonly text: string;
  readonly dirty: boolean;
  readonly empty: boolean;
  /** the hint's key (it takes {mod}) */
  readonly hint: Key;
  /** Starts in 2h · At 3pm · Draft · After "x" */
  readonly when: string;
  readonly runsOn: string;
  readonly project: string;
}

export function planPage(p: Plan, draft: string | undefined, now: number): PlanPageState {
  const task = p.kind === 'task';
  const saved = planText(p);
  const text = draft ?? saved;
  const empty = !text.trim();
  const dirty = text.trim() !== saved.trim();
  const hint: Key = empty ? (task ? 'wisp.later.plan.hint.empty' : 'wisp.later.plan.hint.emptyReminder') : dirty ? 'wisp.later.plan.hint.dirty' : task ? 'wisp.later.plan.hint.task' : 'wisp.later.plan.hint.reminder';
  const when = p.draft
    ? t('wisp.later.plan.draft')
    : p.after
      ? t('wisp.later.plan.afterPill', { title: p.after.title })
      : t(task ? 'wisp.later.plan.starts' : 'wisp.later.plan.at', { time: p.at ? aheadLabel(p.at, now) : '' });
  const cwd = String(p.body?.cwd ?? '');
  return { title: planTitle(p), text, dirty, empty, hint, when, runsOn: task ? runLine(p) : t('wisp.later.plan.reminder'), project: cwd.split('/').filter(Boolean).pop() ?? '' };
}
