// Plan budget: how much of each account's usage windows is gone (Claude's 5-hour and weekly ones,
// Codex's), from what the CLI itself reports on every run, and when you'd run out at this pace.
// Nothing is asked of the provider: Claude prints a rate_limit_event in its stream, Codex writes
// rate_limits into its session file. A window whose reset has passed reads as fresh. The one
// exception: while Codex work waits for a reset, wisp may ask Codex's app-server how the windows
// stand (server/live-limits.js, Settings → Usage → Check Codex while work waits), so a reset that
// comes early (OpenAI's banked resets) lets that work go at once: onReset.
//
// ~/.wisp/budget.json: { [agent]: { [account]: { at, windows: { [id]: { used, resetsAt, ms } },
// learn: { [id]: { du, units } }, acks: { [id]: { resetsAt, line } },
// periods: { [id]: [{ resetsAt, ms, used, cut? }] } } } }
// used: 0..1, resetsAt: ms, ms: the window's length (for the pace). account: 'default' for the CLI's own.
// periods: each window's closed periods, oldest first, with their last reading. cut: it ended before
// its reset (an early reset, a moved one). server/allowance.js reads them (design/budget.md).
//
// Two uses on top of the numbers (design/budget.md):
// - Automations stop at (defaults.autoStop): work nobody started by hand (check-ins, triggers, goal
//   rounds, agents' own follow-ups) waits while its account is past that share of a window: hold().
// - Where it went: each move of a window is shared out among the turns that ran on that account
//   since the last report (by how long each ran then), and kept on the turn as turn.plan. Claude
//   reports once per run, after its first reply, so a turn's share lands with the next report.
//
// learn and acks are Ask near the limit's (server/guard.js): how far the window moved while wisp's
// runs worked, against the units of work they did, and the line you last said yes at.
// drain is Drain watch's (defaults.drainWatch): the same move per run, kept run by run for two weeks,
// so a plan that suddenly moves much faster for the same work stands out (drain(), design/budget.md).
// over is Past your plan's: runs billed beyond the plan (Claude's extra usage, Codex credits, an API
// key), kept for a week; each one also marks its turn (turn.overage, runner.js).

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic } from './util.js';
import { COMPARE_DAYS, COMPARE_MIN, median, turnOutput, turnTokens } from '../web/js/receipt.js';

const H = 3600_000;
// What wisp calls each window, and how long it is when the CLI doesn't say.
export const WINDOWS = {
  five_hour: { label: '5-hour', ms: 5 * H },
  seven_day: { label: 'Weekly', ms: 7 * 24 * H },
  seven_day_opus: { label: 'Weekly Opus', ms: 7 * 24 * H },
  seven_day_sonnet: { label: 'Weekly Sonnet', ms: 7 * 24 * H },
};
const ORDER = Object.keys(WINDOWS);
// Settings → Usage → Automations stop at: 'off', or the percent of a window.
export const STOP_AT = ['off', '50', '75', '90'];
export const stopAtOf = (v) => (STOP_AT.includes(String(v)) && String(v) !== 'off' ? Number(v) / 100 : null);
// The same, for one harness: its own line, or 'same' (unset) to follow Automations stop at. ChatGPT
// and Codex share one allowance, so a Codex line lower than Claude's leaves room for your chats.
export const STOP_KEYS = { claude: 'autoStopClaude', codex: 'autoStopCodex' };
export const STOP_BY = ['same', ...STOP_AT];
export const stopFor = (defaults = {}, agent) => {
  const own = defaults[STOP_KEYS[agent]];
  return stopAtOf(STOP_AT.includes(own) ? own : defaults.autoStop);
};
// Two reports of the same window period: Codex's reset can drift when it only says "in n seconds".
export const samePeriod = (a, b) => !!a && !!b && Math.abs(a - b) < 10 * 60_000;
// A window that reset before its time (a banked reset): its old reset hadn't come, now much less is
// used, and the new reset is a period later. Codex's drifting "in n seconds" alone never counts.
export const resetEarly = (was, next, now) =>
  !!was?.resetsAt && was.resetsAt > now && !!next.resetsAt && next.resetsAt - was.resetsAt > 10 * 60_000 && (was.used - next.used >= 0.25 || (next.used < 0.05 && was.used >= 0.1));
