// Usage at a glance under Home's prompt box (v1 #790 web/js/home-usage.js, budget.js homeUsageHtml): each account's
// plan as its CLI last reported it (budget.view), two windows at most: the 5-hour one and the fullest of the others
// (the weekly ones). Three accounts at most. Nothing until a CLI has reported its plan. DOM-free, so a test reads it.
import type { AccountPlan, Window } from './commands.ts';
import { t, type Key } from './i18n.ts';

const SHORT: Readonly<Record<string, Key>> = {
  five_hour: 'budget.home.short.fiveHour',
  seven_day: 'budget.home.short.week',
  seven_day_opus: 'budget.home.short.opus',
  seven_day_sonnet: 'budget.home.short.sonnet',
};
/** "5h", "Week", "Opus week"; another window keeps its own label. */
export const shortLabel = (w: Pick<Window, 'id' | 'label'>): string => {
  const k = SHORT[w.id];
  return k ? t(k) : w.label;
};

/** A harness as Home reads it: its accounts' plans and, when it has several, their names (accounts.list). */
export interface HomeHarness {
  readonly agent: string;
  readonly name: string;
  /** runtime.agents `available`; unknown (still detecting): shown */
  readonly available?: boolean | undefined;
  readonly accounts: readonly AccountPlan[];
  readonly names: readonly { readonly id: string; readonly label: string }[];
}

export interface HomeUsageRow {
  readonly agent: string;
  readonly name: string;
  readonly account: string;
  /** '' for the CLI's own login alone */
  readonly accountLabel: string;
  readonly windows: readonly (Window & { readonly short: string })[];
}

export function homeUsage(list: readonly HomeHarness[], max = 3): HomeUsageRow[] {
  const out: HomeUsageRow[] = [];
  for (const h of list) {
    if (h.available === false) continue;
    const many = h.names.length > 1;
    for (const a of h.accounts) {
      const acc = many ? h.names.find((x) => x.id === a.account) : undefined;
      if (many ? !acc : a.account !== 'default' && a.account !== '') continue; // an account since removed ('' and 'default': the CLI's own)
      const wins = a.windows.filter((w) => typeof w.used === 'number' && Number.isFinite(w.used));
      const five = wins.find((w) => w.id === 'five_hour');
      const week = wins.filter((w) => w !== five).sort((x, y) => y.used - x.used)[0];
      const pick = [five, week].filter((w): w is Window => w !== undefined);
      if (!pick.length) continue;
      out.push({ agent: h.agent, name: h.name, account: a.account, accountLabel: acc?.label ?? '', windows: pick.map((w) => ({ ...w, short: shortLabel(w) })) });
    }
  }
  return out.slice(0, max);
}

const HOLDS = ['off', '80', '90', '95'];
/** Ask near the limit's line (v1 limit-hold.js holdLine): 0.8 / 0.9 / 0.95, 90 when unset, null when off. */
export function holdLine(v: unknown): number | null {
  const s = HOLDS.includes(String(v)) ? String(v) : '90';
  return s === 'off' ? null : Number(s) / 100;
}

/** v1 tone(): red when used up; amber on pace to run out, at the Ask-near-the-limit line (90% when off) or past
 * where automations stop. */
export function homeTone(w: Pick<Window, 'used' | 'hitAt'>, stop: number | null, hold: number | null): 'warn' | 'full' | undefined {
  if (w.used >= 1) return 'full';
  if (w.hitAt || w.used >= (hold ?? 0.9) || (stop !== null && w.used >= stop)) return 'warn';
  return undefined;
}
