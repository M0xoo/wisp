// Plan budget's words past the bars (v1 features/budget.js windowLine, bankedHtml, overHtml, whereHtml, compareHtml;
// banked.js; receipt.js compareWords/compareParts), DOM-free so tests read them.

import { pct } from './drain.ts';
import { t } from './i18n.ts';

const DAY = 24 * 3600_000;

/** A window as `budget.view` gives it, with what the line under its bar reads. */
export interface WindowLike {
  readonly used: number;
  readonly resetsAt?: number | null;
  readonly hitAt?: number | null;
  readonly earlyAt?: number | null;
}

/** The line under a window's bar (v1 windowLine): each says something the others don't, no time twice. */
export function windowLine(w: WindowLike, stop: number | null, when: (at: number) => string): string {
  if (!w.resetsAt) return t('budget.plan.new');
  const at = when(w.resetsAt);
  if (w.used >= 1) return t('budget.plan.usedUp', { when: at });
  if (stop !== null && w.used >= stop) return t('budget.plan.wait', { when: at });
  if (w.earlyAt) return t('budget.plan.early', { early: when(w.earlyAt), when: at });
  if (w.hitAt) return t('budget.plan.pace', { when: at, hit: when(w.hitAt) });
  return t('budget.plan.resets', { when: at });
}

const STOPS = ['50', '75', '90'];

/** Where automations stop on a harness (v1 stopAt): its own line unless 'same' or unset, else Automations stop at;
 * null when they never do. */
export function stopLine(own: string | undefined, all: string | undefined): number | null {
  const v = own && own !== 'same' ? own : all;
  return v && STOPS.includes(v) ? Number(v) / 100 : null;
}

/** "today 17:00", "tomorrow 17:00", else the long form (v1 banked.js dayWhen). */
export function dayWhen(at: number, now: number, long: (at: number) => string): string {
  const hm = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }).format(at);
  const d = new Date(at).toDateString();
  if (d === new Date(now).toDateString()) return t('budget.plan.today', { time: hm });
  if (d === new Date(now + DAY).toDateString()) return t('budget.plan.tomorrow', { time: hm });
  return long(at);
}

/** Codex's banked (early) resets, as its last read said (budget-api Banked). */
export interface Banked {
  readonly count: number;
  readonly credits?: readonly { readonly id: string; readonly expiresAt: number | null }[] | null;
  readonly at?: number | null;
}

/** "1 banked reset, expires tomorrow 17:00" (v1 bankedWords); '' with none. wisp never redeems one. */
export function bankedWords(k: Banked | null | undefined, now: number, day: (at: number) => string): string {
  if (!k?.count) return '';
  const head = t('budget.plan.banked', { count: k.count });
  const next = k.credits?.find((c) => c.expiresAt && c.expiresAt > now);
  if (!next?.expiresAt) return head;
  return t('budget.plan.bankedNext', { count: k.count, head, when: day(next.expiresAt) });
}

/** One expires within a day: the line warns (v1 bankedSoon). */
export const bankedSoon = (k: Banked | null | undefined, now: number): boolean => !!k?.credits?.some((c) => c.expiresAt && c.expiresAt > now && c.expiresAt - now <= DAY);

/** Past your plan this week (budget-api OverageView). */
export interface Overage {
  readonly runs: number;
  readonly at: number;
  readonly kind: 'extra' | 'credits' | 'api' | 'profile';
  readonly sid?: string;
}

const OVER = { extra: 'budget.plan.over.extra', credits: 'budget.plan.over.credits', api: 'budget.plan.over.api', profile: 'budget.plan.over.profile' } as const;

/** "2 runs in the last 7 days billed as extra usage (last: …)." (v1 overHtml) */
export const overWords = (o: Overage, when: (at: number) => string): string =>
  t('budget.plan.over', { count: o.runs, how: t(OVER[o.kind] ?? OVER.extra), when: when(o.at) });

/** Where an account's longest window went (budget-api WhereView). */
export interface Where {
  readonly window: string;
  readonly label: string;
  readonly used: number;
  readonly traced: number;
  readonly tasks: readonly { readonly id: string; readonly title: string; readonly used: number }[];
  readonly more: number;
}

