// Plan budget's model (v1 server/budget.js Budget), in memory: how much of each account's usage
// windows is gone, from what the CLI itself reports on every run. A window whose reset has passed
// reads as fresh. Every change marks the part of the account it touched (State.touch), and rows.ts
// writes only those parts: a harness that reports the same numbers on every event writes nothing.

import type { LimitsReport, Past, Period, Share } from '@wisp-plugin/budget-api';
import { resetEarly, samePeriod, WINDOWS } from '@wisp-plugin/budget-api';
import { Ledger } from './ledger.ts';
import { shape } from './shape.ts';
import type { Acc, Win } from './state.ts';
import { accKey, State } from './state.ts';

const PERIOD_KEEP = 40; // closed periods remembered per window
const MAX_WINDOWS = 6; // a CLI that starts reporting dozens doesn't grow the rows
const LEARN_GAP = 30 * 60_000; // readings further apart than this may hide use outside wisp
const clamp = (n: number): number => Math.min(1, Math.max(0, n));

/** What one report changed, for the plugin to act on after it is written. */
export interface Recorded {
  past: Past | null;
  /** a number the page shows moved */
  moved: boolean;
  /** windows that reset before the time they last gave */
  early: string[];
  /** each turn's part of a window's move */
  shares: { sid: string; tid: string; share: Share }[];
}

const NONE: Recorded = Object.freeze({ past: null, moved: false, early: [], shares: [] });

export class Model {
  readonly state = new State();
  readonly ledger = new Ledger();
  readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  /** What a run (or a read) reported. Its `past`: the run is billed past the plan. */
  record(agent: string, account: string, report: LimitsReport): Recorded {
    if (!agent || !Array.isArray(report.windows)) return NONE;
    account ||= 'default';
    let past: Past | null = report.overage ? 'extra' : null;
    let moved = this.#banked(agent, account, report);
    const credits = report.credits;
    if (typeof credits === 'number' && Number.isFinite(credits)) {
      const acc = this.state.ensure(agent, account);
      if (typeof acc.credits === 'number' && credits < acc.credits - 1e-9) past = 'credits';
      if (acc.credits !== credits) this.state.touch(agent, account, 'acc');
      acc.credits = credits;
    }
    if (!report.windows.length) return { ...NONE, past, moved };
    const out = this.#windows(agent, account, report);
    return { ...out, past, moved: moved || out.moved };
  }

