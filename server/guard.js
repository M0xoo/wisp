// Ask near the limit (design/hold.md): before a task or a follow-up goes, how much of its account's
// 5-hour and weekly windows it will likely take, and whether that crosses the line you set
// (Settings → Usage, defaults.limitHold). The rule itself is web/js/limit-hold.js, shared with the
// page. Yours are refused until you say yes; an automation's wait as a held turn, which starts at
// the reset unless you start it first. Nothing here switches accounts (design/accounts.md → Terms).
//
// The estimate, in two halves:
// - units of work: what past runs like this one cost (Claude's total_cost_usd, else tokens), p50,
//   p75 and p90 of the last 50. A schedule, trigger, recipe or crew job uses its own runs once it has
//   five; a follow-up at least this task's own median.
// - share per unit: how far the window moved while wisp's runs worked, over the units they did
//   (Budget.rate, server/budget.js), never more than the window's whole use over wisp's units in
//   it. Before two points have moved, no estimate: only a window already past the line holds.
// Runs going on the same account count at half their estimate, so automations that fire together
// don't all slip under the line.

import { unitsOf } from './budget.js';
import { holdFor, holdLine, holdTo, nextLine } from '../web/js/limit-hold.js';

export { unitsOf };

const DAY = 864e5;
const LOOKBACK = 30 * DAY;
const SAMPLES = 50;
const OWN_MIN = 5; // runs of one schedule, trigger or crew job before they count on their own
const CLASS_MIN = 3;
const CACHE_MS = 60_000;
const UNKNOWN_RESET = 3600_000; // no reset time: look again in an hour

// [p50, p75, p90] of the newest SAMPLES, or null.
export function spread(xs, min = CLASS_MIN) {
  if (xs.length < min) return null;
  const v = xs.slice(-SAMPLES).sort((a, b) => a - b);
  const q = (p) => v[Math.min(v.length - 1, Math.floor(v.length * p))];
  return [q(0.5), q(0.75), q(0.9)];
}

// Where a task came from, for its own history: a schedule, trigger, recipe or crew job.
export function originKey({ origin, crew } = {}) {
  if (origin?.kind && origin.id) return `${origin.kind}:${origin.id}`;
  if (crew?.id) return `crew:${crew.id}:${crew.job || 'task'}`;
  return '';
}

const accountOf = (s, t) => (t?.account ?? s.account) || 'default';
const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);

export class Guard {
  // budget: server/budget.js. setting(): defaults.limitHold. now(): the clock.
  constructor({ store, budget, setting = () => store.config.defaults?.limitHold, now = () => Date.now() }) {
    Object.assign(this, { store, budget, setting, now });
    this.cache = new Map(); // agent → { at, first, followUp, own: Map, runs: Map(account → [[endedAt, units]]) }
  }

