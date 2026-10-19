// Auto: wisp picks the harness and model for a task, and learns from how it went.
//
// Every harness × model the user has is an "arm". For each kind of task (bug, ui, docs, …) wisp
// keeps a Beta(wins, losses) estimate per arm, stacked from three sources: the shipped priors
// (./router-priors.json, from wisp-bench), the user's history on every kind of task, and the
// history on this kind. A launch draws a chance of success from each estimate (Thompson
// sampling: arms with little data sometimes draw high and get tried) and picks the best value
// for the goal: value × chance − expected $ − a price on your waiting time.
//
// What happened afterwards is the reward, strongest signal first: switched to another harness or
// model in a follow-up (0.1), merged (1) / PR closed (0.2),
// 👍 (1) / 👎 (0), rolled back (0.1), else the presentation's hero (done 0.6, partial 0.3,
// blocked 0.1, error 0) less 0.1 per follow-up. A later, stronger signal replaces an earlier one.
//
// State lives in ~/.wisp/router.json; nothing leaves the machine except the anonymous telemetry
// fields the caller adds. Routes are recorded for local sessions and for sessions launched on
// machines (id@machine): one router per user, fed by every place it runs.

import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './util.js';

const PRIORS = JSON.parse(fs.readFileSync(new URL('./router-priors.json', import.meta.url), 'utf8'));

export const GOALS = {
  cheap: { label: 'Cheap', value: 1, hint: 'Lowest cost that still gets it done' },
  balanced: { label: 'Balanced', value: 5, hint: 'Best result per dollar' },
  best: { label: 'Best', value: 50, hint: 'Best result; cost only breaks ties' },
};
export const TYPES = ['bug', 'feature', 'ui', 'test', 'refactor', 'docs', 'release', 'question'];
const MINUTE_USD = 0.05; // what a minute of waiting costs you, in the utility
const PRIOR_CAP = 4; // shipped priors count as at most this many tasks, so your own soon outweigh them
const COLD_START = 20; // until Auto has this many of your outcomes, Balanced and Best stay on stronger tiers
const ALL_WEIGHT = 0.5; // your history on other kinds of task counts half
const HALF_LIFE_MS = 30 * 864e5; // models change: older outcomes fade
const NEW_ARM_SHARE = 0.25; // how often a new arm on probation may take an exploring slot
const MAX_ROUTES = 2000;

// --- task features ---------------------------------------------------------------------------

