// Allowance per window: what each period of a usage window used, how much of it went outside wisp
// and what 1% of it cost, period by period, and a weekly reading of whether 1% buys less than it did
// (design/budget.md). Pure: it reads tasks and budget.json's numbers. A diagnostic: nothing here
// fires an event, notifies or touches a hold.

import { samePeriod, WINDOWS } from './budget.js';

const WEEK = 7 * 24 * 3600_000;
export const MIN_SHARE = 0.05; // of a window, in wisp: under it, one rounded percent swings the cost
const MIN_READING = 0.1; // the same, for a period to count to the reading
const SIDE = 2; // full periods on each side of the reading
const MOVE = 0.2; // how far the cost of 1% moves before it says so
const CLI_FIELDS = ['version', 'tools', 'catalog'];

const tidy = (x) => Math.round(x * 1e7) / 1e7; // differences of totals leave float dust
const unitFor = (agent) => (agent === 'claude' ? 'usd' : 'mtok');
const sum = (list, key) => list.reduce((t, x) => t + x[key], 0);
// Turns that are copies, not work done here: a fork's first turns ran in the task it came from, and
// a shared task's ran on someone else's account.
const copied = (t) => !!(t.forked || t.shared);
const millions = (st) => {
  const n = (st.inputTokens || 0) - (st.cachedInputTokens || 0) + (st.outputTokens || 0);
  return n > 0 ? n / 1e6 : null;
};

// What a turn's stats say. now: the counter it left, when it has one. cumulative: now holds the
// whole conversation so far. Claude: stats.totals keeps the counter apart from the turn's cost;
// before it, costUsd was the counter on a resumed turn. Codex: turn.completed's usage is the
// thread's total, and a resume carries it on, so its tokens are a counter too.
function readingOf(agent, st) {
  if (agent === 'claude') {
    if (st.totals) return { now: st.totals.costUsd, work: st.costUsd };
    return typeof st.costUsd === 'number' ? { now: st.costUsd, cumulative: true } : null;
  }
  const tokens = millions(st);
  if (tokens === null) return null; // a run that never got to report: it mustn't reset the counter
  return agent === 'codex' ? { now: tokens, cumulative: true } : { work: tokens };
}

// Each turn's own work: Map(turn → { work, unit, rough }). Turns that say nothing aren't in it.
// rough: it comes from the difference of two cumulative totals.
export function turnCosts(session) {
  const out = new Map();
  const prior = new Map(); // agent → its counter after the turn before
  for (const t of session?.turns || []) {
    if (!t.stats) continue;
    const agent = t.agent || session.agent;
    const r = readingOf(agent, t.stats);
    if (!r) continue;
    const was = prior.get(agent) || 0;
    if (Number.isFinite(r.now)) prior.set(agent, r.now);
    // A copy or a baseline moves the counter, so the turn after differences correctly, but isn't work.
    if (copied(t) || t.stats.baseline) continue;
    const unit = unitFor(agent);
    if (r.cumulative) {
      const grew = r.now >= was; // less than before: the counters started over (another login, a new thread)
      out.set(t, { work: tidy(grew ? r.now - was : r.now), unit, rough: grew && was > 0 });
    } else if (typeof r.work === 'number') out.set(t, { work: r.work, unit, rough: false });
  }
  return out;
}

// Every turn's work and every plan share, once: a board's worth of windows reads them all.
function ledgerOf(sessions) {
  const turns = [];
  const plans = [];
  for (const s of sessions) {
    const costs = turnCosts(s);
    for (const t of s.turns || []) {
      if (copied(t)) continue;
      for (const p of t.plan || []) if (p.resetsAt) plans.push({ ...p, at: t.startedAt });
      const c = costs.get(t);
      if ((c || t.stats?.cli) && Number.isFinite(t.startedAt)) turns.push({ agent: t.agent || s.agent, account: t.account || s.account || 'default', at: t.startedAt, work: c?.work || 0, rough: !!c?.rough, cli: t.stats?.cli });
    }
  }
  return { turns: turns.sort((a, b) => a.at - b.at), plans };
}

// What moved in the CLI against what was last seen. stats.cli is optional: older turns have none,
// and a field only counts when both sides have it. A period with nothing before it is read against
// its own first turn. seen is updated to where this period ended.
function cliMoves(seen, mine) {
  const list = mine.filter((t) => t.cli);
  if (!list.length) return null;
  const [first, last] = [list[0].cli, list.at(-1).cli];
  const out = {};
  for (const f of CLI_FIELDS) {
    const [from, to] = [seen[f] ?? first?.[f], last?.[f]];
    if (from != null && to != null && String(from) !== String(to)) out[f] = f === 'version' ? [String(from), String(to)] : true;
    if (to != null) seen[f] = to;
  }
  return Object.keys(out).length ? out : null;
}

