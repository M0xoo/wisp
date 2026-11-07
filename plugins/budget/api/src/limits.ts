// What each CLI says of its usage windows, as the one report shape budget records (v1
// server/budget.js claudeLimits, codexLimits, codexLive, codexBanked). Pure: the harness modules
// (wisp.claude, wisp.codex) parse their events with these and report them in `turn.limits`.

import { WINDOWS } from './windows.ts';

export interface LimitWindow {
  id: string;
  used: number;
  resetsAt?: number | null;
  ms?: number | null;
  /** Codex: the slot it came in (primary, secondary): a slot under a new id is a length change */
  slot?: string;
}

/** One report: what a run (or a read) said of an account's windows. */
export interface LimitsReport {
  windows: LimitWindow[];
  /** it lists every window the plan has (a window it leaves out may be gone) */
  complete?: boolean;
  /** the window that refused the run */
  rejected?: string;
  /** this run is billed as extra usage, past the plan */
  overage?: boolean;
  /** Codex credits balance (billed past the plan's windows) */
  credits?: number;
  /** a read (Check Codex, the read before held-back work), not a run's report */
  read?: boolean;
  /** banked resets, as codexBanked() read them */
  banked?: Banked | null;
}

export interface BankedCredit {
  id: string;
  expiresAt: number | null;
}
export interface Banked {
  count: number;
  credits: BankedCredit[] | null;
  at?: number | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const clamp = (n: number): number => Math.min(1, Math.max(0, n));
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** seconds or ms → ms */
export const toMs = (s: unknown): number | null => (fin(s) && s > 0 ? (s < 1e12 ? s * 1000 : s) : null);

/**
 * Claude's rate_limit_event.rate_limit_info → a report, or null. rateLimitType "overage" is the
 * extra-usage allowance, not a plan window: never a row. A refusal without a number is a full window.
 */
export function claudeLimits(info: unknown): LimitsReport | null {
  if (!isObj(info)) return null;
  const windows: LimitWindow[] = [];
  const overage = info['isUsingOverage'] === true;
  const add = (id: unknown, w: Obj, used: unknown = w['utilization']): void => {
    if (!id || typeof id !== 'string' || id === 'overage' || !fin(used) || windows.some((x) => x.id === id)) return;
    windows.push({ id, used: clamp(used), resetsAt: toMs(w['resetsAt']), ms: WINDOWS[id]?.ms ?? null });
  };
  const unified = isObj(info['unifiedWindows']) ? info['unifiedWindows'] : {};
  for (const [id, w] of Object.entries(unified)) if (isObj(w)) add(id, w);
  // Every window the plan has (window changes): an event with only rateLimitType names one.
  const complete = windows.length > 0;
  const rejected = info['status'] === 'rejected';
  add(info['rateLimitType'], info, fin(info['utilization']) ? info['utilization'] : rejected ? 1 : NaN);
  if (!windows.length) return overage ? { windows, overage } : null;
  const type = info['rateLimitType'];
  return { windows, ...(complete && { complete }), ...(rejected && type !== 'overage' && { rejected: typeof type === 'string' ? type : '' }), ...(overage && { overage }) };
}

/** Codex's rate_limits (from its session file) → a report, or null. Windows are named by their length. */
export function codexLimits(rl: unknown, { now = Date.now() }: { now?: number } = {}): LimitsReport | null {
  if (!isObj(rl)) return null;
  const windows: LimitWindow[] = [];
  for (const slot of ['primary', 'secondary'] as const) {
    const w = rl[slot];
    if (!isObj(w) || !fin(w['used_percent'])) continue;
    const mins = Number(w['window_minutes']) || 0;
    const id = mins === 300 ? 'five_hour' : mins === 10080 ? 'seven_day' : mins ? `w${mins}m` : '';
    if (!id || windows.some((x) => x.id === id)) continue;
    const inS = w['resets_in_seconds'];
    const resetsAt = toMs(w['resets_at']) ?? (fin(inS) ? now + inS * 1000 : null);
    windows.push({ id, used: clamp(w['used_percent'] / 100), resetsAt, ms: mins ? mins * 60_000 : null, slot });
  }
  // credits: the balance Codex bills past the plan's windows (a string in its snapshot).
  const c = rl['credits'];
  const credits = isObj(c) && !c['unlimited'] ? Number(c['balance']) : NaN;
  const first = windows[0];
  if (!first) return null;
  const full = windows.find((w) => w.used >= 1);
  return { windows, complete: true, ...((rl['rate_limit_reached_type'] || full) && { rejected: full?.id ?? first.id }), ...(Number.isFinite(credits) && { credits }) };
}

const FROZEN_SKEW_MS = 5 * 60_000; // clocks disagree a little

function limitsOfLive(rl: unknown, now: number): LimitsReport | null {
  if (!isObj(rl)) return null;
  const w = (x: unknown): Obj | undefined => (isObj(x) && fin(x['usedPercent']) ? { used_percent: x['usedPercent'], window_minutes: x['windowDurationMins'], resets_at: x['resetsAt'] } : undefined);
  return codexLimits({ primary: w(rl['primary']), secondary: w(rl['secondary']), rate_limit_reached_type: rl['rateLimitReachedType'] || null }, { now });
}
const resetsOf = (rl: Obj): number[] => [rl['primary'], rl['secondary']].map((x) => (isObj(x) ? toMs(x['resetsAt']) : null)).filter((x): x is number => !!x);

/**
 * What Codex's app-server answers to account/rateLimits/read → a report, or null. The codex limit,
 * not a side one (premium, or a model's own bucket: normalModelSlug). A live answer never gives a
 * reset that's already gone, so a codex entry with one is frozen and the bucket with the latest
 * reset takes its place.
 */
export function codexLive(res: unknown, { now = Date.now() }: { now?: number } = {}): LimitsReport | null {
  if (!isObj(res)) return null;
  const byId = isObj(res['rateLimitsByLimitId']) ? res['rateLimitsByLimitId'] : undefined;
  const main = byId?.['codex'];
  const limits = limitsOfLive(main, now);
  if (!limits || !isObj(main)) return limitsOfLive(res['rateLimits'], now);
  const frozen = (rl: Obj): boolean => resetsOf(rl).some((at) => at < now - FROZEN_SKEW_MS);
  if (!frozen(main)) return limits;
  const side = (id: string, rl: Obj): boolean => !!rl['normalModelSlug'] || id === 'premium' || rl['limitId'] === 'premium';
  const latest = (rl: Obj): number => Math.max(0, ...resetsOf(rl));
  const candidates = [['', res['rateLimits']] as const, ...Object.entries(byId ?? {})].filter((e): e is readonly [string, Obj] => isObj(e[1]));
  const [next] = candidates.filter(([id, rl]) => id !== 'codex' && limitsOfLive(rl, now) && !side(id, rl) && !frozen(rl)).sort((a, b) => latest(b[1]) - latest(a[1]));
  return next ? limitsOfLive(next[1], now) : limits;
}

/**
 * Banked resets (OpenAI's reset credits) from the same answer: { count, credits } soonest first,
 * or null when the answer doesn't say. A credit past its expiry, or no longer available, isn't
 * counted. Read only: wisp never redeems one.
 */
export function codexBanked(res: unknown, { now = Date.now() }: { now?: number } = {}): Banked | null {
  const r = isObj(res) ? res['rateLimitResetCredits'] : undefined;
  if (!isObj(r) || !fin(r['availableCount'])) return null;
  let count = Math.max(0, Math.floor(r['availableCount']));
  const list = r['credits'];
  if (!Array.isArray(list)) return { count, credits: null };
  const credits: BankedCredit[] = [];
  for (const c of list) {
    if (!isObj(c) || (c['status'] && c['status'] !== 'available')) continue;
    const expiresAt = toMs(c['expiresAt']);
    if (expiresAt && expiresAt <= now) {
      count = Math.max(0, count - 1);
      continue;
    }
    const id = c['id'];
    credits.push({ id: typeof id === 'string' && id ? id.slice(0, 200) : `at:${expiresAt}`, expiresAt });
  }
  credits.sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
  return { count: Math.max(count, credits.length), credits: credits.slice(0, 20) };
}

/** What's left of a stored reading at now: credits that expired since drop out of the list and the count. */
export function bankedAt(b: Banked | null | undefined, now: number): (Banked & { at: number | null }) | null {
  if (!b || !Number.isFinite(b.count)) return null;
  if (!Array.isArray(b.credits)) return b.count > 0 ? { count: b.count, credits: null, at: b.at ?? null } : null;
  const credits = b.credits.filter((c) => !c.expiresAt || c.expiresAt > now);
  const count = Math.max(0, b.count - (b.credits.length - credits.length));
  return count > 0 ? { count, credits, at: b.at ?? null } : null;
}

/** The day before a banked reset expires the phone hears of it, once per credit: those due now. */
export const BANKED_NOTE_MS = 24 * 3600_000;
export const bankedDue = (b: Banked | null | undefined, sent: Readonly<Record<string, number>>, now: number): BankedCredit[] =>
  (bankedAt(b, now)?.credits ?? []).filter((c) => c.expiresAt && c.expiresAt - now <= BANKED_NOTE_MS && !sent[c.id]);