  // What wisp knows of an agent's runs, rebuilt at most once a minute.
  #history(agent) {
    const now = this.now();
    const hit = this.cache.get(agent);
    if (hit && now - hit.at < CACHE_MS) return hit;
    const first = [];
    const followUp = [];
    const own = new Map();
    const runs = new Map();
    const since = now - LOOKBACK;
    const all = [...this.store.all()].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    for (const s of all) {
      if (s.agent === 'wisp') continue;
      (s.turns || []).forEach((t, i) => {
        if ((t.agent || s.agent) !== agent || !t.endedAt || t.endedAt < since || t.status === 'running' || t.status === 'held') return;
        const u = unitsOf(t.stats);
        if (!u) return;
        const acc = accountOf(s, t);
        if (!runs.has(acc)) runs.set(acc, []);
        runs.get(acc).push([t.endedAt, u]);
        // Subagents and Auto's repair rounds run inside a task you already said yes to.
        if (s.parentId || s.delegated || t.by === 'wisp') return;
        (i ? followUp : first).push(u);
        const key = !i && originKey(s);
        if (key) (own.get(key) || own.set(key, []).get(key)).push(u);
      });
    }
    const out = { at: now, first: spread(first), followUp: spread(followUp), own: new Map([...own].map(([k, v]) => [k, spread(v, OWN_MIN)]).filter(([, v]) => v)), runs };
    this.cache.set(agent, out);
    return out;
  }

  // Forget the cached history: a run just ended (its cost counts from the next check).
  changed(agent) {
    if (agent) this.cache.delete(agent);
    else this.cache.clear();
  }

  // A run's estimate in units: [p50, p75, p90], or null when wisp has nothing to go on.
  units(agent, { kind = 'first', origin, crew, session } = {}) {
    const h = this.#history(agent);
    if (kind === 'first') return h.own.get(originKey({ origin, crew })) || h.first;
    const base = h.followUp || h.first;
    // A follow-up on a task whose runs have been big is likely big too.
    const mine = (session?.turns || []).filter((t) => (t.agent || session.agent) === agent && t.status !== 'held').map((t) => unitsOf(t.stats)).filter(Boolean);
    if (!mine.length) return base;
    const m = median(mine);
    return base ? [base[0], Math.max(base[1], m), Math.max(base[2], m)] : [m, m, m];
  }

  // Share of the window per unit, or null. The window's whole use over the units wisp ran in it is
  // a ceiling: it puts all of the window on wisp.
  rate(agent, account, w) {
    const r = this.budget.rate(agent, account, w.id);
    if (!r || !w.resetsAt || !w.ms || !(w.used > 0)) return r;
    const start = w.resetsAt - w.ms;
    const spent = (this.#history(agent).runs.get(account) || []).reduce((n, [at, u]) => (at >= start ? n + u : n), 0);
    return spent > 0 ? Math.min(r, w.used / spent) : r;
  }

  // Runs going on this account now, in units: half of what each is likely to take.
  #running(agent, account) {
    let n = 0;
    for (const s of this.store.all()) {
      const t = s.turns?.at(-1);
      if (t?.status !== 'running' || (t.agent || s.agent) !== agent || accountOf(s, t) !== account || s.parentId || s.delegated) continue;
      const u = this.units(agent, { kind: s.turns.length > 1 ? 'followUp' : 'first', origin: s.origin, crew: s.crew, session: s });
      if (u) n += u[1] / 2;
    }
    return n;
  }

  // An account's windows for the rule (web/js/limit-hold.js): with the line (after any yes) and
  // what a run like this adds, as shares. what: { kind, origin, crew, session }; kind 'both' gives
  // the page first and followUp.
  windows(agent, account, what = {}) {
    account ||= 'default';
    const line = holdLine(this.setting());
    const list = this.budget.windows(agent, account);
    if (!list.length) return [];
    const running = this.#running(agent, account);
    const kinds = what.kind === 'both' ? ['first', 'followUp'] : [what.kind || 'first'];
    return list.map((w) => {
      const r = this.rate(agent, account, w);
      const est = {};
      for (const k of kinds) {
        const u = this.units(agent, { ...what, kind: k });
        est[k] = r ? (u || [0, 0, 0]).map((x) => (x + running) * r) : [0, 0, 0];
      }
      return { id: w.id, label: w.label, used: w.used, resetsAt: w.resetsAt, line: nextLine(line, this.budget.acked(agent, account, w.id, w.resetsAt)), est };
    });
  }

  // The window a run would take past its line: { agent, account, id, label, used, to, resetsAt,
  // line } (web/js/limit-hold.js holdFor), or null.
  check({ agent, account, kind = 'first', origin, crew, session } = {}) {
    if (!agent || holdLine(this.setting()) === null) return null;
    account ||= 'default';
    const h = holdFor(this.windows(agent, account, { kind, origin, crew, session }), kind);
    return h && { agent, account, ...h };
  }

  // You said yes: every window this run would cross asks again only higher up, or after its reset.
  confirm({ agent, account, kind = 'first', origin, crew, session } = {}) {
    account ||= 'default';
    for (const w of this.windows(agent, account, { kind, origin, crew, session })) {
      const h = holdFor([w], kind);
      if (h) this.budget.ack(agent, account, w.id, w.resetsAt, w.line);
    }
  }

  // When a held run goes by itself: its window's reset, or in an hour when that isn't known.
  until(h) {
    return h?.resetsAt && h.resetsAt > this.now() ? h.resetsAt : this.now() + UNKNOWN_RESET;
  }

  // For the page (GET /agents): Budget.view with each window's line and estimates, so the page
  // can hold a send before it goes.
  view(agent) {
    return this.budget.view(agent).map((b) => {
      const extra = new Map(this.windows(agent, b.account, { kind: 'both' }).map((w) => [w.id, w]));
      return { ...b, windows: b.windows.map((w) => ({ ...w, line: extra.get(w.id)?.line ?? null, est: extra.get(w.id)?.est })) };
    });
  }
}

// What the refusal says, for clients without the page (the CLI, MCP, the API).
export function holdMessage(h) {
  const pct = (x) => `${Math.floor(x * 100)}%`;
  const where = h.used >= 1 ? 'is used up' : h.to[1] - h.used < 0.005 ? `is at ${pct(h.used)}` : `is at ${pct(h.used)}; this would likely take it ${holdTo(h) === 'past the limit' ? 'past the limit' : `to ${holdTo(h)}`}`;
  return `${h.label} usage window ${where}, past your ${pct(h.line)} line (Settings → Usage → Ask near the limit). Send it again with confirmLimit: true (the CLI: --yes) to go ahead anyway, only if the user agreed.`;
}
