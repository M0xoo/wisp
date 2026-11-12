// Spare allowance (v1 web/js/spare.js, design/budget.md): a long usage window (a day or more) that resets soon with
// a good share still unused. What's left at the reset is gone, so Home says so, with a way to start a task on that
// account. Advice only: wisp never switches accounts or spends a banked reset for you. DOM-free.
import type { AccountPlan } from './commands.ts';

const H = 3_600_000;
/** resets within this many hours */
export const SPARE_HOURS = 24;
/** with at least this share of the window left */
export const SPARE_LEFT = 0.2;
/** a 5-hour window always resets soon: only windows of a day or more count */
const LONG = 24 * H;
/** Codex's reset drifts a little: a dismissal holds for the same period within 10 minutes */
const samePeriod = (a: number, b: number): boolean => Math.abs(a - b) < 10 * 60_000;

export interface Spare {
  readonly agent: string;
  readonly name: string;
  /** '' for the CLI's own login */
  readonly account: string;
  readonly window: string;
  readonly label: string;
  /** 0–1 */
  readonly left: number;
  readonly resetsAt: number;
  readonly at: number | null;
}

/** The key a dismissal is kept under: one window of one account, until its next period. */
export const spareKey = (x: Pick<Spare, 'agent' | 'account' | 'window'>): string => `${x.agent}:${x.account}:${x.window}`;

/** Each harness's accounts as budget.view reads them → the spare windows, soonest reset first. `seen`: the
 * dismissed ones, `{ [spareKey]: resetsAt }`. */
export function spareOf(
  harnesses: readonly { readonly agent: string; readonly name: string; readonly accounts: readonly AccountPlan[] }[],
  o: { now: number; hours?: number; left?: number; seen?: Readonly<Record<string, number>> },
): Spare[] {
  const hours = o.hours ?? SPARE_HOURS;
  const min = o.left ?? SPARE_LEFT;
  const out: Spare[] = [];
  for (const h of harnesses) {
    for (const a of h.accounts) {
      const live = a.windows.filter((w) => (w.resetsAt ?? 0) > o.now);
      // used up somewhere (the 5-hour window): a task started now would just wait
      if (live.some((w) => w.used >= 0.995)) continue;
      for (const w of live) {
        const resetsAt = w.resetsAt ?? 0;
        if (!((w.ms ?? 0) >= LONG) || resetsAt - o.now > hours * H || 1 - w.used < min - 1e-9) continue;
        if (w.hitAt) continue; // at this pace it runs out before the reset: nothing to spare
        const x: Spare = { agent: h.agent, name: h.name, account: a.account === 'default' ? '' : a.account, window: w.id, label: w.label, left: 1 - w.used, resetsAt, at: a.at ?? null };
        const s = o.seen?.[spareKey(x)];
        if (s !== undefined && samePeriod(s, resetsAt)) continue;
        out.push(x);
      }
    }
  }
  return out.sort((p, q) => p.resetsAt - q.resetsAt);
}

/** Whose window, in words: "Codex (work)’s weekly window". */
export function spareWhose(x: Pick<Spare, 'name' | 'account' | 'label'>): string {
  const win = x.label.charAt(0).toLowerCase() + x.label.slice(1);
  return `${x.name}${x.account ? ` (${x.account})` : ''}’s ${win} window`;
}

/** Dismissals for windows that have since reset are let go, so the store doesn't grow. */
export const pruneSeen = (seen: Readonly<Record<string, number>>, now: number): Record<string, number> => Object.fromEntries(Object.entries(seen).filter(([, t]) => t > now - 10 * 60_000));
