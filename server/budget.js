// Plan budget: how much of each account's usage windows is gone (Claude's 5-hour and weekly ones,
// Codex's), from what the CLI itself reports on every run, and when you'd run out at this pace.
// Nothing is asked of the provider: Claude prints a rate_limit_event in its stream, Codex writes
// rate_limits into its session file. A window whose reset has passed reads as fresh.
//
// ~/.wisp/budget.json: { [agent]: { [account]: { at, windows: { [id]: { used, resetsAt, ms } } } } }
// used: 0..1, resetsAt: ms, ms: the window's length (for the pace). account: 'default' for the CLI's own.

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
const MAX_WINDOWS = 6; // a CLI that starts reporting dozens doesn't grow the file
const clamp = (n) => Math.min(1, Math.max(0, n));
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
  constructor(home, { now = () => Date.now(), onChange = () => {} } = {}) {
    this.file = path.join(home, 'budget.json');
    this.now = now;
    this.onChange = onChange;
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
    const acc = ((this.state[agent] ||= {})[account || 'default'] ||= { windows: {} });
    let moved = false;
    for (const w of windows) {
      if (!w?.id || !Number.isFinite(w.used)) continue;
      const was = acc.windows[w.id];
      if (!was && Object.keys(acc.windows).length >= MAX_WINDOWS) continue;
      const next = { used: clamp(w.used), resetsAt: w.resetsAt || null, ms: w.ms || WINDOWS[w.id]?.ms || null };
      if (!was || Math.round(was.used * 100) !== Math.round(next.used * 100) || was.resetsAt !== next.resetsAt) moved = true;
      acc.windows[w.id] = next;
    }
    acc.at = this.now();
    this.save();
    if (moved) this.onChange();
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
          return { id, label: WINDOWS[id]?.label || labelOf(w.ms), used, resetsAt: fresh ? null : w.resetsAt, hitAt: fresh ? null : paceOf({ ...w, used }, now) };
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
