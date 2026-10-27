// Auto: wisp picks the harness, model and thinking level for a task, and learns from how it went.
//
// Every harness × model × thinking level the user has is an "arm" (claude:opus:high; no level is
// the model's default). Before your first task, what Auto knows comes from public benchmarks
// (./router-priors.json, built by scripts/priors.mjs from scripts/priors-sources.json), each model
// and level placed against Claude Code's default, Opus 5.5 at medium. claude:, claude:opus and
// claude:opus:medium are one run under three names (canon()), with one record.
//
// It then learns two things from you. What you pick yourself is your taste: every launch you make
// with a harness of your choosing counts, per kind of task (bug, ui, docs, …), and Auto starts from
// your habits instead of second-guessing them. How runs went is the record: a Beta(wins, losses)
// per arm and kind, stacked from the benchmarks, your history on every kind of task and on this
// kind. A launch takes each arm's chance of success (drawn, Thompson-style, unless the pick is a
// preview, important or exploring is off), adds your taste for it, and picks the best value for
// the goal: value × chance − expected $ − a price on your waiting time. Never pick and Prefer
// rules from Settings come on top. A better arm that isn't your habit is offered, not run: the
// pick carries it as a suggestion.
//
// What happened afterwards is the reward, strongest signal first: switched to another harness or
// model in a follow-up (0.1), merged (1) / PR closed (0.2), 👍 (1) / 👎 (0), rolled back (0.1),
// else the presentation's hero (done 0.6, partial 0.3, blocked 0.1, error 0) less 0.1 per
// follow-up. A later, stronger signal replaces an earlier one. Runs you picked yourself count half.
// Changing Auto's preview before sending counts against its pick and for yours.
//
// State lives in ~/.wisp/router.json; nothing leaves the machine except the anonymous telemetry
// fields the caller adds. Routes are recorded for local sessions and for sessions launched on
// machines (id@machine): one router per user, fed by every place it runs.

import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './util.js';
import { LEVEL_COST, LEVEL_TIME } from './priors-build.js';

const PRIORS = JSON.parse(fs.readFileSync(new URL('./router-priors.json', import.meta.url), 'utf8'));
export const PRIOR_INFO = { version: PRIORS.version, source: PRIORS.source, sources: PRIORS.sources };

export const GOALS = {
  cheap: { label: 'Cheap', value: 1, hint: 'Lowest cost that still gets it done' },
  balanced: { label: 'Balanced', value: 5, hint: 'Frontier models as their makers ship them, a level up where it pays' },
  best: { label: 'Best', value: 50, hint: 'Frontier models at high thinking; cost only breaks ties' },
};
export const TYPES = ['bug', 'feature', 'ui', 'test', 'refactor', 'docs', 'release', 'question'];
const MINUTE_USD = 0.05; // what a minute of waiting costs you, in the utility
const PRIOR_CAP = 8; // benchmarks count as at most this many tasks, so your own soon outweigh them
const ALL_WEIGHT = 0.5; // your history on other kinds of task counts half
const HALF_LIFE_MS = 30 * 864e5; // models change: older outcomes fade
const TASTE_HALF_LIFE_MS = 60 * 864e5; // habits change slower than models do
const TASTE = 0.25; // your habit is worth up to this much chance of success
const PREFER = 0.1; // a Prefer rule from Settings
const MANUAL_WEIGHT = 0.5; // a run you picked yourself teaches the record half as much
const SUGGEST_MARGIN = 0.04; // how much better (in chance) an arm must look to be suggested
const LEVEL_WEIGHT = 0.5; // the same model's record at its other thinking levels counts half
const MAX_ROUTES = 2000;
const MAX_PAIRS = 500;

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

// --- arms ---------------------------------------------------------------------------------

