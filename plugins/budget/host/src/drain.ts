// What a unit of work takes of a window (v1 Budget.spend/rate/drain): learn is Ask near the limit's
// rate, drain is Drain watch's samples, kept run by run for two weeks, so a plan that suddenly
// moves much faster for the same work stands out (design/budget.md).

import type { Drain } from '@wisp-plugin/budget-api';
import { windowLabel } from '@wisp-plugin/budget-api';
import type { Acc, DrainSample } from './state.ts';

const H = 3600_000;
const LEARN_MIN = 0.02; // two points moved before a rate counts (the CLI reports whole percents)
const LEARN_KEEP = 0.3; // past this many points, halve: the rate follows the recent runs
const DRAIN_KEEP = 40; // runs remembered per window
const DRAIN_AGE = 14 * 864e5;
const DRAIN_RECENT = 2 * H;
const DRAIN_RATIO = 2; // this many times the usual share per unit of work
const DRAIN_MIN = { runs: 5, du: 0.03 }; // what "usual" needs before it means anything
const DRAIN_NOW = { runs: 2, du: 0.05 }; // and the recent runs

/**
 * A run on the account ended: its units of work count against what the windows moved. Runs at the
 * same time share what moved in between: the first to end takes it. Over a few runs that evens
 * out, which is all Drain watch needs. Returns whether anything changed.
 */
export function spend(acc: Acc, units: number, failed: boolean, now: number): boolean {
  if (!(units > 0)) return false;
  for (const id of Object.keys(acc.windows)) {
    const l = ((acc.learn ??= {})[id] ??= { du: 0, units: 0 });
    l.units += units;
    if (l.du > LEARN_KEEP) {
      l.du /= 2;
      l.units /= 2;
    }
    const list = ((acc.drain ??= {})[id] ?? []).filter((x) => x.at > now - DRAIN_AGE);
    list.push({ at: now, du: Math.max(0, acc.run?.[id] ?? 0), units, ...(failed && { failed: true }) });
    acc.drain[id] = list.slice(-DRAIN_KEEP);
  }
  delete acc.run;
  return true;
}

const sum = (xs: readonly DrainSample[], k: 'units' | 'du'): number => xs.reduce((t, x) => t + x[k], 0);

/**
 * Drain watch: the window whose last two hours of runs took DRAIN_RATIO times or more its usual
 * share per unit of work, or null. Dismissed (drainSeen) until a run after that says so again.
 */
export function drainOf(acc: Acc | undefined, now: number): Drain | null {
  let best: Drain | null = null;
  for (const [id, all] of Object.entries(acc?.drain ?? {})) {
    const list = all.filter((x) => x.at > now - DRAIN_AGE);
    const recent = list.filter((x) => x.at > now - DRAIN_RECENT);
    const before = list.filter((x) => x.at <= now - DRAIN_RECENT);
    const [bu, bd, ru, rd] = [sum(before, 'units'), sum(before, 'du'), sum(recent, 'units'), sum(recent, 'du')];
    if (before.length < DRAIN_MIN.runs || bd < DRAIN_MIN.du || !(bu > 0)) continue;
    if (recent.length < DRAIN_NOW.runs || rd < DRAIN_NOW.du || !(ru > 0)) continue;
    const last = recent.at(-1);
    const first = recent[0];
    if (!last || !first || (acc?.drainSeen?.[id] ?? -Infinity) >= last.at) continue;
    const usual = bd / bu;
    const ratio = rd / ru / usual;
    if (ratio < DRAIN_RATIO || (best && best.ratio >= ratio)) continue;
    const failed = recent.filter((x) => x.failed);
    best = { id, label: windowLabel(id, acc?.windows[id]?.ms), ratio, since: first.at, runs: recent.length, units: ru, du: rd, usual, failed: { runs: failed.length, du: sum(failed, 'du') } };
  }
  return best;
}

/** What a unit of work takes of the window, from the runs so far (kept across resets), or null. */
export function rateOf(acc: Acc | undefined, id: string): number | null {
  const l = acc?.learn?.[id];
  return l && l.du >= LEARN_MIN && l.units > 0 ? l.du / l.units : null;
}