// A window's periods, newest first: [{ end, ms, used, inWisp, outside, work, unit, per1, rough?,
// open?, full?, cut?, cli? }]. Three sources, matched on the period's end: closed (Budget.periods),
// the plan shares on turns (older periods are known only from these) and the window now.
// win: { id, used, resetsAt, ms }. since: when wisp began reading this account (acc.shape.since).
export function periodsOf(sessions, agent, account, win, { closed = [], since, now = Date.now(), limit = 12, ledger = ledgerOf(sessions) } = {}) {
  const ms = win.ms || WINDOWS[win.id]?.ms || null;
  const rows = [];
  const rowAt = (end) => {
    let r = rows.find((x) => samePeriod(x.end, end));
    if (!r) rows.push((r = { end, ms, used: null, shares: 0 }));
    return r;
  };
  const read = (r, used) => (r.used = Number.isFinite(used) ? Math.max(r.used ?? 0, used) : r.used);
  for (const c of closed) {
    const r = rowAt(c.resetsAt);
    read(r, c.used);
    r.ms = c.ms ?? ms;
    r.cut = !!c.cut && (r.cut ?? true);
  }
  for (const p of ledger.plans) {
    if (p.agent !== agent || p.account !== account || p.window !== win.id) continue;
    const r = rowAt(p.resetsAt);
    r.shares += p.used;
    if (Number.isFinite(p.at)) r.traced = Math.min(r.traced ?? p.at, p.at);
  }
  if (win.resetsAt) {
    const r = rowAt(win.resetsAt);
    read(r, win.used);
    r.ms = win.ms || r.ms;
    if (win.resetsAt > now) (r.open = true), (r.cut = false);
  }
  // Only the rows shown count, plus the one before for what moved in the CLI: a 5-hour window's
  // shares go back years.
  const shown = rows.sort((a, b) => a.end - b.end).slice(-(limit + 1));
  const turns = ledger.turns.filter((t) => t.agent === agent && t.account === account);
  const seen = {};
  const out = shown.map((r, i) => {
    // An early reset's new period began before this one's end: what ran after belongs to that one.
    const next = shown[i + 1];
    const to = r.cut && next?.ms ? Math.min(r.end, next.end - next.ms) : r.end;
    const during = r.ms ? turns.filter((t) => t.at > r.end - r.ms && t.at <= to) : [];
    // No reading: turn.plan may have begun partway through, and all of the period's work over a
    // share traced only at its end would read as a huge cost. Only what ran once it was traced.
    const mine = r.used === null && r.traced !== undefined ? during.filter((t) => t.at >= r.traced) : during;
    const inWisp = tidy(Math.min(r.shares, 1, r.used ?? 1)); // shares can sum past used: concurrent reports each count a move
    const work = tidy(sum(mine, 'work'));
    const full = !r.open && !r.cut && r.used !== null && !!ms && r.ms === ms && since != null && since <= r.end - r.ms;
    const cli = cliMoves(seen, during);
    return {
      end: r.end,
      ms: r.ms,
      used: r.used,
      inWisp,
      outside: r.used === null ? null : Math.max(0, tidy(r.used - inWisp)),
      work,
      unit: unitFor(agent),
      per1: inWisp >= MIN_SHARE && work > 0 ? work / (inWisp * 100) : null,
      ...(mine.some((t) => t.rough) && { rough: true }),
      ...(r.open && { open: true }),
      ...(full && { full: true }),
      ...(r.cut && { cut: true }),
      ...(cli && { cli }),
    };
  });
  return out.slice(-limit).reverse();
}

// The moves between two points of a period list (newest first): the CLI at the start of `from`'s
// next period against the end of `to`.
function movesAcross(periods, from, to) {
  const out = {};
  for (const p of [...periods].reverse()) {
    if (p.end <= from || p.end > to || !p.cli) continue;
    if (p.cli.version) out.version = [out.version?.[0] ?? p.cli.version[0], p.cli.version[1]];
    if (p.cli.tools) out.tools = true;
    if (p.cli.catalog) out.catalog = true;
  }
  if (out.version?.[0] === out.version?.[1]) delete out.version;
  return Object.keys(out).length ? out : null;
}

// Does 1% of a weekly window buy less than it did? The newest full periods against the ones before,
// or null, which means the row says nothing at all.
export function shrinkOf(periods) {
  const fair = periods.filter((p) => p.ms === WEEK && p.full && p.per1 !== null && p.inWisp >= MIN_READING);
  if (fair.length < SIDE * 2) return null;
  const sides = [fair.slice(0, SIDE), fair.slice(SIDE, SIDE * 2)];
  const [recent, before] = sides.map((xs) => sum(xs, 'work') / (sum(xs, 'inWisp') * 100));
  const change = Math.round((recent / before - 1) * 1e6) / 1e6;
  const state = change <= -MOVE ? 'less' : change >= MOVE ? 'more' : 'same';
  const from = sides[1].at(-1).end;
  const cli = state === 'same' ? null : movesAcross(periods, from, sides[0][0].end);
  return { state, change, recent, before, unit: fair[0].unit, from, ...(sides.flat().some((p) => p.rough) && { rough: true }), ...(cli && { cli }) };
}

// Every account's windows with their history: [{ agent, account, windows: [{ id, label, periods,
// shrink }] }]. account is its id, never an address.
export function allowance(budget, sessions, { now = budget.now() } = {}) {
  const ledger = ledgerOf(sessions);
  const out = [];
  for (const [agent, accounts] of Object.entries(budget.state)) {
    for (const [account, acc] of Object.entries(accounts)) {
      const windows = budget.windows(agent, account).map((w) => {
        // A window past its reset with no report since is still in acc.windows: that period is over.
        const raw = acc.windows?.[w.id];
        const ended = raw?.resetsAt && raw.resetsAt <= now ? [raw] : [];
        const periods = periodsOf(sessions, agent, account, w, { closed: [...budget.periods(agent, account, w.id), ...ended], since: acc.shape?.since, now, ledger });
        return { id: w.id, label: w.label, periods, shrink: shrinkOf(periods) };
      });
      out.push({ agent, account, windows });
    }
  }
  return out;
}
