// What the model says to its readers (v1 Budget.hold/windows/view and the small writes the page
// makes): fresh windows at 0, the hold for Automations stop at, Settings → Usage's accounts.

import type { AccountView, BankedCredit, BankedDue, Hold, OverageKind, OverageView, WindowNotice, WindowNow, WindowView } from '@wisp-plugin/budget-api';
import { bankedAt, bankedDue, paceOf, rank, samePeriod, windowLabel } from '@wisp-plugin/budget-api';
import { drainOf } from './drain.ts';
import type { Model } from './model.ts';
import { stale } from './shape.ts';
import type { Acc } from './state.ts';

const H = 3600_000;
const OVER_KEEP = 50; // runs billed past the plan, per account
const OVER_AGE = 7 * 24 * H;

/**
 * Automations stop at: the window that holds work back on this account, or null. until: when every
 * window past `stop` has reset. A window without a reset time holds nothing (no "until when").
 */
export function planHold(m: Model, agent: string, account: string, stop: number | null): Omit<Hold, 'why'> | null {
  if (!stop) return null;
  const over = m.over(m.state.get(agent, account), stop, m.now()).sort((a, b) => b[1].used - a[1].used);
  const top = over[0];
  if (!top) return null;
  const [id, w] = top;
  return { agent, account: account || 'default', window: id, label: windowLabel(id, w.ms), used: w.used, stop, until: Math.max(...over.map(([, x]) => x.resetsAt ?? 0)) };
}

/** An account's windows as they stand now, fresh ones at 0. */
export function windowsNow(m: Model, agent: string, account = 'default'): WindowNow[] {
  const acc = m.state.get(agent, account || 'default');
  const now = m.now();
  return Object.entries(acc?.windows ?? {})
    .filter(([id, w]) => !stale(acc, id, w, now))
    .map(([id, w]) => {
      const fresh = !!w.resetsAt && w.resetsAt <= now;
      return { id, label: windowLabel(id, w.ms), used: fresh ? 0 : w.used, resetsAt: fresh ? null : w.resetsAt, ms: w.ms || null };
    })
    .sort((a, b) => rank(a.id) - rank(b.id));
}

function viewWindows(acc: Acc, now: number): WindowView[] {
  return Object.entries(acc.windows)
    .filter(([id, w]) => !stale(acc, id, w, now))
    .map(([id, w]) => {
      const fresh = !!w.resetsAt && w.resetsAt <= now;
      const used = fresh ? 0 : w.used;
      const e = acc.early?.[id];
      const v: WindowView = { id, label: windowLabel(id, w.ms), used, resetsAt: fresh ? null : w.resetsAt, hitAt: fresh ? null : paceOf({ ...w, used }, now), ms: w.ms || null };
      if (e && !fresh && samePeriod(e.resetsAt, w.resetsAt)) v.earlyAt = e.at;
      return v;
    })
    .sort((a, b) => rank(a.id) - rank(b.id));
}

function overView(acc: Acc, now: number): OverageView | null {
  const list = (acc.over ?? []).filter((x) => x.at > now - OVER_AGE);
  const last = list.at(-1);
  if (!last) return null;
  return { runs: list.length, at: last.at, kind: last.kind, ...(last.sid && { sid: last.sid }) };
}

/** For the page: each account with something to show, most-known windows first. */
export function viewOf(m: Model, agent: string): AccountView[] {
  const now = m.now();
  const out: AccountView[] = [];
  for (const [account, acc] of m.state.of(agent)) {
    const windows = viewWindows(acc, now);
    const drain = drainOf(acc, now);
    const notices: WindowNotice[] = Object.values(acc.notices ?? {}).map((n) => ({
      ...n, label: windowLabel(n.window, n.ms), ...(n.wasMs && { wasLabel: windowLabel(n.wasWindow ?? '', n.wasMs) }),
    }));
    const overage = overView(acc, now);
    const banked = agent === 'codex' ? bankedAt(acc.banked, now) : null;
    if (!windows.length && !notices.length && !overage && !banked) continue;
    out.push({ account, at: acc.at ?? null, windows, ...(drain && { drain }), ...(notices.length && { notices }), ...(overage && { overage }), ...(banked && { banked }) });
  }
  return out;
}

/** A run on the account was billed past its plan. Once per turn; a week is kept. Returns whether it was new. */
export function overage(m: Model, agent: string, account: string, kind: OverageKind, sid?: string, tid?: string): boolean {
  if (!agent || !kind) return false;
  const acc = m.state.ensure(agent, account || 'default');
  const now = m.now();
  const list = (acc.over ?? []).filter((x) => x.at > now - OVER_AGE);
  if (list.some((x) => x.sid === sid && x.tid === tid)) return false;
  list.push({ at: now, kind, ...(sid && { sid }), ...(tid && { tid }) });
  acc.over = list.slice(-OVER_KEEP);
  m.state.touch(agent, account, 'acc');
  return true;
}

/** The banked credits of each account of agent whose note is due. */
export function dueOf(m: Model, agent: string): BankedDue[] {
  const now = m.now();
  const out: BankedDue[] = [];
  for (const [account, acc] of m.state.of(agent)) {
    const b = bankedAt(acc.banked, now);
    for (const credit of bankedDue(acc.banked, acc.bankedSent ?? {}, now)) out.push({ account, credit, count: b?.count ?? 0 });
  }
  return out;
}

/** Its note went: never again for that credit. Entries go once their credit has expired. */
export function sent(m: Model, agent: string, account: string, credit: BankedCredit): void {
  const acc = m.state.get(agent, account || 'default');
  if (!acc) return;
  const now = m.now();
  const kept = Object.fromEntries(Object.entries(acc.bankedSent ?? {}).filter(([, at]) => !at || at > now));
  kept[credit.id] = credit.expiresAt || 0;
  acc.bankedSent = kept;
  m.state.touch(agent, account, 'acc');
}

/** Hide that window's drain card until a later run shows it again. */
export function dismissDrain(m: Model, agent: string, account: string, id: string): boolean {
  const acc = m.state.get(agent, account || 'default');
  if (!acc?.drain?.[id]) return false;
  (acc.drainSeen ??= {})[id] = m.now();
  m.state.touch(agent, account, 'acc');
  return true;
}

/** × on a window's notice: gone until that window changes again. */
export function dismissNotice(m: Model, agent: string, account: string, id: string): boolean {
  const acc = m.state.get(agent, account || 'default');
  if (!acc?.notices?.[id]) return false;
  delete acc.notices[id];
  m.state.touch(agent, account, 'acc');
  return true;
}
