// Window changes (v1 Budget.#shape, design/budget.md): a plan's window that appears, goes, changes
// length or moves its reset. What wisp last saw of each window is kept in acc.shape, so a restart
// doesn't announce anything again; each change leaves acc.notices[id] until it's dismissed or the
// next change of that window replaces it. The first report of an account only sets what was seen.

import type { LimitWindow } from '@wisp-plugin/budget-api';
import { samePeriod } from '@wisp-plugin/budget-api';
import type { Acc, NoticeRow, Seen, Win } from './state.ts';

const H = 3600_000;
const GONE_MISS = 3; // a window is gone once this many reports in a row over GONE_AGE left it out
const GONE_AGE = 6 * H;

/**
 * A long window's reset moved off its schedule (its old reset plus whole periods), beyond Codex's
 * drift. The 5-hour window starts at your first message, so its reset always moves: never counted.
 */
function shifted(was: Seen, cur: Win): boolean {
  if (!(cur.ms && cur.ms >= 24 * H) || !was.resetsAt || !cur.resetsAt || samePeriod(was.resetsAt, cur.resetsAt)) return false;
  const r = (((cur.resetsAt - was.resetsAt) % cur.ms) + cur.ms) % cur.ms;
  return Math.min(r, cur.ms - r) > 10 * 60_000;
}

interface Ctx {
  acc: Acc;
  seen: Record<string, Seen>;
  first: boolean;
  now: number;
  note(id: string, n: Omit<NoticeRow, 'window' | 'at'>): void;
}

/** One reported window against what was seen of it. */
function seeWindow(c: Ctx, w: LimitWindow, windows: readonly LimitWindow[], complete: boolean, early: readonly string[]): void {
  const cur = c.acc.windows[w.id];
  if (!cur) return; // over MAX_WINDOWS
  const was = c.seen[w.id];
  const next: Seen = { ms: cur.ms, resetsAt: cur.resetsAt, slot: w.slot ?? null, at: c.now, miss: 0 };
  if (!was) {
    // Codex names a window by its length: the same slot under a new id is a length change.
    const old = !c.first && w.slot ? Object.entries(c.seen).find(([id, x]) => x.slot === w.slot && id !== w.id && !windows.some((y) => y.id === id)) : undefined;
    if (old) {
      const [oid, o] = old;
      delete c.seen[oid];
      delete c.acc.windows[oid];
      if (c.acc.notices) delete c.acc.notices[oid];
      c.note(w.id, { kind: 'length', ms: cur.ms, wasMs: o.ms, wasWindow: oid, resetsAt: cur.resetsAt });
    } else if (!c.first && !complete) return; // only a report of every window says it's new
    else if (!c.first) c.note(w.id, { kind: 'new', ms: cur.ms, resetsAt: cur.resetsAt });
  } else if (was.ms && cur.ms && Math.abs(was.ms - cur.ms) > 60_000) {
    c.note(w.id, { kind: 'length', ms: cur.ms, wasMs: was.ms, resetsAt: cur.resetsAt });
  } else if (shifted(was, cur) && !early.includes(w.id) && cur.ms && cur.resetsAt && was.resetsAt) {
    // An early (banked) reset moves it too, but has its own line (earlyAt).
    c.note(w.id, { kind: 'reset', ms: cur.ms, resetsAt: cur.resetsAt, wasResetsAt: was.resetsAt + Math.round((cur.resetsAt - was.resetsAt) / cur.ms) * cur.ms });
  }
  c.seen[w.id] = next;
}

/** Returns whether a notice was added. */
export function shape(acc: Acc, windows: readonly LimitWindow[], complete: boolean, early: readonly string[], now: number): boolean {
  const sh = (acc.shape ??= { since: now, n: 0, windows: {} });
  const first = !sh.n;
  // n only ever says whether this is the first report: it stops at 2 so a steady account's row stays still
  sh.n = Math.min(sh.n + 1, 2);
  let added = false;
  const c: Ctx = {
    acc, seen: sh.windows, first, now,
    note: (id, n) => {
      (acc.notices ??= {})[id] = { window: id, at: now, ...n };
      added = true;
    },
  };
  const got = new Set<string>();
  for (const w of windows) {
    if (!w?.id || !Number.isFinite(w.used)) continue;
    got.add(w.id);
    seeWindow(c, w, windows, complete, early);
  }
  // Gone: missing from several reports that list every window, over hours (a report can skip one).
  if (complete && !first)
    for (const [id, x] of Object.entries(c.seen)) {
      if (got.has(id) || ++x.miss < GONE_MISS || now - x.at < GONE_AGE) continue;
      delete c.seen[id];
      delete acc.windows[id];
      c.note(id, { kind: 'gone', ms: x.ms, resetsAt: x.resetsAt });
    }
  return added;
}

/**
 * A window the last report of every window left out (Claude Ultra's gone 5-hour one), once its
 * reset has passed: there's nothing to show but an empty bar until shape() calls it gone.
 */
export const stale = (acc: Acc | undefined, id: string, w: Win, now: number): boolean => !!acc?.shape?.windows[id]?.miss && (!w.resetsAt || w.resetsAt <= now);