export interface WhereRow {
  readonly key: string;
  readonly title: string;
  readonly pct: string;
  /** the task to open, for a task's row */
  readonly id?: string;
  readonly tip?: string;
}

/** Its heading and rows (v1 whereHtml): the top tasks, the rest of what wisp traced, and what it couldn't. */
export function whereRows(w: Where | null | undefined): { heading: string; rows: WhereRow[] } | undefined {
  if (!w?.tasks.length) return undefined;
  const label = w.label.charAt(0).toLowerCase() + w.label.slice(1);
  const rest = w.traced - w.tasks.reduce((t, x) => t + x.used, 0);
  const outside = Math.max(0, w.used - w.traced);
  const rows: WhereRow[] = w.tasks.map((x) => ({ key: x.id, id: x.id, title: x.title, pct: pct(x.used), tip: t('budget.plan.open', { title: x.title }) }));
  if (w.more && rest > 0) rows.push({ key: 'more', title: t('budget.plan.others', { count: w.more }), pct: pct(rest) });
  if (outside >= 0.005) rows.push({ key: 'outside', title: t('budget.plan.outside'), pct: pct(outside), tip: t('budget.plan.outsideTip') });
  return { heading: t('budget.plan.where', { label }), rows };
}

/** Each account's median turn on a model (budget-api ModelCompare). */
export interface Compare {
  readonly model: string;
  readonly accounts: readonly { readonly account: string; readonly turns: number; readonly output: number; readonly input: number; readonly cache: number | null }[];
}

/** "38k", "1.2M" (v1 tokenWords). */
export function tokenWords(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}

/** "12k out · 40k in · 71% cache · 9 turns" (v1 compareParts). */
export const compareParts = (x: Compare['accounts'][number]): string[] => [
  t('budget.plan.tokOut', { n: tokenWords(x.output) }),
  t('budget.plan.tokIn', { n: tokenWords(x.input) }),
  ...(x.cache !== null && x.cache !== undefined ? [t('budget.plan.tokCache', { pct: pct(x.cache) })] : []),
  t('budget.plan.turns', { count: x.turns }),
];

/** "Work uses 1.9× the output tokens per turn of Personal (n=9 / 12)", or about the same under 1.2× (v1 compareWords). */
export function compareWords(c: Compare, labelOf: (account: string) => string): string {
  const list = c.accounts;
  if (list.length < 2) return '';
  const outs = list.map((x) => x.output).filter((x) => x > 0);
  const r = outs.length >= 2 ? Math.max(...outs) / Math.min(...outs) : 0;
  const hi = list.reduce((a, b) => (b.output > a.output ? b : a));
  const lo = list.reduce((a, b) => (b.output < a.output ? b : a));
  const n = `(n=${list.map((x) => x.turns).join(' / ')})`;
  if (r < 1.2) return t('budget.plan.same', { names: list.map((x) => labelOf(x.account)).reduce((a, b) => t('budget.plan.and', { a, b })), n });
  return t('budget.plan.more', { hi: labelOf(hi.account), ratio: r.toFixed(1), lo: labelOf(lo.account), n });
}

/** What Copy report puts on the clipboard: every account's numbers side by side, for the vendor (v1 compareReport). */
export function compareReport(name: string, list: readonly Compare[], labelOf: (account: string) => string, modelOf: (model: string) => string, at: number): string {
  const lines = [t('budget.plan.report.head', { at: new Date(at).toISOString().slice(0, 16).replace('T', ' ') }), t('budget.plan.report.harness', { name })];
  for (const c of list) {
    lines.push('', t('budget.plan.report.model', { model: `${modelOf(c.model)}${c.model ? ` (${c.model})` : ''}` }));
    for (const x of c.accounts) {
      const cache = x.cache !== null ? t('budget.plan.report.cache', { pct: Math.round(x.cache * 100) }) : '';
      lines.push(t('budget.plan.report.row', { account: labelOf(x.account), turns: x.turns, output: x.output.toLocaleString('en-US'), input: x.input.toLocaleString('en-US'), cache }));
    }
    lines.push(`${compareWords(c, labelOf)}.`);
  }
  lines.push('', t('budget.plan.report.foot'));
  return lines.join('\n');
}