  /** banked: kept as it is until the next read says otherwise. Returns whether it changed. */
  #banked(agent: string, account: string, report: LimitsReport): boolean {
    const b = report.banked;
    if (!b || !Number.isFinite(b.count)) return false;
    const acc = this.state.ensure(agent, account);
    const same = (x: typeof b | undefined): string => JSON.stringify([x?.count, x?.credits]);
    const was = same(acc.banked);
    acc.banked = { count: b.count, credits: b.credits ?? null, at: this.now() };
    this.state.touch(agent, account, 'acc');
    return was !== same(acc.banked);
  }

  #windows(agent: string, account: string, report: LimitsReport): Omit<Recorded, 'past'> {
    const acc = this.state.ensure(agent, account);
    const now = this.now();
    const share = this.ledger.sharers(accKey(agent, account), acc.at, now);
    const shares: Recorded['shares'] = [];
    const early: string[] = [];
    let moved = false;
    // Readings close together come from runs at work: what moved in between is theirs (Ask near
    // the limit learns its rate from it). A read is no run's report: chats it sees aren't the next run's.
    const close = !report.read && !!acc.at && now - acc.at <= LEARN_GAP;
    for (const w of report.windows) {
      if (!w?.id || !Number.isFinite(w.used)) continue;
      const was = acc.windows[w.id];
      if (!was && Object.keys(acc.windows).length >= MAX_WINDOWS) continue;
      const next: Win = { used: clamp(w.used), resetsAt: w.resetsAt || null, ms: w.ms || WINDOWS[w.id]?.ms || null };
      if (close && was && was.resetsAt === next.resetsAt && next.used > was.used) this.#learn(acc, w.id, next.used - was.used);
      if (!was || Math.round(was.used * 100) !== Math.round(next.used * 100) || was.resetsAt !== next.resetsAt) moved = true;
      if (resetEarly(was, next, now)) {
        (acc.early ??= {})[w.id] = { at: now, resetsAt: next.resetsAt };
        early.push(w.id);
      }
      // How far it moved since the last report: in a new period, all of what's used now.
      const d = !was ? 0 : samePeriod(was.resetsAt, next.resetsAt) ? next.used - was.used : was.resetsAt && was.resetsAt <= now ? next.used : 0;
      if (d > 0) for (const [e, part] of share) shares.push({ sid: e.sid, tid: e.tid, share: { agent, account, window: w.id, used: d * part, resetsAt: next.resetsAt } });
      if (was?.resetsAt && !samePeriod(was.resetsAt, next.resetsAt)) this.#closePeriod(agent, account, acc, w.id, was, now);
      acc.windows[w.id] = next;
    }
    if (shape(acc, report.windows, !!report.complete, early, now)) moved = true;
    acc.at = now;
    // maybe changed: rows.ts compares each row with what it last wrote, and writes only what differs
    this.state.touch(agent, account, 'acc', 'windows');
    return { moved, early, shares };
  }

  #learn(acc: Acc, id: string, du: number): void {
    const l = ((acc.learn ??= {})[id] ??= { du: 0, units: 0 });
    l.du += du;
    (acc.run ??= {})[id] = (acc.run[id] ?? 0) + du; // this run's, until spend()
  }

  /**
   * A period is over: keep its last reading. Runs at the same time can report out of order, so the
   * same period can close twice: the higher reading stands, and one that reached its reset wins.
   */
  #closePeriod(agent: string, account: string, acc: Acc, id: string, was: Win, now: number): void {
    const resetsAt = was.resetsAt;
    if (!resetsAt) return;
    const list = ((acc.periods ??= {})[id] ??= []);
    const cut = resetsAt > now;
    const e = list.find((x) => samePeriod(x.resetsAt, resetsAt));
    if (e) {
      e.used = Math.max(e.used, was.used);
      if (!cut) delete e.cut;
    } else list.push({ resetsAt, ms: was.ms, used: was.used, ...(cut && { cut: true }) });
    acc.periods[id] = list.sort((a, b) => a.resetsAt - b.resetsAt).slice(-PERIOD_KEEP);
    this.state.touch(agent, account, 'periods');
  }

  /** A window's closed periods, oldest first. */
  periods(agent: string, account: string, id: string): Period[] {
    return (this.state.get(agent, account)?.periods?.[id] ?? []).map((p) => ({ ...p }));
  }

  /** Every window that is in a known state: those over the share `stop` that reset later. */
  over(acc: Acc | undefined, stop: number, now: number): [string, Win][] {
    return Object.entries(acc?.windows ?? {}).filter(([, w]) => w.used >= stop - 1e-9 && !!w.resetsAt && w.resetsAt > now);
  }

  /**
   * When the account can run again after a limit: the latest reset among its full windows (the
   * one refused, else any at 100%), or null when it doesn't know.
   */
  resetAt(agent: string, account?: string): number | null {
    const acc = this.state.get(agent, account || 'default');
    if (!acc) return null;
    const full = this.over(acc, 0.995, this.now());
    return full.length ? Math.max(...full.map(([, w]) => w.resetsAt ?? 0)) : null;
  }

  /** You said yes at `line` to a window: the next ask for it comes higher, until it resets. */
  ack(agent: string, account: string, id: string, resetsAt: number | null, line: number): void {
    const acc = this.state.ensure(agent, account || 'default');
    (acc.acks ??= {})[id] = { resetsAt: resetsAt || null, line };
    this.state.touch(agent, account, 'acc');
  }

  /** The line you said yes at for this window, while it hasn't reset; 0 when you haven't. */
  acked(agent: string, account: string, id: string, resetsAt: number | null): number {
    const a = this.state.get(agent, account || 'default')?.acks?.[id];
    if (!a || !(a.line > 0)) return 0;
    if (a.resetsAt !== (resetsAt || null) || (a.resetsAt && a.resetsAt <= this.now())) return 0;
    return a.line;
  }
}