// Thinking levels against medium: a shift in the chance of success and multipliers on cost and
// time. From Anthropic's Opus 5.5 sweep (low −5 pts at 0.52× the cost, high +2.5 pts at 1.38×,
// xhigh +4 at 3.5×); only for models the benchmarks don't cover, and outcomes take over.
export const EFFORTS = {
  minimal: { chance: -0.08, usd: LEVEL_COST.minimal, min: LEVEL_TIME.minimal },
  low: { chance: -0.05, usd: LEVEL_COST.low, min: LEVEL_TIME.low },
  medium: { chance: 0, usd: 1, min: 1 },
  high: { chance: 0.03, usd: LEVEL_COST.high, min: LEVEL_TIME.high },
  xhigh: { chance: 0.04, usd: LEVEL_COST.xhigh, min: LEVEL_TIME.xhigh },
  max: { chance: 0.06, usd: LEVEL_COST.max, min: LEVEL_TIME.max },
};
const ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
// The levels each goal may run at, where the harness has them ('' is the model's own default).
// Cheap thinks low. Balanced runs the model as its makers ship it, or one step up: Sonnet runs at
// medium in Claude Code but scores 15 points more at high, so Balanced may take it there. Best
// thinks hard; xhigh costs 2.5× high for a point or two, so it has to earn its place.
export const levelsFor = (efforts = [], goal = 'balanced', def = '') => {
  const has = (e) => efforts.includes(e);
  let band;
  if (goal === 'cheap') band = ['minimal', 'low'].filter(has);
  else if (goal === 'best') band = ['high', 'xhigh'].filter(has);
  else {
    const up = ORDER.slice(ORDER.indexOf(def || 'medium') + 1).find(has);
    band = ['', ...(up && up !== 'xhigh' && up !== 'max' ? [up] : [])];
  }
  // The default named outright is the same run as '': keep one.
  if (def && band.includes('') && band.includes(def)) band = band.filter((e) => e !== def);
  return band.length ? band : [''];
};
// Some harnesses bake the level into the model id (Antigravity's gemini-4-argon-high, no separate
// selector): there the goal picks among a model's variants the same way.
const SUFFIX = /-(minimal|low|medium|high|xhigh|max)$/;
const NAMED = { cheap: ['minimal', 'low'], balanced: ['medium'], best: ['high', 'xhigh', 'max'] };
const stemOf = (k) => baseOf(canon(k)).replace(SUFFIX, '');
function byNamedLevel(cands, goal) {
  const want = NAMED[goal] || NAMED.balanced;
  const named = (c) => !c.efforts.length && c.model.match(SUFFIX)?.[1];
  const fits = new Set(cands.filter((c) => want.includes(named(c))).map((c) => stemOf(c.key)));
  return cands.filter((c) => !named(c) || want.includes(named(c)) || !fits.has(stemOf(c.key)));
}
const effortLabel = (e) => ({ xhigh: 'X-High' })[e] || e.charAt(0).toUpperCase() + e.slice(1);

export const armKey = (agent, model = '', effort = '') => `${agent}:${model || ''}${effort ? `:${effort}` : ''}`;
// agent:model[:effort]. A trailing segment is a level only if it's one wisp knows, so a model id
// with a colon in it (ollama's llama3:8b) stays whole.
export const splitKey = (k) => {
  const i = k.indexOf(':');
  const rest = k.slice(i + 1);
  const j = rest.lastIndexOf(':');
  const effort = j >= 0 && rest.slice(j + 1) && Object.hasOwn(EFFORTS, rest.slice(j + 1)) ? rest.slice(j + 1) : '';
  return { agent: k.slice(0, i), model: effort ? rest.slice(0, j) : rest, effort };
};
// The harness · model an arm runs on, whatever its level: probation, cooling and compare go by it.
export const baseOf = (k) => {
  const { agent, model } = splitKey(k);
  return armKey(agent, model);
};
// Versions stripped: claude-sonnet-5-5 and claude-sonnet-5-6 are one family, and a new version
// starts from what the family already showed.
// A level in the id is the same model too: gemini-4-argon-high starts from what -medium showed.
const family = (k) => k.replace(SUFFIX, '').replace(/[-.]?\d+([.-]\d+)*/g, '');

// What an arm really runs: the harness's default model named (Claude Code runs Opus) and the
// model's default level named (Opus at medium). claude:, claude:opus and claude:opus:medium are
// one run under three names, and share one record.
export function canon(key) {
  const { agent, model, effort } = splitKey(key);
  const m = model || PRIORS.aliases?.[agent] || '';
  const e = effort || PRIORS.defaults?.[armKey(agent, m)] || '';
  return armKey(agent, m, e);
}
// The level an arm thinks at ('' when nobody knows), and the arm without it.
const levelOf = (k) => splitKey(canon(k)).effort || splitKey(k).model.match(SUFFIX)?.[1] || '';
const stemKey = (k) => {
  const { agent, model } = splitKey(canon(k));
  return armKey(agent, model.replace(SUFFIX, ''));
};