const PERIOD_KEEP = 40; // closed periods remembered per window
const MAX_LEDGER = 100; // turns remembered per account between two reports
const MAX_WINDOWS = 6; // a CLI that starts reporting dozens doesn't grow the file
const clamp = (n) => Math.min(1, Math.max(0, n));
const LEARN_GAP = 30 * 60_000; // readings further apart than this may hide use outside wisp
const LEARN_MIN = 0.02; // two points moved before a rate counts (the CLI reports whole percents)
const LEARN_KEEP = 0.3; // past this many points, halve: the rate follows the recent runs
// Drain watch: the runs of the last two hours against the two weeks before them.
const DRAIN_KEEP = 40; // runs remembered per window
const DRAIN_AGE = 14 * 864e5;
const DRAIN_RECENT = 2 * H;
const DRAIN_RATIO = 2; // this many times the usual share per unit of work
const DRAIN_MIN = { runs: 5, du: 0.03 }; // what "usual" needs before it means anything
const DRAIN_NOW = { runs: 2, du: 0.05 }; // and the recent runs (the CLI reports whole percents)
// Window changes: a window counts as gone once this many reports in a row over this long left it out.
const GONE_MISS = 3;
const OVER_KEEP = 50; // runs billed past the plan, per account
const OVER_AGE = 7 * 24 * H;
const GONE_AGE = 6 * H;
// A long window's reset moved off its schedule (its old reset plus whole periods), beyond Codex's
// drift. The 5-hour window starts at your first message, so its reset always moves: never counted.
const shifted = (was, cur) => {
  if (!(cur.ms >= 24 * H) || !was.resetsAt || !cur.resetsAt || samePeriod(was.resetsAt, cur.resetsAt)) return false;
  const r = (((cur.resetsAt - was.resetsAt) % cur.ms) + cur.ms) % cur.ms;
  return Math.min(r, cur.ms - r) > 10 * 60_000;
};
const toMs = (s) => (Number.isFinite(s) && s > 0 ? (s < 1e12 ? s * 1000 : s) : null); // seconds or ms

