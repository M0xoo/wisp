// Plan budget: how much of each account's usage windows is gone (Claude's 5-hour and weekly ones,
// Codex's), from what the CLI itself reports on every run, and when you'd run out at this pace.
// Nothing is asked of the provider: Claude prints a rate_limit_event in its stream, Codex writes
// rate_limits into its session file. A window whose reset has passed reads as fresh.
//
// ~/.wisp/budget.json: { [agent]: { [account]: { at, windows: { [id]: { used, resetsAt, ms } },
// learn: { [id]: { du, units } }, acks: { [id]: { resetsAt, line } } } } }
// used: 0..1, resetsAt: ms, ms: the window's length (for the pace). account: 'default' for the CLI's own.
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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic } from './util.js';

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
// Two reports of the same window period: Codex's reset can drift when it only says "in n seconds".
const samePeriod = (a, b) => !!a && !!b && Math.abs(a - b) < 10 * 60_000;
const MAX_LEDGER = 100; // turns remembered per account between two reports
const MAX_WINDOWS = 6; // a CLI that starts reporting dozens doesn't grow the file
const clamp = (n) => Math.min(1, Math.max(0, n));
const LEARN_GAP = 30 * 60_000; // readings further apart than this may hide use outside wisp
const LEARN_MIN = 0.02; // two points moved before a rate counts (the CLI reports whole percents)
const LEARN_KEEP = 0.3; // past this many points, halve: the rate follows the recent runs
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
  if (!stats) return 0;
  if (typeof stats.costUsd === 'number' && stats.costUsd > 0) return stats.costUsd;
  const tokens = (stats.inputTokens || 0) - (stats.cachedInputTokens || 0) + (stats.outputTokens || 0);
  return tokens > 0 ? tokens / 1e6 : 0;
}

// Claude's rate_limit_event.rate_limit_info → { windows, rejected? } or null.
// { status, rateLimitType, utilization, resetsAt (s), unifiedWindows: { five_hour: { utilization, resetsAt } } }
export function claudeLimits(info) {
  if (!info || typeof info !== 'object') return null;
  const windows = [];
  const add = (id, w, used = w?.utilization) => {
    if (!id || typeof id !== 'string' || !Number.isFinite(used) || windows.some((x) => x.id === id)) return;
    windows.push({ id, used: clamp(used), resetsAt: toMs(w.resetsAt), ms: WINDOWS[id]?.ms ?? null });
  };
  for (const [id, w] of Object.entries(info.unifiedWindows || {})) if (w && typeof w === 'object') add(id, w);
  const rejected = info.status === 'rejected';
  // A refusal without a number is a full window.
  add(info.rateLimitType, info, Number.isFinite(info.utilization) ? info.utilization : rejected ? 1 : NaN);
  if (!windows.length) return null;
  return { windows, ...(rejected && { rejected: String(info.rateLimitType || '') }) };
}

// Codex's rate_limits (from its session file) → { windows, rejected? } or null.
// { primary: { used_percent, window_minutes, resets_at (s) }, secondary: {…}, rate_limit_reached_type }
export function codexLimits(rl) {
  if (!rl || typeof rl !== 'object') return null;
  const windows = [];
  for (const w of [rl.primary, rl.secondary]) {
    if (!w || !Number.isFinite(w.used_percent)) continue;
    const mins = Number(w.window_minutes) || 0;
    const id = mins === 300 ? 'five_hour' : mins === 10080 ? 'seven_day' : mins ? `w${mins}m` : '';
    if (!id || windows.some((x) => x.id === id)) continue;
    const resetsAt = toMs(w.resets_at) ?? (Number.isFinite(w.resets_in_seconds) ? Date.now() + w.resets_in_seconds * 1000 : null);
    windows.push({ id, used: clamp(w.used_percent / 100), resetsAt, ms: mins ? mins * 60_000 : null });
  }
  if (!windows.length) return null;
  const full = windows.find((w) => w.used >= 1);
  return { windows, ...((rl.rate_limit_reached_type || full) && { rejected: full?.id || windows[0].id }) };
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
        if (rl) return rl;
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
  constructor(home, { now = () => Date.now(), onChange = () => {}, onShare = () => {} } = {}) {
    this.file = path.join(home, 'budget.json');
    this.now = now;
    this.onChange = onChange;
    this.onShare = onShare;
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

  // What a run reported: { windows: [{ id, used, resetsAt, ms }], rejected? }.
  record(agent, account, { windows = [] } = {}) {
    if (!agent || !Array.isArray(windows) || !windows.length) return;
    account ||= 'default';
    const acc = ((this.state[agent] ||= {})[account] ||= { windows: {} });
    const now = this.now();
    const share = this.#sharers(agent, account, acc.at, now);
    let moved = false;
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
      }
      if (!was || Math.round(was.used * 100) !== Math.round(next.used * 100) || was.resetsAt !== next.resetsAt) moved = true;
      // How far it moved since the last report: in a new period, all of what's used now.
      const d = !was ? 0 : samePeriod(was.resetsAt, next.resetsAt) ? next.used - was.used : was.resetsAt && was.resetsAt <= now ? next.used : 0;
      if (d > 0 && share.length) for (const [k, part] of share) this.onShare(k.sid, k.tid, { agent, account, window: w.id, used: d * part, resetsAt: next.resetsAt });
      acc.windows[w.id] = next;
    }
    acc.at = now;
    this.save();
    if (moved) this.onChange();
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
      .map(([id, w]) => {
        const fresh = w.resetsAt && w.resetsAt <= now;
        return { id, label: WINDOWS[id]?.label || labelOf(w.ms), used: fresh ? 0 : w.used, resetsAt: fresh ? null : w.resetsAt, ms: w.ms || null };
      })
      .sort((a, b) => rank(a.id) - rank(b.id));
  }

  // A run on the account ended: its units of work count against what the windows moved.
  spend(agent, account, units) {
    const acc = this.state[agent]?.[account || 'default'];
    if (!acc || !(units > 0)) return;
    for (const id of Object.keys(acc.windows || {})) {
      const l = ((acc.learn ||= {})[id] ||= { du: 0, units: 0 });
      l.units += units;
      if (l.du > LEARN_KEEP) (l.du /= 2), (l.units /= 2);
    }
    this.save();
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
        .map(([id, w]) => {
          const fresh = w.resetsAt && w.resetsAt <= now;
          const used = fresh ? 0 : w.used;
          return { id, label: WINDOWS[id]?.label || labelOf(w.ms), used, resetsAt: fresh ? null : w.resetsAt, hitAt: fresh ? null : paceOf({ ...w, used }, now), ms: w.ms || null };
        })
        .sort((a, b) => rank(a.id) - rank(b.id));
      if (windows.length) out.push({ account, at: acc.at || null, windows });
    }
    return out;
  }
}

const rank = (id) => (ORDER.includes(id) ? ORDER.indexOf(id) : ORDER.length);
// A window wisp has no name for, by its length: "30-day", "12-hour".
const labelOf = (ms) => (!ms ? 'Usage' : ms >= 24 * H ? `${Math.round(ms / (24 * H))}-day` : `${Math.round(ms / H)}-hour`);

// What holds the work back, in words the page puts after "Waits for your plan:" (no time: the page
// says when, in its own format): "Claude Code’s weekly window is at 78%, past your 75%".
export function holdWhy(h, name, label = '') {
  const win = h.label.charAt(0).toLowerCase() + h.label.slice(1);
  return `${name}${label ? ` (${label})` : ''}’s ${win} window is at ${Math.round(h.used * 100)}%, past your ${Math.round(h.stop * 100)}%`;
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