// How strong a model is: 1 small or free, 2 everyday, 3 frontier. From the benchmarks
// (router-priors.json tiers) where they cover it, else from its name. Best runs on tier 3 only,
// Balanced on the strongest tier that can run, and hand-overs step up a tier.
export function tierOf(key) {
  const c = baseOf(canon(key));
  const stem = c.replace(SUFFIX, '');
  const tiers = PRIORS.tiers || {};
  const { agent, model } = splitKey(c);
  const seg = model.toLowerCase().split(/[-/.:_]/); // whole segments only: "gemini" is not "mini"
  const named = (list) => seg.some((x) => list.includes(x));
  const SMALL = ['haiku', 'flash', 'mini', 'nano', 'lite', 'small', 'free', 'fast', 'low'];
  if (tiers[c] ?? tiers[stem]) return tiers[c] ?? tiers[stem];
  // A variant the benchmarks don't cover: its name first (grok-4.7-build-fast is small), then its
  // family's tier (grok-4.6 is grok-4.7's).
  if (named(SMALL)) return 1;
  const fam = Object.entries(tiers).find(([k]) => splitKey(k).agent === agent && family(k) === family(stem))?.[1];
  if (fam) return fam;
  if (named(['opus', 'argon', 'ultra', 'pro', 'xhigh', 'high', 'max'])) return 3;
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

// The harness · models the benchmarks know, whatever level they were measured at.
const PRIOR_BASES = new Set(Object.keys(PRIORS.arms).map((k) => baseOf(k).replace(SUFFIX, '')));
const knownToPriors = (k) => PRIOR_BASES.has(baseOf(canon(k)).replace(SUFFIX, '')) || PRIOR_BASES.has(k.replace(SUFFIX, ''));

// The arms wisp may route to, from listAgents(): each harness's default model, the models the
// priors know, models with history here, and new models in a known family (on probation).
function candidates(agents, known) {
  const out = [];
  const fams = new Set([...known, ...PRIOR_BASES].map(family));
  for (const a of agents) {
    if (!a.available) continue;
    const models = new Set(['', ...(a.models || []).map((m) => m.id)]);
    for (const id of models) {
      const k = armKey(a.id, id);
      if (id === '' || knownToPriors(k) || known.has(k) || fams.has(family(k))) {
        const m = (a.models || []).find((x) => x.id === id);
        out.push({ key: k, agent: a.id, model: id, label: `${a.name}${id ? ` · ${m?.label || id}` : ''}`, efforts: m?.efforts ?? a.efforts ?? [], delegates: a.delegates !== false });
      }
    }
  }
  return out;
}

// A rule from Settings → Auto (never pick, prefer): 'claude' (the harness), 'claude:sonnet' (that
// model at every level) or 'claude:sonnet:high', optionally only for one kind of task ('…@ui').
export function ruleMatches(rule, key, type) {
  const [what, only] = String(rule).split('@');
  if (only && only !== type) return false;
  if (!what.includes(':')) return splitKey(key).agent === what;
  const r = splitKey(what);
  const k = splitKey(key);
  const c = splitKey(canon(key));
  if (r.agent !== k.agent) return false;
  const sameModel = r.model === k.model || r.model === c.model || canon(armKey(r.agent, r.model)) === canon(armKey(k.agent, k.model));
  if (!sameModel) return false;
  return !r.effort || r.effort === (k.effort || c.effort);
}

// --- the router ------------------------------------------------------------------------------

export class Router {
  constructor(home, { now = Date.now } = {}) {
    this.file = path.join(home, 'router.json');
    this.now = now;
    this.state = { version: 2, arms: {}, stats: {}, routes: {}, taste: {}, pairs: [] };
    try {
      Object.assign(this.state, JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {}
    this.state.taste ||= {};
    this.state.pairs ||= [];
    this.synced = false;
    // Never pick / Prefer / allowed / habits from Settings, read on every pick (services/auto.js).
    this.prefs = () => ({});
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
  // more: a machine's harnesses, on top of this computer's: none of these is marked gone.
  sync(agents, { more = false } = {}) {
    const first = !more && !Object.keys(this.state.arms).length;
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
    if (!more) for (const [k, arm] of Object.entries(this.state.arms)) if (!seen.has(k) && arm.state !== 'gone' && agents.some((a) => a.id === splitKey(k).agent)) arm.state = 'gone';
    if (!more) this.synced = true;
    if (!more || added.length) this.save();
    return added;
  }

  // What the benchmarks say about an arm: its own row, else the same model at another level
  // shifted by how hard it thinks, else its family's (a new version) at half weight.
  #prior(k) {
    const c = canon(k);
    if (PRIORS.arms[c]) return PRIORS.arms[c];
    const stem = stemKey(k);
    const lvl = levelOf(k);
    const shift = (p, from, inherited) => {
      const e = (x) => EFFORTS[x || 'medium'];
      const n = p.a + p.b;
      const s = inherited ? Math.min(1, 4 / n) : 1;
      const mean = Math.min(0.95, Math.max(0.05, p.a / n + e(lvl).chance - e(from).chance));
      return { a: mean * n * s, b: (1 - mean) * n * s, usd: p.usd * (e(lvl).usd / e(from).usd), min: p.min * (e(lvl).min / e(from).min), ...(inherited && { inherited: true }), from: p.from };
    };
    const closest = (list) => list.sort(([x], [y]) => Math.abs(ORDER.indexOf(levelOf(x)) - ORDER.indexOf(lvl)) - Math.abs(ORDER.indexOf(levelOf(y)) - ORDER.indexOf(lvl)))[0];
    const kin = Object.entries(PRIORS.arms).filter(([x]) => stemKey(x) === stem);
    if (kin.length) {
      const [x, p] = closest(kin);
      return shift(p, levelOf(x), false);
    }
    // A new version inherits its family's record, with less weight.
    const fam = Object.entries(PRIORS.arms).filter(([x]) => splitKey(x).agent === splitKey(c).agent && family(stemKey(x)) === family(stem));
    if (!fam.length) return null;
    const [x, p] = closest(fam);
    return shift(p, levelOf(x), true);
  }

  // Decayed counts for (kind, arm) from this user's routes; every name of the run counts.
  #counts(type, key) {
    const c = canon(key);
    const out = { a: 0, b: 0, n: 0, usd: 0, usdN: 0, ms: 0 };
    for (const [sk, s] of Object.entries(this.state.stats)) {
      const i = sk.indexOf('|');
      if (sk.slice(0, i) !== type || canon(sk.slice(i + 1)) !== c) continue;
      const f = Math.pow(0.5, (this.now() - (s.at || this.now())) / HALF_LIFE_MS);
      out.a += s.a * f;
      out.b += s.b * f;
      out.n += s.n;
      out.usd += s.usd;
      out.usdN += s.usdN;
      out.ms += s.ms;
    }
    return { a: out.a, b: out.b, n: out.n, usd: out.usdN ? out.usd / out.usdN : null, ms: out.n ? out.ms / out.n : null };
  }

  // The same model at its other thinking levels, on this kind of task.
  #levels(type, key) {
    const c = canon(key);
    const stem = stemKey(key);
    const out = { a: 0, b: 0 };
    const seen = new Set();
    for (const sk of Object.keys(this.state.stats)) {
      const i = sk.indexOf('|');
      const k = sk.slice(i + 1);
      if (sk.slice(0, i) !== type || canon(k) === c || stemKey(k) !== stem || seen.has(canon(k))) continue;
      seen.add(canon(k));
      const x = this.#counts(type, k);
      out.a += x.a;
      out.b += x.b;
    }
    return out;
  }

  // Beta posterior for an arm on a kind of task, plus what it usually costs.
  estimate(type, key) {
    const p = this.#prior(key);
    const prior = p || { a: 1, b: 1 };
    const scale = Math.min(1, PRIOR_CAP / Math.max(1, prior.a + prior.b));
    const mine = this.#counts(type, key);
    const all = this.#counts('*', key);
    const kin = this.#levels(type, key);
    // A flat Beta(1, 1) underneath only when the benchmarks say nothing: it would pull every
    // measured chance toward a coin flip.
    const flat = p ? 0 : 1;
    const a = flat + prior.a * scale + (all.a - mine.a) * ALL_WEIGHT + kin.a * LEVEL_WEIGHT + mine.a;
    const b = flat + prior.b * scale + (all.b - mine.b) * ALL_WEIGHT + kin.b * LEVEL_WEIGHT + mine.b;
    // Cost and time: the benchmarks' guess, pulled toward what this user's runs actually cost.
    const blend = (own, n, guess) => (own === null ? guess : (guess * 3 + own * n) / (3 + n));
    const usd = blend(all.usd, all.n, prior.usd ?? 0.3);
    const minutes = blend(all.ms === null ? null : all.ms / 60_000, all.n, prior.min ?? 5);
    return { a, b, mean: a / (a + b), n: mine.n, nAll: all.n, usd: round(usd, 4), minutes, prior: !!p && !p.inherited, inherited: !!p?.inherited, from: p?.from || [] };
  }

  // --- taste: what you pick yourself ---------------------------------------------------------

  // A launch you picked yourself (or a preview you changed): weight 1, a correction counts more.
  observe({ agent, model = '', effort = '', prompt = '', attachments = 0, type = null, at = this.now(), weight = 1 }) {
    if (!agent || agent === 'auto' || agent === 'wisp') return null;
    const raw = armKey(agent, model, effort);
    const c = canon(raw);
    const kind = type || classify(prompt, { attachments }).type;
    for (const t of [kind, '*']) {
      const k = `${t}|${c}`;
      const x = this.state.taste[k];
      const f = x ? Math.pow(0.5, Math.max(0, at - x.at) / TASTE_HALF_LIFE_MS) : 0;
      this.state.taste[k] = { n: (x?.n || 0) * f + weight, at: Math.max(at, x?.at || 0), raw: { ...x?.raw, [raw]: (x?.raw?.[raw] || 0) + 1 } };
    }
    return { key: raw, canon: c, type: kind };
  }

  // Your share of picks for this run on this kind of task (other kinds count half, and the same
  // model at another level half again). 0 when you've never picked it.
  taste(type, key) {
    const c = canon(key);
    const stem = stemKey(key);
    const sum = (t, match) => {
      let n = 0;
      let all = 0;
      for (const [k, x] of Object.entries(this.state.taste)) {
        const i = k.indexOf('|');
        if (k.slice(0, i) !== t) continue;
        const v = x.n * Math.pow(0.5, Math.max(0, this.now() - x.at) / TASTE_HALF_LIFE_MS);
        all += v;
        if (match(k.slice(i + 1))) n += v;
      }
      return { n, all };
    };
    const share = (t) => {
      const same = sum(t, (k) => k === c);
      const near = sum(t, (k) => k !== c && stemKey(k) === stem);
      return same.all ? (same.n + 0.5 * near.n) / same.all : 0;
    };
    const mine = sum(type, () => true).all;
    // Few picks on this kind yet: lean on your picks overall.
    const w = Math.min(1, mine / 5);
    return round(w * share(type) + (1 - w) * share('*'), 3);
  }

  // How many times you picked this run yourself, on this kind and overall.
  picks(type, key) {
    const c = canon(key);
    return { here: Math.round(this.state.taste[`${type}|${c}`]?.n || 0), all: Math.round(this.state.taste[`*|${c}`]?.n || 0) };
  }

  // The name you launch this run by (claude: rather than claude:opus:medium).
  #form(c, fallback) {
    const raw = this.state.taste[`*|${c}`]?.raw;
    if (!raw) return fallback;
    return Object.entries(raw).sort((x, y) => y[1] - x[1])[0][0];
  }

  // Your launches from before wisp learned taste: once, oldest first.
  backfill(sessions = []) {
    if (this.state.backfilled) return 0;
    let n = 0;
    for (const s of [...sessions].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))) {
      if (s.route || s.kind || !s.agent || s.agent === 'wisp' || s.crew || s.origin || s.parentId || s.delegated) continue;
      const first = s.turns?.[0];
      if (!first?.prompt) continue;
      if (this.observe({ agent: s.agent, model: s.model || '', effort: s.effort || '', prompt: first.prompt, attachments: (first.attachments || []).length, at: s.createdAt || this.now() })) n++;
    }
    this.state.backfilled = this.now();
    this.save();
    return n;
  }

  // You changed Auto's preview before sending: a point against its pick on this kind of task, and
  // a strong vote for yours.
  override({ type, auto, chose, prompt = '' }) {
    if (!auto || !chose || canon(auto) === canon(chose)) return;
    const { agent, model, effort } = splitKey(chose);
    this.observe({ agent, model, effort, prompt, type, weight: 2 });
    for (const [t, w] of [[type, 0.5], ['*', 0.25]]) {
      const s = (this.state.stats[`${t}|${canon(auto)}`] ||= { a: 0, b: 0, n: 0, usd: 0, usdN: 0, ms: 0, at: this.now() });
      s.b += w;
      s.at = this.now();
    }
    this.state.pairs.push({ type, auto: canon(auto), chose: canon(chose), at: this.now() });
    if (this.state.pairs.length > MAX_PAIRS) this.state.pairs.splice(0, this.state.pairs.length - MAX_PAIRS);
    this.save();
  }

  // --- picking -------------------------------------------------------------------------------

  // Pick an arm. agents: listAgents() of the place it runs. goal: cheap | balanced | best, which
  // also sets the band of thinking levels (levelsFor).
  // important: no exploring. exclude: arm keys already taken (compare, hand-overs): every level of
  // that harness · model is out, and every variant of a model with its level in its id.
  // needDelegate: the lead of a team must be a harness that can delegate. rng: for tests.
  // scouted: { type, size } from the scout, which beats the keyword guess.
  // minTier: only arms at least that strong (a hand-over steps up). Arms cooling down after a usage
  // or rate limit are skipped while any other arm can run.
  // preview: the pick to show before sending: no dice, the same answer every time. pin: the
  // preview you saw, kept at launch if it can still run, so what runs is what you were shown.
  // allowed, blocked, prefer, habits: from Settings (this.prefs()), unless passed.
  // Best runs frontier models only: if any is installed and allowed, Best never steps down a tier,
  // even when they're all taken or at their limit (null then). With none installed, the strongest.
  // Balanced runs on the strongest tier too, and steps down only while every frontier model is
  // taken or at its limit, so the task still runs.
  choose(opts = {}) {
    const p = { ...this.prefs(), ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) };
    let { prompt = '', attachments = 0, agents = [], goal = 'balanced', important = false, explore = true, exclude = [], needDelegate = false, allowed = null, blocked = [], prefer = [], habits = true, scouted = null, minTier = 0, preview = false, pin = null, rng = Math.random } = p;
    blocked ||= [];
    prefer ||= [];
    if (!this.synced) this.sync(agents);
    if (!GOALS[goal]) goal = 'balanced';
    const guess = classify(prompt, { attachments });
    const type = scouted?.type || guess.type;
    const size = scouted?.size || guess.size;
    const V = GOALS[goal].value;
    const out = new Set(exclude.map(stemOf));
    const usable = candidates(agents, new Set(Object.keys(this.state.arms))).filter((c) => (!needDelegate || c.delegates) && (!allowed || allowed.includes(c.agent)));
    const frontierOnly = goal === 'best' && usable.some((c) => tierOf(c.key) >= 3);
    let arms = byNamedLevel(usable.filter((c) => !out.has(stemOf(c.key))), goal)
      .filter((c) => !frontierOnly || tierOf(c.key) >= 3)
      .flatMap((c) => levelsFor(c.efforts, goal, PRIORS.defaults?.[baseOf(canon(c.key))] || '').map((effort) => ({ ...c, key: armKey(c.agent, c.model, effort), effort, label: `${c.label}${effort ? ` · ${effortLabel(effort)}` : ''}`, base: c.key })))
      .filter((c) => !blocked.some((r) => ruleMatches(r, c.key, type)));
    // One run under several names (claude: and claude:opus:medium): keep the one you launch by,
    // else the model named outright (the harness default may not be what the benchmarks assume).
    const byCanon = new Map();
    for (const c of arms) {
      const k = canon(c.key);
      const have = byCanon.get(k);
      const form = this.#form(k, null);
      const named = (x) => (splitKey(x.key).model ? 1 : 0);
      const better = !have || c.key === form || (have.key !== form && (named(c) > named(have) || (named(c) === named(have) && c.key.length < have.key.length)));
      if (better) byCanon.set(k, c);
    }
    arms = [...byCanon.values()].map((c) => ({ ...c, est: this.estimate(type, c.key), state: this.state.arms[c.base]?.state || 'new', taste: habits ? this.taste(type, c.key) : 0, preferred: prefer.some((r) => ruleMatches(r, c.key, type)) }));
    if (!arms.length) return null;
    const free = arms.filter((x) => !this.cooling(x.key));
    if (!free.length) return null; // everything allowed is at its limit: nothing to route to now
    arms = free;
    // Balanced and Best run on the strongest tier that can run now, whatever the record of the
    // weaker ones. Cheap is left alone: that goal asked for cheap.
    const top = Math.max(...arms.map((x) => tierOf(x.key)));
    const floorTier = Math.max(minTier, goal === 'cheap' ? 0 : top);
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
    const bonus = (x) => TASTE * x.taste + (x.preferred ? PREFER : 0);
    const utility = (x, theta, own = true) => V * (theta + (own ? bonus(x) : 0)) - x.est.usd - MINUTE_USD * x.est.minutes;
    const fixed = preview || important || !explore;
    const draw = (r) => {
      // New arms on probation aren't run behind your back: they're suggested (below).
      const pool = arms.filter((x) => x.state !== 'new' || x.taste > 0);
      const list = pool.length ? pool : arms;
      let best = null;
      let bu = -Infinity;
      for (const x of list) {
        const u = utility(x, fixed ? x.est.mean : betaSample(x.est.a, x.est.b, r));
        if (u > bu) (best = x), (bu = u);
      }
      return best;
    };
    const pinned = pin && arms.find((x) => x.key === pin || canon(x.key) === canon(pin));
    const pick = pinned || draw(rng);
    // How likely this pick was: logged so the router's own choices can be corrected for later.
    let hits = 0;
    const sim = mulberry32(Math.floor(rng() * 2 ** 31));
    if (fixed || pinned) hits = 200;
    else for (let i = 0; i < 200; i++) if (draw(sim).key === pick.key) hits++;
    const byMean = [...arms].sort((p, q) => utility(q, q.est.mean) - utility(p, p.est.mean));
    // Something that looks clearly better on the record than your habit: offered, not run.
    const plain = [...arms].sort((p, q) => utility(q, q.est.mean, false) - utility(p, p.est.mean, false));
    const rival = plain.find((x) => canon(x.key) !== canon(pick.key) && !x.preferred);
    const suggest = explore && rival && clearlyBetter(rival, pick, V, utility) ? { key: rival.key, agent: rival.agent, model: rival.model, effort: rival.effort, label: rival.label, chance: round(rival.est.mean), usd: round(rival.est.usd), trying: rival.state === 'new', why: whyOf(rival, type, this.picks(type, rival.key), goal, { suggest: true }) } : null;
    return {
      agent: pick.agent,
      model: pick.model,
      effort: pick.effort,
      key: pick.key,
      label: pick.label,
      route: {
        goal,
        type,
        size,
        key: pick.key,
        effort: pick.effort,
        label: pick.label,
        chance: round(pick.est.mean),
        n: pick.est.n,
        usd: round(pick.est.usd),
        minutes: round(pick.est.minutes, 1),
        explored: !pinned && byMean[0].key !== pick.key,
        trying: pick.state === 'new',
        tier: tierOf(pick.key),
        taste: pick.taste,
        ...(pinned && { pinned: true }),
        why: whyOf(pick, type, this.picks(type, pick.key), goal, { pinned: !!pinned, explored: !pinned && byMean[0].key !== pick.key }),
        propensity: round(hits / 200),
        alternatives: byMean.filter((x) => x.key !== pick.key).slice(0, 4).map((x) => ({ key: x.key, agent: x.agent, model: x.model, effort: x.effort, label: x.label, chance: round(x.est.mean), usd: round(x.est.usd) })),
        ...(suggest && { suggest }),
        at: this.now(),
      },
    };
  }

  // A hand-over that keeps the model and thinks harder: a run at low or medium that failed its
  // tests goes again at high (Anthropic: low, then failures at high, solves more than high
  // everywhere, for less), one at high goes to x-high. null when there's no level up.
  levelUp(route, agents = []) {
    if (!route?.key) return null;
    const { agent, model } = splitKey(route.key);
    const lvl = levelOf(route.key);
    const a = agents.find((x) => x.id === agent && x.available);
    const m = a?.models?.find((x) => x.id === model);
    const efforts = m?.efforts ?? a?.efforts ?? [];
    const to = !lvl ? null : ORDER.indexOf(lvl) < ORDER.indexOf('high') ? 'high' : lvl === 'high' ? 'xhigh' : null;
    if (!to || !efforts.includes(to)) return null;
    const key = armKey(agent, model, to);
    if (this.cooling(key)) return null;
    const est = this.estimate(route.type || '*', key);
    const label = `${route.label?.replace(/ · (Minimal|Low|Medium|High)$/, '') || key} · ${effortLabel(to)}`;
    return { agent, model, effort: to, key, label, route: { ...route, key, effort: to, label, chance: round(est.mean), usd: round(est.usd), why: 'The same model, thinking harder', at: this.now() } };
  }

  // A launch went out with this route. id: the session id (id@machine for one on a machine).
  // manual: a run you picked yourself (no route of Auto's): it teaches the record at half weight.
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
    const w = route.manual ? MANUAL_WEIGHT : 1;
    for (const type of [route.type, '*']) {
      const k = `${type}|${route.key}`;
      const s = (this.state.stats[k] ||= { a: 0, b: 0, n: 0, usd: 0, usdN: 0, ms: 0, at: this.now() });
      if (route.r === null) {
        s.n++;
        if (typeof route.signals.costUsd === 'number') (s.usd += route.signals.costUsd), s.usdN++;
        s.ms += route.signals.ms || 0;
      } else {
        s.a -= route.r * w;
        s.b -= (1 - route.r) * w;
      }
      s.a += r * w;
      s.b += (1 - r) * w;
      s.at = this.now();
    }
    route.r = r;
    // Probation ends once a harness · model has a few outcomes of its own, at any level.
    const base = baseOf(route.key);
    const arm = this.state.arms[base];
    const n = Object.entries(this.state.stats).reduce((sum, [k, x]) => sum + (k.startsWith('*|') && baseOf(k.slice(2)) === base ? x.n : 0), 0);
    if (arm?.state === 'new' && n >= 3) arm.state = 'ready';
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

  // A harness (or one model, at every level) hit a usage or rate limit: skip it until it resets.
  cool(key, { scope = 'arm', ms = 10 * 60_000, why = '' } = {}) {
    const target = scope === 'agent' ? `${splitKey(key).agent}:*` : baseOf(key);
    (this.state.cooling ||= {})[target] = { until: this.now() + ms, why: String(why).slice(0, 160) };
    this.save();
    return target;
  }

  cooling(key) {
    const c = this.state.cooling || {};
    const hit = c[key] || c[baseOf(key)] || c[baseOf(canon(key))] || c[`${splitKey(key).agent}:*`];
    return hit && hit.until > this.now() ? hit : null;
  }

  // The run never got to work (the harness was at its limit): forget it ever counted.
  void(id) {
    const route = this.state.routes[id];
    if (!route) return;
    if (route.r !== null) {
      const w = route.manual ? MANUAL_WEIGHT : 1;
      for (const type of [route.type, '*']) {
        const s = this.state.stats[`${type}|${route.key}`];
        if (!s) continue;
        s.a -= route.r * w;
        s.b -= (1 - route.r) * w;
        s.n = Math.max(0, s.n - 1);
      }
    }
    route.r = null;
    route.void = true;
    this.save();
  }

  // Forget outcomes and your picks; the benchmarks stay, and your old launches aren't read again.
  reset() {
    this.state.stats = {};
    this.state.routes = {};
    this.state.taste = {};
    this.state.pairs = [];
    this.state.backfilled ||= this.now();
    this.save();
  }

  // Settings → Auto: every harness · model, the thinking levels it has a record at, each with its
  // record overall and per kind, your picks of it, and the latest routes.
  report(agents = []) {
    const levels = Object.keys(this.state.stats).map((sk) => sk.slice(sk.indexOf('|') + 1)).filter((k) => splitKey(k).effort);
    const keys = new Set([...Object.keys(this.state.arms), ...candidates(agents, new Set(Object.keys(this.state.arms))).map((c) => c.key), ...levels]);
    const names = Object.fromEntries(candidates(agents, new Set([...keys].map(baseOf))).map((c) => [c.key, c.label]));
    const labels = Object.fromEntries([...keys].filter((k) => names[baseOf(k)]).map((k) => [k, `${names[baseOf(k)]}${splitKey(k).effort ? ` · ${effortLabel(splitKey(k).effort)}` : ''}`]));
    const { blocked = [], prefer = [] } = this.prefs();
    // One row per run: claude: and claude:opus:medium are the same one.
    const rows = new Map();
    for (const k of keys) {
      const c = canon(k);
      const have = rows.get(c);
      if (!have || (labels[k] && !labels[have]) || (labels[k] && k.length < have.length)) rows.set(c, k);
    }
    const arms = [...rows.values()]
      .map((k) => {
        const e = this.estimate('*', k);
        const byType = Object.fromEntries(TYPES.map((t) => [t, this.#counts(t, k)]).filter(([, c]) => c.n).map(([t]) => [t, { n: this.#counts(t, k).n, chance: round(this.estimate(t, k).mean) }]));
        const state = this.state.arms[baseOf(k)]?.state || (labels[k] ? 'ready' : 'gone');
        const cool = this.cooling(k);
        const picks = this.picks('*', k).all;
        return { key: k, ...splitKey(k), canon: canon(k), label: labels[k] || k, tier: tierOf(k), ...(cool && { coolingUntil: cool.until, coolingWhy: cool.why }), state: cool && state !== 'gone' ? 'cooling' : state === 'ready' && !e.prior && !e.inherited && !e.nAll && !picks ? 'untried' : state, chance: round(e.mean), n: e.n, usd: round(e.usd), minutes: round(e.minutes, 1), prior: e.prior, inherited: e.inherited, from: e.from, picks, blocked: blocked.some((r) => !r.includes('@') && ruleMatches(r, k)), preferred: prefer.some((r) => !r.includes('@') && ruleMatches(r, k)), byType };
      })
      .filter((a) => a.state !== 'gone' || a.n)
      .sort((p, q) => q.picks - p.picks || q.chance - p.chance);
    const routes = Object.entries(this.state.routes).map(([id, r]) => ({ id, ...r }));
    return {
      priors: PRIOR_INFO,
      learned: routes.filter((r) => r.r !== null).length,
      routed: routes.filter((r) => !r.manual).length,
      picks: Math.round(Object.entries(this.state.taste).reduce((s, [k, x]) => s + (k.startsWith('*|') ? x.n : 0), 0)),
      corrections: this.state.pairs.length,
      arms,
      recent: routes.filter((r) => !r.manual).sort((p, q) => q.at - p.at).slice(0, 30).map((r) => ({ id: r.id, key: r.key, label: r.label, type: r.type, goal: r.goal, chance: r.chance, r: r.r, explored: r.explored, trying: r.trying, why: r.why, at: r.at, signals: r.signals })),
    };
  }
}

// Is a beat b on the record alone, by enough to be worth mentioning?
function clearlyBetter(a, b, V, utility) {
  return a.est.mean >= b.est.mean + SUGGEST_MARGIN && utility(a, a.est.mean, false) > utility(b, b.est.mean, false);
}

// Why this pick, in a few words: your habit, your record, the benchmarks, or the goal.
function whyOf(x, type, picks, goal, { pinned = false, explored = false, suggest = false } = {}) {
  const pct = `${Math.round(x.est.mean * 100)}%`;
  const parts = [];
  if (suggest) parts.push(x.est.n >= 3 ? `${pct} on your ${type} tasks (${x.est.n})` : `${pct} expected from public benchmarks`);
  else if (explored) parts.push('trying an alternative to learn');
  else if (x.taste >= 0.2 && picks.here >= 3) parts.push(`your usual for ${type} tasks (${picks.here} of yours)`);
  else if (x.taste >= 0.2 && picks.all >= 3) parts.push(`your usual pick (${picks.all} of yours)`);
  else if (x.taste >= 0.2) parts.push('the model you usually run');
  else if (x.est.n >= 3) parts.push(`${pct} on your ${type} tasks (${x.est.n})`);
  else if (x.est.prior) parts.push(`${pct} expected from public benchmarks`);
  else if (x.est.inherited) parts.push(`${pct} expected from its family's benchmarks`);
  else parts.push(`${pct} expected`);
  if (x.preferred) parts.push('you prefer it');
  if (x.effort && !suggest) parts.push(`${effortLabel(x.effort)} thinking for ${GOALS[goal].label}`);
  if (pinned) parts.push('as previewed');
  return parts.join(' · ');
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