function readJson(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// When you'd use the whole window at the pace since it started, or null: not before the reset,
// already used up, or too early to tell (under 5% gone, or the first half hour).
export function paceOf({ used, resetsAt, ms }, now = Date.now()) {
  if (!ms || !resetsAt || resetsAt <= now || !(used > 0) || used >= 1) return null;
  const spent = now - (resetsAt - ms);
  if (used < 0.05 || spent < Math.min(ms / 10, H / 2)) return null;
  const at = Math.round(now + ((1 - used) * spent) / used);
  return at < resetsAt ? at : null;
}

// A run's units of work: its cost where the harness says it, else its tokens in millions.
export function unitsOf(stats) {
  if (!stats || stats.baseline) return 0; // a brought-in chat's first turn has no cost of its own: not a sample
  if (typeof stats.costUsd === 'number' && stats.costUsd > 0) return stats.costUsd;
  const tokens = (stats.inputTokens || 0) - (stats.cachedInputTokens || 0) + (stats.outputTokens || 0);
  return tokens > 0 ? tokens / 1e6 : 0;
}

// Claude's rate_limit_event.rate_limit_info → { windows, rejected?, overage? } or null.
// { status, rateLimitType, utilization, resetsAt (s), unifiedWindows: { five_hour: { utilization, resetsAt } },
//   isUsingOverage, overageStatus }. overage: this run is billed as extra usage, past the plan.
// rateLimitType "overage" is the extra-usage allowance, not a plan window: never a row.
export function claudeLimits(info) {
  if (!info || typeof info !== 'object') return null;
  const windows = [];
  const overage = info.isUsingOverage === true;
  const add = (id, w, used = w?.utilization) => {
    if (!id || typeof id !== 'string' || id === 'overage' || !Number.isFinite(used) || windows.some((x) => x.id === id)) return;
    windows.push({ id, used: clamp(used), resetsAt: toMs(w.resetsAt), ms: WINDOWS[id]?.ms ?? null });
  };
  for (const [id, w] of Object.entries(info.unifiedWindows || {})) if (w && typeof w === 'object') add(id, w);
  // Every window the plan has (window changes, below): an event with only rateLimitType names one.
  const complete = windows.length > 0;
  const rejected = info.status === 'rejected';
  // A refusal without a number is a full window.
  add(info.rateLimitType, info, Number.isFinite(info.utilization) ? info.utilization : rejected ? 1 : NaN);
  if (!windows.length) return overage ? { windows, overage } : null;
  return { windows, ...(complete && { complete }), ...(rejected && info.rateLimitType !== 'overage' && { rejected: String(info.rateLimitType || '') }), ...(overage && { overage }) };
}

// Codex's rate_limits (from its session file) → { windows, rejected? } or null.
// { primary: { used_percent, window_minutes, resets_at (s) }, secondary: {…}, rate_limit_reached_type }
export function codexLimits(rl) {
  if (!rl || typeof rl !== 'object') return null;
  const windows = [];
  for (const [slot, w] of [['primary', rl.primary], ['secondary', rl.secondary]]) {
    if (!w || !Number.isFinite(w.used_percent)) continue;
    const mins = Number(w.window_minutes) || 0;
    const id = mins === 300 ? 'five_hour' : mins === 10080 ? 'seven_day' : mins ? `w${mins}m` : '';
    if (!id || windows.some((x) => x.id === id)) continue;
    const resetsAt = toMs(w.resets_at) ?? (Number.isFinite(w.resets_in_seconds) ? Date.now() + w.resets_in_seconds * 1000 : null);
    // slot: a window that changes length keeps its slot and gets a new id (window changes, below).
    windows.push({ id, used: clamp(w.used_percent / 100), resetsAt, ms: mins ? mins * 60_000 : null, slot });
  }
  // credits: the balance Codex bills past the plan's windows (a string in its snapshot). A drop
  // between two reports is a run billed past the plan (Budget.record).
  const credits = rl.credits && !rl.credits.unlimited ? Number(rl.credits.balance) : NaN;
  if (!windows.length) return null;
  const full = windows.find((w) => w.used >= 1);
  return { windows, complete: true, ...((rl.rate_limit_reached_type || full) && { rejected: full?.id || windows[0].id }), ...(Number.isFinite(credits) && { credits }) };
}

// What Codex's app-server answers to account/rateLimits/read → codexLimits' input (its own fields
// in camelCase), or null. The codex limit, not another one (premium) it may also list.
export function codexLive(res) {
  const rl = res?.rateLimitsByLimitId?.codex || res?.rateLimits;
  if (!rl || typeof rl !== 'object') return null;
  const w = (x) => x && Number.isFinite(x.usedPercent) && { used_percent: x.usedPercent, window_minutes: x.windowDurationMins, resets_at: x.resetsAt };
  return codexLimits({ primary: w(rl.primary), secondary: w(rl.secondary), rate_limit_reached_type: rl.rateLimitReachedType || null });
}

// The rate_limits Codex wrote last into a thread's session file (CODEX_HOME/sessions/yyyy/mm/dd/
// rollout-…-<thread>.jsonl), or null. A resumed thread keeps its first day's file: look back a month.
export function codexRollout(threadId, { home = path.join(os.homedir(), '.codex'), now = Date.now() } = {}) {
  if (!threadId || !/^[\w-]+$/.test(threadId)) return null;
  for (let d = 0; d < 31; d++) {
    const day = new Date(now - d * 24 * H);
    const dir = path.join(home, 'sessions', String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
    let name;
    try {
      name = fs.readdirSync(dir).find((f) => f.endsWith(`-${threadId}.jsonl`));
    } catch {
      continue;
    }
    if (!name) continue;
    return lastRateLimits(path.join(dir, name));
  }
  return null;
}

// Only the file's tail: a long session's file runs to megabytes.
function lastRateLimits(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limits"')) continue;
      try {
        const rl = JSON.parse(lines[i])?.payload?.rate_limits;
        if (rl && (rl.primary || rl.secondary)) return rl; // a line for another limit (premium) has neither
      } catch {}
    }
  } catch {
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return null;
}

export class Budget {
  // onChange(): a number the page shows moved (wisp broadcasts 'agents').
  // onShare(sessionId, turnId, { agent, account, window, used, resetsAt }): a turn's part of a move.
  // onDrain(agent, account, drain): a run ended while the account drains (Drain watch).
  // onReset(agent, account, ids): those windows reset before the time they last gave.
  constructor(home, { now = () => Date.now(), onChange = () => {}, onShare = () => {}, onDrain = () => {}, onReset = () => {} } = {}) {
    this.file = path.join(home, 'budget.json');
    this.now = now;
    this.onChange = onChange;
    this.onShare = onShare;
    this.onDrain = onDrain;
    this.onReset = onReset;
    this.state = readJson(this.file) || {};
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      writeJsonAtomic(this.file, this.state);
    } catch (err) {
      console.warn(`wisp: budget: ${err.message}`);
    }
  }

  // What a run reported: { windows: [{ id, used, resetsAt, ms }], rejected?, overage?, credits? }.
  // Returns 'extra' or 'credits' when this report says the run is billed past the plan, else null.
  record(agent, account, { windows = [], complete = false, overage = false, credits } = {}) {
    if (!agent || !Array.isArray(windows)) return null;
    account ||= 'default';
    let past = overage ? 'extra' : null;
    if (Number.isFinite(credits)) {
      const acc = ((this.state[agent] ||= {})[account] ||= { windows: {} });
      if (Number.isFinite(acc.credits) && credits < acc.credits - 1e-9) past = 'credits';
      acc.credits = credits;
    }
    if (!windows.length) {
      if (past || Number.isFinite(credits)) this.save();
      return past;
    }
    const acc = ((this.state[agent] ||= {})[account] ||= { windows: {} });
    const now = this.now();
    const share = this.#sharers(agent, account, acc.at, now);
    let moved = false;
    const early = [];
    // Readings close together come from runs at work: what moved in between is theirs (Ask near
    // the limit learns its rate from it). Use outside wisp in that time counts too, which only
    // makes wisp ask a little sooner.
    const close = acc.at && this.now() - acc.at <= LEARN_GAP;
    for (const w of windows) {
      if (!w?.id || !Number.isFinite(w.used)) continue;
      const was = acc.windows[w.id];
      if (!was && Object.keys(acc.windows).length >= MAX_WINDOWS) continue;
      const next = { used: clamp(w.used), resetsAt: w.resetsAt || null, ms: w.ms || WINDOWS[w.id]?.ms || null };
      if (close && was && was.resetsAt === next.resetsAt && next.used > was.used) {
        const l = ((acc.learn ||= {})[w.id] ||= { du: 0, units: 0 });
        l.du += next.used - was.used;
        (acc.run ||= {})[w.id] = (acc.run[w.id] || 0) + next.used - was.used; // this run's, until spend()
      }
      if (!was || Math.round(was.used * 100) !== Math.round(next.used * 100) || was.resetsAt !== next.resetsAt) moved = true;
      if (resetEarly(was, next, now)) {
        (acc.early ||= {})[w.id] = { at: now, resetsAt: next.resetsAt };
        early.push(w.id);
      }
      // How far it moved since the last report: in a new period, all of what's used now.
      const d = !was ? 0 : samePeriod(was.resetsAt, next.resetsAt) ? next.used - was.used : was.resetsAt && was.resetsAt <= now ? next.used : 0;
      if (d > 0 && share.length) for (const [k, part] of share) this.onShare(k.sid, k.tid, { agent, account, window: w.id, used: d * part, resetsAt: next.resetsAt });
      if (was?.resetsAt && !samePeriod(was.resetsAt, next.resetsAt)) this.#closePeriod(acc, w.id, was, now);
      acc.windows[w.id] = next;
    }
    if (this.#shape(acc, windows, complete, early, now)) moved = true;
    acc.at = now;
    this.save();
    if (moved) this.onChange();
    if (early.length) this.onReset(agent, account, early);
    return past;
  }

  // A period is over: keep its last reading. Runs at the same time can report out of order, so the
  // same period can close twice: the higher reading stands, and one that reached its reset wins.
  #closePeriod(acc, id, was, now) {
    const list = ((acc.periods ||= {})[id] ||= []);
    const cut = was.resetsAt > now;
    const e = list.find((x) => samePeriod(x.resetsAt, was.resetsAt));
    if (e) {
      e.used = Math.max(e.used, was.used);
      if (!cut) delete e.cut;
    } else list.push({ resetsAt: was.resetsAt, ms: was.ms, used: was.used, ...(cut && { cut: true }) });
    acc.periods[id] = list.sort((a, b) => a.resetsAt - b.resetsAt).slice(-PERIOD_KEEP);
  }

  // A window's closed periods, oldest first.
  periods(agent, account, id) {
    return [...(this.state[agent]?.[account || 'default']?.periods?.[id] || [])];
  }

  // --- past your plan: runs billed beyond the plan's windows ---------------------------------------

  // A run on the account was billed past its plan: kind 'extra' (Claude's extra usage), 'credits'
  // (Codex credits) or 'api' (an API key, not the plan). Once per turn; a week is kept.
  overage(agent, account, kind, sid, tid) {
    if (!agent || !kind) return;
    const acc = ((this.state[agent] ||= {})[account || 'default'] ||= { windows: {} });
    const now = this.now();
    const list = (acc.over || []).filter((x) => x.at > now - OVER_AGE);
    if (list.some((x) => x.sid === sid && x.tid === tid)) return;
    list.push({ at: now, kind, sid, tid });
    acc.over = list.slice(-OVER_KEEP);
    this.save();
    this.onChange();
  }

  // For Plan budget: { runs, at, kind, sid } over the last week, or null.
  #overView(acc, now) {
    const list = (acc.over || []).filter((x) => x.at > now - OVER_AGE);
    if (!list.length) return null;
    const last = list.at(-1);
    return { runs: list.length, at: last.at, kind: last.kind, ...(last.sid && { sid: last.sid }) };
  }

  // --- where it went: the turns that ran on an account between two of its reports ---------------

  // A turn starts or ends on an account (runner.js). Kept in memory: after a restart, what ran
  // before it isn't traced.
  begin(agent, account, sid, tid) {
    const list = this.#ledger(agent, account);
    list.push({ sid, tid, from: this.now(), to: null });
    if (list.length > MAX_LEDGER) list.splice(0, list.length - MAX_LEDGER);
  }

  end(agent, account, sid, tid) {
    const e = this.#ledger(agent, account).findLast((x) => x.sid === sid && x.tid === tid && !x.to);
    if (e) e.to = this.now();
  }

  #ledger(agent, account) {
    this.ledger ||= new Map();
    const key = `${agent}@${account || 'default'}`;
    if (!this.ledger.has(key)) this.ledger.set(key, []);
    return this.ledger.get(key);
  }

  // [[turn, part]]: each turn's part of the time turns ran on the account since `since` (the last
  // report); the ones that ended are let go. None: the move happened outside wisp.
  #sharers(agent, account, since, now) {
    const list = this.#ledger(agent, account);
    const start = since || now;
    const spans = list.map((e) => [e, Math.max(0, Math.min(e.to ?? now, now) - Math.max(e.from, start))]).filter(([e, ms]) => ms > 0 || (!e.to && e.from >= start));
    // A run that reports the moment it starts (no time yet) still counts: it's what moved it.
    const total = spans.reduce((t, [, ms]) => t + ms, 0);
    const out = spans.map(([e, ms]) => [e, total ? ms / total : 1 / spans.length]);
    this.ledger.set(`${agent}@${account || 'default'}`, list.filter((e) => !e.to));
    return out;
  }

  // Automations stop at: the window that holds work back on this account, or null.
  // { agent, account, window, label, used, stop, until }: until is when every window past `stop`
  // has reset. A window without a reset time doesn't hold anything (wisp couldn't say until when).
  hold(agent, account, stop) {
    if (!stop) return null;
    const acc = this.state[agent]?.[account || 'default'];
    const now = this.now();
    const over = Object.entries(acc?.windows || {}).filter(([, w]) => w.used >= stop - 1e-9 && w.resetsAt > now);
    if (!over.length) return null;
    const [id, w] = over.sort((a, b) => b[1].used - a[1].used)[0];
    return { agent, account: account || 'default', window: id, label: WINDOWS[id]?.label || labelOf(w.ms), used: w.used, stop, until: Math.max(...over.map(([, x]) => x.resetsAt)) };
  }

  // When the account can run again after a limit: the latest reset among its full windows (the
  // one refused, else any at 100%), or null when it doesn't know.
  resetAt(agent, account) {
    const acc = this.state[agent]?.[account || 'default'];
    if (!acc) return null;
    const now = this.now();
    const full = Object.values(acc.windows || {}).filter((w) => w.used >= 0.995 && w.resetsAt > now);
    return full.length ? Math.max(...full.map((w) => w.resetsAt)) : null;
  }

  // An account's windows as they stand now: [{ id, label, used, resetsAt, ms }], fresh ones at 0.
  windows(agent, account) {
    const acc = this.state[agent]?.[account || 'default'];
    const now = this.now();
    return Object.entries(acc?.windows || {})
      .filter(([id, w]) => !stale(acc, id, w, now))
      .map(([id, w]) => {
        const fresh = w.resetsAt && w.resetsAt <= now;
        return { id, label: WINDOWS[id]?.label || labelOf(w.ms), used: fresh ? 0 : w.used, resetsAt: fresh ? null : w.resetsAt, ms: w.ms || null };
      })
      .sort((a, b) => rank(a.id) - rank(b.id));
  }

  // A run on the account ended: its units of work count against what the windows moved. failed: it
  // ended in an error (Drain watch says how much of the plan those still took).
  spend(agent, account, units, { failed = false } = {}) {
    const acc = this.state[agent]?.[account || 'default'];
    if (!acc || !(units > 0)) return;
    const now = this.now();
    for (const id of Object.keys(acc.windows || {})) {
      const l = ((acc.learn ||= {})[id] ||= { du: 0, units: 0 });
      l.units += units;
      if (l.du > LEARN_KEEP) (l.du /= 2), (l.units /= 2);
      // Runs at the same time share what moved in between: the first to end takes it. Over a few
      // runs that evens out, which is all Drain watch needs.
      const list = ((acc.drain ||= {})[id] ||= []).filter((x) => x.at > now - DRAIN_AGE);
      list.push({ at: now, du: Math.max(0, acc.run?.[id] || 0), units, ...(failed && { failed: true }) });
      acc.drain[id] = list.slice(-DRAIN_KEEP);
    }
    delete acc.run;
    this.save();
    const d = this.drain(agent, account);
    if (d) {
      this.onChange();
      this.onDrain(agent, account || 'default', d);
    }
  }

  // Drain watch: the window whose last two hours of runs took DRAIN_RATIO times or more its usual
  // share per unit of work, or null. { id, label, ratio, since, runs, units, du, usual, failed:
  // { runs, du } }. Dismissed (drainSeen) until a run after that says so again.
  drain(agent, account) {
    const acc = this.state[agent]?.[account || 'default'];
    const now = this.now();
    let best = null;
    for (const [id, all] of Object.entries(acc?.drain || {})) {
      const list = all.filter((x) => x.at > now - DRAIN_AGE);
      const recent = list.filter((x) => x.at > now - DRAIN_RECENT);
      const before = list.filter((x) => x.at <= now - DRAIN_RECENT);
      const sum = (xs, k) => xs.reduce((t, x) => t + x[k], 0);
      const [bu, bd, ru, rd] = [sum(before, 'units'), sum(before, 'du'), sum(recent, 'units'), sum(recent, 'du')];
      if (before.length < DRAIN_MIN.runs || bd < DRAIN_MIN.du || !(bu > 0)) continue;
      if (recent.length < DRAIN_NOW.runs || rd < DRAIN_NOW.du || !(ru > 0)) continue;
      if (acc.drainSeen?.[id] >= recent.at(-1).at) continue;
      const usual = bd / bu;
      const ratio = rd / ru / usual;
      if (ratio < DRAIN_RATIO || (best && best.ratio >= ratio)) continue;
      const failed = recent.filter((x) => x.failed);
      const w = acc.windows?.[id];
      best = { id, label: WINDOWS[id]?.label || labelOf(w?.ms), ratio, since: recent[0].at, runs: recent.length, units: ru, du: rd, usual, failed: { runs: failed.length, du: sum(failed, 'du') } };
    }
    return best;
  }

  // Hide that window's drain card until a later run shows it again.
  dismissDrain(agent, account, id) {
    const acc = this.state[agent]?.[account || 'default'];
    if (!acc?.drain?.[id]) return false;
    (acc.drainSeen ||= {})[id] = this.now();
    this.save();
    this.onChange();
    return true;
  }

  // --- window changes: a plan's window that appears, goes, changes length or moves its reset -----
  // (design/budget.md). What wisp last saw of each window is kept in acc.shape, so a restart doesn't
  // announce anything again; each change leaves acc.notices[id] until it's dismissed or the next
  // change of that window replaces it. The first report of an account only sets what was seen.
  // Returns whether a notice was added.
  #shape(acc, windows, complete, early, now) {
    const sh = (acc.shape ||= { since: now, n: 0, windows: {} });
    const first = !sh.n++;
    const seen = sh.windows;
    const got = new Set();
    let added = false;
    const note = (id, n) => {
      (acc.notices ||= {})[id] = { window: id, at: now, ...n };
      added = true;
    };
    for (const w of windows) {
      if (!w?.id || !Number.isFinite(w.used)) continue;
      got.add(w.id);
      const cur = acc.windows[w.id];
      if (!cur) continue; // over MAX_WINDOWS
      const was = seen[w.id];
      const now_ = { ms: cur.ms, resetsAt: cur.resetsAt, slot: w.slot || null, at: now, miss: 0 };
      if (!was) {
        // Codex names a window by its length: the same slot under a new id is a length change.
        const old = !first && w.slot && Object.entries(seen).find(([id, x]) => x.slot === w.slot && id !== w.id && !windows.some((y) => y.id === id));
        if (old) {
          const [oid, o] = old;
          delete seen[oid];
          delete acc.windows[oid];
          delete acc.notices?.[oid];
          note(w.id, { kind: 'length', ms: cur.ms, wasMs: o.ms, wasWindow: oid, resetsAt: cur.resetsAt });
        } else if (!first && !complete) continue; // only a report of every window says it's new
        else if (!first) note(w.id, { kind: 'new', ms: cur.ms, resetsAt: cur.resetsAt });
      } else if (was.ms && cur.ms && Math.abs(was.ms - cur.ms) > 60_000) {
        note(w.id, { kind: 'length', ms: cur.ms, wasMs: was.ms, resetsAt: cur.resetsAt });
      } else if (shifted(was, cur) && !early.includes(w.id)) {
        // An early (banked) reset moves it too, but has its own line (earlyAt).
        note(w.id, { kind: 'reset', ms: cur.ms, resetsAt: cur.resetsAt, wasResetsAt: was.resetsAt + Math.round((cur.resetsAt - was.resetsAt) / cur.ms) * cur.ms });
      }
      seen[w.id] = now_;
    }
    // Gone: missing from several reports that list every window, over hours (a report can skip one).
    if (complete && !first)
      for (const [id, x] of Object.entries(seen)) {
        if (got.has(id) || ++x.miss < GONE_MISS || now - x.at < GONE_AGE) continue;
        delete seen[id];
        delete acc.windows[id];
        note(id, { kind: 'gone', ms: x.ms, resetsAt: x.resetsAt });
      }
    return added;
  }

  // × on a window's notice: gone until that window changes again.
  dismissNotice(agent, account, id) {
    const acc = this.state[agent]?.[account || 'default'];
    if (!acc?.notices?.[id]) return false;
    delete acc.notices[id];
    this.save();
    this.onChange();
    return true;
  }

  // What a unit of work takes of the window, from the runs so far (kept across resets), or null.
  rate(agent, account, id) {
    const l = this.state[agent]?.[account || 'default']?.learn?.[id];
    return l && l.du >= LEARN_MIN && l.units > 0 ? l.du / l.units : null;
  }

  // You said yes at `line` to a window: the next ask for it comes higher (web/js/limit-hold.js
  // nextLine), until it resets.
  ack(agent, account, id, resetsAt, line) {
    const acc = ((this.state[agent] ||= {})[account || 'default'] ||= { windows: {} });
    (acc.acks ||= {})[id] = { resetsAt: resetsAt || null, line };
    this.save();
  }

  // The line you said yes at for this window, while it hasn't reset; 0 when you haven't.
  acked(agent, account, id, resetsAt) {
    const a = this.state[agent]?.[account || 'default']?.acks?.[id];
    if (!a || !(a.line > 0)) return 0;
    if (a.resetsAt !== (resetsAt || null) || (a.resetsAt && a.resetsAt <= this.now())) return 0;
    return a.line;
  }

  // For the page: [{ account, at, windows: [{ id, label, used, resetsAt, hitAt }] }], most-known
  // windows first. A window whose reset has passed is fresh: 0% and no time.
  view(agent) {
    const now = this.now();
    const out = [];
    for (const [account, acc] of Object.entries(this.state[agent] || {})) {
      const windows = Object.entries(acc.windows || {})
        .filter(([id, w]) => !stale(acc, id, w, now))
        .map(([id, w]) => {
          const fresh = w.resetsAt && w.resetsAt <= now;
          const used = fresh ? 0 : w.used;
          const e = acc.early?.[id];
          return { id, label: WINDOWS[id]?.label || labelOf(w.ms), used, resetsAt: fresh ? null : w.resetsAt, hitAt: fresh ? null : paceOf({ ...w, used }, now), ms: w.ms || null, ...(e && !fresh && samePeriod(e.resetsAt, w.resetsAt) && { earlyAt: e.at }) };
        })
        .sort((a, b) => rank(a.id) - rank(b.id));
      const drain = this.drain(agent, account);
      const notices = Object.values(acc.notices || {}).map((n) => ({ ...n, label: WINDOWS[n.window]?.label || labelOf(n.ms), ...(n.wasMs && { wasLabel: WINDOWS[n.wasWindow]?.label || labelOf(n.wasMs) }) }));
      const overage = this.#overView(acc, now);
      if (windows.length || notices.length || overage) out.push({ account, at: acc.at || null, windows, ...(drain && { drain }), ...(notices.length && { notices }), ...(overage && { overage }) });
    }
    return out;
  }
}