const RULES = [
  ['release', /\b(release|bump(ed)? (the )?version|publish|changelog for|tag v?\d)/i],
  ['docs', /\b(readme|docs?|documentation|typos?|comment(s)? in|jsdoc|docstring)\b/i],
  ['test', /\b(tests?|coverage|flaky|spec(s)?|e2e|unit test)\b/i],
  ['bug', /\b(fix|bug|broken|crash(es|ing)?|error|exception|fails?|failing|regression|doesn'?t work|not working|wrong|issue)\b/i],
  ['ui', /\b(ui|ux|button|css|layout|style|styling|color|colour|dark mode|dialog|modal|popup|screen|page|responsive|icon|animation|card|sidebar|toolbar)\b/i],
  ['refactor', /\b(refactor|clean ?up|rename|simplif(y|ies)|extract|reorgani[sz]e|dedupe|split)\b/i],
  ['question', /^(how|why|what|where|when|which|can|could|should|is|are|does|do)\b.*\?\s*$|\b(explain|investigate|look into|research|compare)\b/i],
];

// { type, size }: a coarse kind of task (the router learns per kind) and a size bucket.
export function classify(prompt = '', { attachments = 0 } = {}) {
  const text = String(prompt);
  const type = RULES.find(([, re]) => re.test(text))?.[0] || 'feature';
  const files = (text.match(/[\w./-]+\.(js|ts|tsx|jsx|py|go|rs|rb|java|css|html|md|json|ya?ml)\b/g) || []).length;
  const score = text.length / 400 + files + attachments;
  return { type, size: score < 1 ? 'S' : score < 4 ? 'M' : 'L' };
}

// --- arms ------------------------------------------------------------------------------------

export const armKey = (agent, model = '') => `${agent}:${model || ''}`;
const splitKey = (k) => {
  const i = k.indexOf(':');
  return { agent: k.slice(0, i), model: k.slice(i + 1) };
};
// Versions stripped: claude-sonnet-5-5 and claude-sonnet-5-6 are one family, and a new version
// starts from what the family already showed.
const family = (k) => k.replace(/[-.]?\d+([.-]\d+)*/g, '');

// How strong a model is, roughly: 1 small/fast/free, 2 everyday, 3 frontier. Hand-overs step up a
// tier, and until Auto has your own outcomes, Balanced stays on tier 2+ and Best on tier 3.
// The shipped priors come from a small pilot that flattered cheap models; tiers keep them honest.
const FRONTIER_DEFAULTS = new Set(['codex:']); // a harness whose default model is its frontier one
export function tierOf(key) {
  const { agent, model } = splitKey(key);
  const m = model.toLowerCase();
  // Whole name segments only: "gemini" is not "mini".
  const seg = m.split(/[-/.:_]/);
  if (seg.some((x) => ['haiku', 'flash', 'mini', 'nano', 'lite', 'small', 'free', 'fast', 'low'].includes(x))) return 1;
  if (seg.some((x) => ['opus', 'argon', 'ultra', 'pro', 'xhigh', 'high', 'max'].includes(x)) || FRONTIER_DEFAULTS.has(key) || (agent === 'grok' && /^grok-\d/.test(m))) return 3;
  return 2;
}

// An error that says the harness can't run right now (a usage limit, a rate limit, no credit),
// not that the model got the task wrong. Returns { scope: 'agent' | 'arm', ms } or null.
export function infraError(text = '') {
  const t = String(text);
  if (/session limit|usage limit|limit reached|resets \d|quota|exceeded your|insufficient (credit|balance|quota)|balance exhausted|payment required|\b402\b|billing/i.test(t)) return { scope: 'agent', ms: resetIn(t) ?? 60 * 60_000 };
  if (/rate[- ]?limit|too many requests|\b429\b|overloaded|\b529\b|try again in a few minutes/i.test(t)) return { scope: 'arm', ms: 10 * 60_000 };
  return null;
}
// "resets 9pm" / "resets at 21:00" → ms until then (today, else tomorrow), capped at 6 h.
function resetIn(t) {
  const m = t.match(/resets?(?: at)? (\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return null;
  let h = Number(m[1]) % 12 + (/pm/i.test(m[3] || '') ? 12 : 0);
  if (!m[3]) h = Number(m[1]);
  const at = new Date();
  at.setHours(h, Number(m[2] || 0), 0, 0);
  if (at <= new Date()) at.setDate(at.getDate() + 1);
  return Math.min(6 * 3600_000, at - Date.now() + 60_000);
}

// The arms wisp may route to, from listAgents(): each harness's default model, the models the
// priors know, models with history here, and new models in a known family (on probation).
function candidates(agents, known) {
  const out = [];
  for (const a of agents) {
    if (!a.available) continue;
    const models = new Set(['', ...(a.models || []).map((m) => m.id)]);
    for (const id of models) {
      const k = armKey(a.id, id);
      if (id === '' || PRIORS.arms[k] || known.has(k) || [...known, ...Object.keys(PRIORS.arms)].some((x) => family(x) === family(k) && x !== k && x.startsWith(`${a.id}:`))) {
        out.push({ key: k, agent: a.id, model: id, label: `${a.name}${id ? ` · ${(a.models || []).find((m) => m.id === id)?.label || id}` : ''}`, delegates: a.delegates !== false });
      }
    }
  }
  return out;
}

// --- the router ------------------------------------------------------------------------------

export class Router {
  constructor(home, { now = Date.now } = {}) {
    this.file = path.join(home, 'router.json');
    this.now = now;
    this.state = { version: 1, arms: {}, stats: {}, routes: {} };
    try {
      Object.assign(this.state, JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {}
    this.synced = false;
  }

  save() {
    try {
      writeJsonAtomic(this.file, this.state); // a cut-off file would load as nothing learned
    } catch (err) {
      console.warn(`wisp: router: ${err.message}`);
    }
  }

  // New harnesses and models since the last look. The first look only learns what's there.
  // Returns [{ key, label }] of arms that just showed up (they start on probation).
  sync(agents) {
    const first = !Object.keys(this.state.arms).length;
    const known = new Set(Object.keys(this.state.arms));
    const added = [];
    const seen = new Set();
    for (const c of candidates(agents, known)) {
      seen.add(c.key);
      const arm = this.state.arms[c.key];
      if (!arm) {
        // Something new later on is on probation until it has shown what it can do.
        this.state.arms[c.key] = { firstSeen: this.now(), state: first || this.#prior(c.key) ? 'ready' : 'new' };
        if (!first) added.push({ key: c.key, label: c.label, state: this.state.arms[c.key].state });
      } else if (arm.state === 'gone') arm.state = 'ready';
    }
    for (const [k, arm] of Object.entries(this.state.arms)) if (!seen.has(k) && arm.state !== 'gone' && agents.some((a) => a.id === splitKey(k).agent)) arm.state = 'gone';
    this.synced = true;
    this.save();
    return added;
  }

  #prior(k) {
    const p = PRIORS.arms[k];
    if (p) return p;
    // A new version inherits its family's record, with less weight.
    const kin = Object.entries(PRIORS.arms).filter(([x]) => family(x) === family(k) && splitKey(x).agent === splitKey(k).agent);
    if (!kin.length) return null;
    const [, best] = kin.sort((a, b) => b[1].a + b[1].b - (a[1].a + a[1].b))[0];
    const s = Math.min(1, 4 / (best.a + best.b));
    return { ...best, a: best.a * s, b: best.b * s, inherited: true };
  }

  // Decayed counts for (kind, arm) from this user's routes.
  #counts(type, key) {
    const s = this.state.stats[`${type}|${key}`];
    if (!s) return { a: 0, b: 0, n: 0, usd: null, ms: null };
    const age = this.now() - (s.at || this.now());
    const f = Math.pow(0.5, age / HALF_LIFE_MS);
    return { a: s.a * f, b: s.b * f, n: s.n, usd: s.usdN ? s.usd / s.usdN : null, ms: s.n ? s.ms / s.n : null };
  }

  // Beta posterior for an arm on a kind of task, plus what it usually costs.
  estimate(type, key) {
    const prior = this.#prior(key) || { a: 1, b: 1 };
    const scale = Math.min(1, PRIOR_CAP / Math.max(1, prior.a + prior.b));
    const mine = this.#counts(type, key);
    const all = this.#counts('*', key);
    const a = 1 + prior.a * scale + (all.a - mine.a) * ALL_WEIGHT + mine.a;
    const b = 1 + prior.b * scale + (all.b - mine.b) * ALL_WEIGHT + mine.b;
    // Cost and time: the prior's guess, pulled toward what this user's runs actually cost as they add up.
    const blend = (own, n, guess) => (own === null ? guess : (guess * 3 + own * n) / (3 + n));
    const usd = blend(all.usd, all.n, prior.usd ?? 0.3);
    const minutes = blend(all.ms === null ? null : all.ms / 60_000, all.n, prior.min ?? 5);
    return { a, b, mean: a / (a + b), n: mine.n, nAll: all.n, usd: round(usd, 4), minutes, prior: !!PRIORS.arms[key], inherited: !!prior.inherited };
  }

  // Pick an arm. agents: listAgents() of the place it runs. goal: cheap | balanced | best.
  // important: no exploring. exclude: arm keys already taken (compare). needDelegate: the lead
  // of a team must be a harness that can delegate. rng: for tests.
  // scouted: { type, size } from the scout, which beats the keyword guess.
  // minTier: only arms at least that strong (a hand-over steps up). Arms cooling down after a usage
  // or rate limit are skipped while any other arm can run.
  choose({ prompt = '', attachments = 0, agents = [], goal = 'balanced', important = false, explore = true, exclude = [], needDelegate = false, allowed = null, scouted = null, minTier = 0, rng = Math.random } = {}) {
    if (!this.synced) this.sync(agents);
    const guess = classify(prompt, { attachments });
    const type = scouted?.type || guess.type;
    const size = scouted?.size || guess.size;
    const V = (GOALS[goal] || GOALS.balanced).value;
    let arms = candidates(agents, new Set(Object.keys(this.state.arms)))
      .filter((c) => !exclude.includes(c.key) && (!needDelegate || c.delegates) && (!allowed || allowed.includes(c.agent)))
      .map((c) => ({ ...c, est: this.estimate(type, c.key), state: this.state.arms[c.key]?.state || 'new' }));
    if (!arms.length) return null;
    const free = arms.filter((x) => !this.cooling(x.key));
    if (!free.length) return null; // everything allowed is at its limit: nothing to route to now
    arms = free;
    // Cold start: until there are enough of your own outcomes, lean to quality (the shipped priors
    // are thin). Cheap is left alone: that goal asked for cheap.
    const cold = this.learned() < COLD_START;
    const floorTier = Math.max(minTier, cold && goal === 'best' ? 3 : cold && goal !== 'cheap' ? 2 : 0);
    for (let t = floorTier; t > 0; t--) {
      const strong = arms.filter((x) => tierOf(x.key) >= t);
      if (strong.length) {
        arms = strong;
        break;
      }
    }
    // Quality floor: an arm that keeps failing this kind of task here is left out.
    const floor = arms.filter((x) => !(x.est.n >= 5 && x.est.mean < 0.35));
    if (floor.length) arms = floor;
    const utility = (x, theta) => V * theta - x.est.usd - MINUTE_USD * x.est.minutes;
    const draw = (r) => {
      const pool = arms.filter((x) => x.state !== 'new' || (explore && !important && r() < NEW_ARM_SHARE));
      const list = pool.length ? pool : arms;
      let best = null;
      let bu = -Infinity;
      for (const x of list) {
        const theta = important || !explore ? x.est.mean : betaSample(x.est.a, x.est.b, r);
        const u = utility(x, theta);
        if (u > bu) (best = x), (bu = u);
      }
      return best;
    };
    const pick = draw(rng);
    // How likely this pick was: logged so the router's own choices can be corrected for later.
    let hits = 0;
    const sim = mulberry32(Math.floor(rng() * 2 ** 31));
    for (let i = 0; i < 200; i++) if (draw(sim).key === pick.key) hits++;
    const byMean = [...arms].sort((p, q) => utility(q, q.est.mean) - utility(p, p.est.mean));
    return {
      agent: pick.agent,
      model: pick.model,
      key: pick.key,
      label: pick.label,
      route: {
        goal: GOALS[goal] ? goal : 'balanced',
        type,
        size,
        key: pick.key,
        label: pick.label,
        chance: round(pick.est.mean),
        n: pick.est.n,
        usd: round(pick.est.usd),
        minutes: round(pick.est.minutes, 1),
        explored: byMean[0].key !== pick.key,
        trying: pick.state === 'new',
        tier: tierOf(pick.key),
        ...(cold && goal !== 'cheap' && { coldStart: true }),
        propensity: round(hits / 200),
        alternatives: byMean.filter((x) => x.key !== pick.key).slice(0, 3).map((x) => ({ key: x.key, label: x.label, chance: round(x.est.mean), usd: round(x.est.usd) })),
        at: this.now(),
      },
    };
  }

  // A launch went out with this route. id: the session id (id@machine for one on a machine).
  record(id, route) {
    this.state.routes[id] = { ...route, signals: {}, r: null };
    const ids = Object.keys(this.state.routes);
    if (ids.length > MAX_ROUTES) for (const old of ids.slice(0, ids.length - MAX_ROUTES)) delete this.state.routes[old];
    this.save();
  }

  // Something happened to a routed session: { hero, error, followups, feedback, merged, closed,
  // rolledBack, switched, costUsd, ms }. The reward is recomputed and the stats move by the difference.
  signal(id, patch) {
    const route = this.state.routes[id];
    if (!route || route.void) return route || null;
    Object.assign(route.signals, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
    const r = reward(route.signals);
    if (r === null) return this.save(), route;
    for (const type of [route.type, '*']) {
      const k = `${type}|${route.key}`;
      const s = (this.state.stats[k] ||= { a: 0, b: 0, n: 0, usd: 0, usdN: 0, ms: 0, at: this.now() });
      if (route.r === null) {
        s.n++;
        if (typeof route.signals.costUsd === 'number') (s.usd += route.signals.costUsd), s.usdN++;
        s.ms += route.signals.ms || 0;
      } else {
        s.a -= route.r;
        s.b -= 1 - route.r;
      }
      s.a += r;
      s.b += 1 - r;
      s.at = this.now();
    }
    route.r = r;
    // Probation ends once an arm has a few outcomes of its own.
    const arm = this.state.arms[route.key];
    if (arm?.state === 'new' && (this.state.stats[`*|${route.key}`]?.n || 0) >= 3) arm.state = 'ready';
    this.save();
    return route;
  }

  route(id) {
    return this.state.routes[id] || null;
  }

  // Outcomes of your own tasks the router has learned from.
  learned() {
    return Object.values(this.state.routes).filter((r) => r.r !== null).length;
  }

  // A harness (or one model) hit a usage or rate limit: skip it until it resets.
  cool(key, { scope = 'arm', ms = 10 * 60_000, why = '' } = {}) {
    const target = scope === 'agent' ? `${splitKey(key).agent}:*` : key;
    (this.state.cooling ||= {})[target] = { until: this.now() + ms, why: String(why).slice(0, 160) };
    this.save();
    return target;
  }

  cooling(key) {
    const c = this.state.cooling || {};
    const hit = c[key] || c[`${splitKey(key).agent}:*`];
    return hit && hit.until > this.now() ? hit : null;
  }

  // The run never got to work (the harness was at its limit): forget it ever counted.
  void(id) {
    const route = this.state.routes[id];
    if (!route) return;
    if (route.r !== null) {
      for (const type of [route.type, '*']) {
        const s = this.state.stats[`${type}|${route.key}`];
        if (!s) continue;
        s.a -= route.r;
        s.b -= 1 - route.r;
        s.n = Math.max(0, s.n - 1);
      }
    }
    route.r = null;
    route.void = true;
    this.save();
  }

  reset() {
    this.state.stats = {};
    this.state.routes = {};
    this.save();
  }

  // Settings → Auto: every arm with its record overall and per kind, and the latest routes.
  report(agents = []) {
    const keys = new Set([...Object.keys(this.state.arms), ...candidates(agents, new Set(Object.keys(this.state.arms))).map((c) => c.key)]);
    const labels = Object.fromEntries(candidates(agents, keys).map((c) => [c.key, c.label]));
    const arms = [...keys]
      .map((k) => {
        const e = this.estimate('*', k);
        const byType = Object.fromEntries(TYPES.map((t) => [t, this.#counts(t, k)]).filter(([, c]) => c.n).map(([t]) => [t, { n: this.#counts(t, k).n, chance: round(this.estimate(t, k).mean) }]));
        const state = this.state.arms[k]?.state || (labels[k] ? 'ready' : 'gone');
        const cool = this.cooling(k);
        return { key: k, ...splitKey(k), label: labels[k] || k, tier: tierOf(k), ...(cool && { coolingUntil: cool.until, coolingWhy: cool.why }), state: cool && state !== 'gone' ? 'cooling' : state === 'ready' && !e.prior && !e.inherited && !e.nAll ? 'untried' : state, chance: round(e.mean), n: e.n, usd: round(e.usd), minutes: round(e.minutes, 1), prior: e.prior, byType };
      })
      .filter((a) => a.state !== 'gone' || a.n)
      .sort((p, q) => q.chance - p.chance);
    const routes = Object.entries(this.state.routes).map(([id, r]) => ({ id, ...r }));
    return {
      priors: { version: PRIORS.version, source: PRIORS.source },
      learned: routes.filter((r) => r.r !== null).length,
      coldStart: { needed: COLD_START, have: this.learned() },
      routed: routes.length,
      arms,
      recent: routes.sort((p, q) => q.at - p.at).slice(0, 30).map((r) => ({ id: r.id, key: r.key, label: r.label, type: r.type, goal: r.goal, chance: r.chance, r: r.r, explored: r.explored, trying: r.trying, at: r.at, signals: r.signals })),
    };
  }
}

export function reward(sig) {
  // The user moved the task to another harness or model: whatever happens next isn't this arm's.
  if (sig.switched) return 0.1;
  if (sig.merged) return 1;
  if (sig.feedback === 'up') return 1;
  if (sig.feedback === 'down') return 0;
  if (sig.closed) return 0.2;
  if (sig.rolledBack) return 0.1;
  if (sig.error || sig.check === 'error') return 0;
  // wisp's own test run beats the agent's word; needing a repair round costs some of the credit,
  // and losing a best-of-2 to the other run a little more.
  if (sig.check === 'fail') return 0.1;
  if (sig.check === 'pass') return round(Math.max(0.3, (sig.repaired ? 0.6 : 0.8) - (sig.picked === false ? 0.15 : 0) - 0.1 * (sig.followups || 0)));
  const base = { done: 0.6, partial: 0.3, blocked: 0.1, info: 0.5 }[sig.hero];
  if (base === undefined) return null;
  return round(Math.max(0.05, base - 0.1 * (sig.followups || 0)));
}

const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Beta(a, b) from two Gamma draws (Marsaglia–Tsang).
function gammaSample(k, r) {
  if (k < 1) return gammaSample(k + 1, r) * Math.pow(r() || 1e-12, 1 / k);
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x;
    let v;
    do {
      const u1 = r() || 1e-12;
      const u2 = r();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = r() || 1e-12;
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
}
export function betaSample(a, b, r = Math.random) {
  const x = gammaSample(a, r);
  const y = gammaSample(b, r);
  return x / (x + y);
}