const rank = (id) => (ORDER.includes(id) ? ORDER.indexOf(id) : ORDER.length);
// A window the last report of every window left out (Claude Ultra's gone 5-hour one), once its
// reset has passed: there's nothing to show but an empty bar until #shape calls it gone.
const stale = (acc, id, w, now) => !!acc.shape?.windows?.[id]?.miss && (!w.resetsAt || w.resetsAt <= now);
// A window wisp has no name for, by its length: "30-day", "12-hour".
const labelOf = (ms) => (!ms ? 'Usage' : ms >= 24 * H ? `${Math.round(ms / (24 * H))}-day` : `${Math.round(ms / H)}-hour`);

// What holds the work back, in words the page puts after "Waits for your plan:" (no time: the page
// says when, in its own format): "Claude Code’s weekly window is at 78%, past your 75%".
export function holdWhy(h, name, label = '') {
  const win = h.label.charAt(0).toLowerCase() + h.label.slice(1);
  return `${name}${label ? ` (${label})` : ''}’s ${win} window is at ${Math.round(h.used * 100)}%, past your ${Math.round(h.stop * 100)}%`;
}

// Drain watch's words, for the phone (the page writes its own): "Since 14:05, 4 runs took 18% of
// Claude Code’s 5-hour window for $2.10 of work: 3.1× its usual share per unit of work …".
export const unitWords = (agent, u) => (agent === 'claude' ? `$${u.toFixed(2)}` : `${u >= 0.1 ? u.toFixed(1) : u.toFixed(2)}M tokens`);
export function drainWhy(d, name, label = '', agent = name === 'Claude Code' ? 'claude' : '') {
  const at = new Date(d.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const win = d.label.charAt(0).toLowerCase() + d.label.slice(1);
  const p = (x) => `${Math.round(x * 100)}%`;
  const failed = d.failed?.runs ? ` ${d.failed.runs} of them ended in an error and still took ${p(d.failed.du)}.` : '';
  return `Since ${at}, ${d.runs} runs took ${p(d.du)} of ${name}${label ? ` (${label})` : ''}’s ${win} window for ${unitWords(agent, d.units)} of work: ${d.ratio.toFixed(1)}× its usual share per unit of work over the last two weeks.${failed} Settings → Usage → Plan budget has the details and Copy report.`;
}

// A turn's part of a window's move, added to what it already has there (turn.plan, runner.js).
export function addShare(turn, agent, { account, window, used, resetsAt }) {
  if (!(used > 0)) return;
  const list = (turn.plan ||= []);
  const e = list.find((x) => x.agent === agent && x.account === account && x.window === window && samePeriod(x.resetsAt, resetsAt));
  if (e) e.used = Math.min(1, e.used + used);
  else list.push({ agent, account, window, used: Math.min(1, used), resetsAt });
}

// A task's share of each kind of window, summed over its turns: { five_hour: 0.18, seven_day: 0.04 }.
export function planOf(s) {
  const out = {};
  for (const t of s.turns || []) for (const p of t.plan || []) out[p.window] = (out[p.window] || 0) + p.used;
  return Object.keys(out).length ? out : undefined;
}

// Where an account's window went this period: the tasks that used most of it, and how much of
// what's gone wisp traced to a task at all (the rest ran outside wisp, or before it measured).
// sessions: every task. → { tasks: [{ id, title, used }], traced } or null when nothing is traced.
export function whereItWent(sessions, agent, account, win, resetsAt, { limit = 3 } = {}) {
  const by = new Map();
  const titles = new Map(sessions.map((s) => [s.id, s.title || 'Untitled']));
  for (const s of sessions) {
    // A subagent's share is its lead's (one with no lead left counts on its own).
    const id = s.parentId && titles.has(s.parentId) ? s.parentId : s.id;
    let used = 0;
    for (const t of s.turns || []) for (const p of t.plan || []) if (p.agent === agent && p.account === account && p.window === win && samePeriod(p.resetsAt, resetsAt)) used += p.used;
    if (!(used > 0)) continue;
    const e = by.get(id) || { id, title: titles.get(id), used: 0 };
    e.used += used;
    by.set(id, e);
  }
  if (!by.size) return null;
  const all = [...by.values()].sort((a, b) => b.used - a.used);
  return { tasks: all.slice(0, limit), more: Math.max(0, all.length - limit), traced: all.reduce((t, x) => t + x.used, 0) };
}

// Where an account's window went to subagents this period (Settings → Usage, beside Where it went):
// each subagent type's calls, output and its share of the window, a turn's share split by the part
// of the turn's output that type wrote. → [{ type, calls, model, output, used, instead? }], top
// `limit` by share, or null when no traced turn ran a subagent.
export function whereSubagents(sessions, agent, account, win, resetsAt, { limit = 3 } = {}) {
  const by = new Map();
  for (const s of sessions) {
    for (const t of s.turns || []) {
      const subs = t.stats?.subagents;
      if (!subs?.length) continue;
      let used = 0;
      for (const p of t.plan || []) if (p.agent === agent && p.account === account && p.window === win && samePeriod(p.resetsAt, resetsAt)) used += p.used;
      if (!(used > 0)) continue;
      const total = turnOutput(t);
      for (const x of subs) {
        const e = by.get(x.type) || { type: x.type, calls: 0, output: 0, used: 0, models: new Map() };
        e.calls += x.calls || 0;
        e.output += x.output || 0;
        e.used += total ? (used * (x.output || 0)) / total : 0;
        if (x.model) e.models.set(x.model, (e.models.get(x.model) || 0) + (x.output || 0) + 1);
        if (x.instead) e.instead = x.instead;
        by.set(x.type, e);
      }
    }
  }
  if (!by.size) return null;
  return [...by.values()]
    .map(({ models, ...e }) => ({ ...e, model: [...models].sort((a, b) => b[1] - a[1])[0]?.[0] || '' }))
    .sort((a, b) => b.used - a.used || b.output - a.output)
    .slice(0, limit);
}

// A run's tool list (Claude Code's system/init tools) as turn.details.tools: { hash, list }. wisp's
// own MCP tools are left out (they change with the task: crew jobs, subagents), so the hash only
// moves when the account's own tools do. `seen` (hashes earlier turns of this task stored the list
// under) drops the list from repeat turns: the hash points back to it.
export function toolSet(list, seen = []) {
  const names = [...new Set((list || []).map(String).filter((n) => n && !/^mcp__wisp__/.test(n)))].sort();
  const hash = createHash('sha1').update(names.join('\n')).digest('hex').slice(0, 12);
  return seen.includes(hash) ? { hash } : { hash, list: names };
}

// Tokens per turn by account (Settings → Usage, the receipt's tooltip): for each model this harness
// ran on two or more accounts over the last 7 days, each account's median turn, once every account
// shown has `min` finished turns on that model. Only what the CLI reported per turn, so it shows
// when the same work costs one login more than another. A diagnostic: nothing here picks an account.
// sessions: every task. → [{ model, accounts: [{ account, turns, output, input, cache, missing? }] }], most output first;
// missing: tools another account in the row had on its latest turn and this one didn't.
export function compareAccounts(sessions, agent, { now = Date.now(), days = COMPARE_DAYS, min = COMPARE_MIN } = {}) {
  const since = now - days * 864e5;
  const by = new Map(); // model → account → { out: [], read: [], cached, readSum, tools, toolsAt }
  const lists = new Map(); // tools hash → list, from whichever turn stored it
  for (const s of sessions) {
    for (const t of s.turns || []) {
      const ts = t.details?.tools;
      if (ts?.hash && Array.isArray(ts.list)) lists.set(ts.hash, ts.list);
      if ((t.agent || s.agent) !== agent || t.status !== 'done' || !(t.startedAt >= since) || t.startedAt > now) continue;
      const k = turnTokens(t);
      if (!k.output) continue;
      const model = String(t.model || '');
      const m = by.get(model) || new Map();
      by.set(model, m);
      const acc = t.account || 'default';
      const e = m.get(acc) || { out: [], read: [], cached: 0, readSum: 0, tools: null, toolsAt: -Infinity };
      m.set(acc, e);
      // The account's tools as of its latest turn that reported them.
      if (ts?.hash && t.startedAt >= e.toolsAt) {
        e.tools = ts.hash;
        e.toolsAt = t.startedAt;
      }
      e.out.push(k.output);
      e.read.push(k.read);
      e.cached += k.cached;
      e.readSum += k.read;
    }
  }
  const out = [];
  for (const [model, m] of by) {
    const accounts = [...m]
      .filter(([, e]) => e.out.length >= min)
      .map(([account, e]) => ({ account, turns: e.out.length, output: Math.round(median(e.out)), input: Math.round(median(e.read)), cache: e.readSum && e.cached ? e.cached / e.readSum : null, tools: e.tools && lists.get(e.tools) }))
      .sort((a, b) => b.output - a.output);
    if (accounts.length < 2) continue;
    // Tools another account had that this one didn't (its settings deny WebFetch, an MCP server it
    // lacks): a reason its turns differ. Only between accounts that both reported a list.
    const known = accounts.filter((x) => x.tools);
    const all = [...new Set(known.flatMap((y) => y.tools))].sort();
    for (const x of accounts) {
      const missing = known.length >= 2 && x.tools ? all.filter((n) => !x.tools.includes(n)) : [];
      if (missing.length) x.missing = missing;
    }
    for (const x of accounts) delete x.tools;
    out.push({ model, accounts });
  }
  return out.sort((a, b) => a.model.localeCompare(b.model));
}
