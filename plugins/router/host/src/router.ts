// The router (v1 server/router.js Router): what it knows, what it learns, and how it picks. State is
// in memory (state.ts) and written as rows after every change (rows.ts, through `persist`), the way
// v1 saved router.json after every change. Picks only read.
//
// What happened after a run is the reward (api `reward`): a later, stronger signal replaces an earlier
// one, the stats move by the difference. Runs you picked yourself count half.

import { armKey, classify, reward, splitKey } from '@wisp-plugin/router-api';
import type { AgentInfo, ChooseArgs, CoolArgs, ObserveArgs, OverrideArgs, Pick, Route, Signals, StoredRoute } from '@wisp-plugin/router-api';
import { choose, levelUp } from './choose.ts';
import type { PickEnv } from './choose.ts';
import { estimate, picks, taste, TASTE_HALF_LIFE_MS } from './estimate.ts';
import type { Estimate } from './estimate.ts';
import { priorOf } from './estimate.ts';
import { baseOf, candidates, canon } from './keys.ts';
import { mulberry32 } from './math.ts';
import type { Rng } from './math.ts';
import { RouterState } from './state.ts';
import type { Cool } from './state.ts';

const MANUAL_WEIGHT = 0.5; // a run you picked yourself teaches the record half as much
const MAX_ROUTES = 2000;
const MAX_PAIRS = 500;

/** A launch from before wisp learned taste (backfill). */
export interface PastLaunch {
  agent: string;
  model?: string;
  effort?: string;
  createdAt?: number;
  prompt?: string;
  attachments?: number;
  /** not a launch you picked: Auto's, a crew job, a channel's, a subagent's, a spell's */
  skip?: boolean;
}

export interface RouterDeps {
  now(): number;
  /** writes what changed (rows.ts flush); nothing in pure tests */
  persist?(st: RouterState): void;
}

export class Router {
  readonly st: RouterState;
  readonly #deps: RouterDeps;
  /** this computer's harnesses were looked at once: every pick before that judges new arms virtually */
  synced = false;
  /** Never pick / Prefer / allowed / habits from Settings, read on every pick */
  prefs: () => Partial<ChooseArgs> = () => ({});

  constructor(deps: RouterDeps, st = new RouterState()) {
    this.#deps = deps;
    this.st = st;
  }

  now(): number {
    return this.#deps.now();
  }

  #save(): void {
    this.#deps.persist?.(this.st);
  }

  /** What a pick reads. */
  env(): PickEnv {
    return { st: this.st, now: this.now(), prefs: () => this.prefs(), cooling: (k) => this.cooling(k), armState: (b) => this.armState(b) };
  }

  /** An arm's state; one the router hasn't seen is what the next sync would make it. */
  armState(base: string): 'ready' | 'new' | 'gone' {
    const known = this.st.arms.get(base)?.state;
    if (known) return known;
    return this.st.arms.size === 0 || priorOf(base) ? 'ready' : 'new';
  }

  /**
   * New harnesses and models since the last look; the first look only learns what's there. Returns
   * the arms that just showed up (on probation unless the benchmarks know them). `more`: a machine's
   * harnesses, on top of this computer's: none of these is marked gone.
   */
  sync(agents: readonly AgentInfo[], o: { more?: boolean } = {}): { key: string; label: string; state: string }[] {
    const more = !!o.more;
    const first = !more && this.st.arms.size === 0;
    const added: { key: string; label: string; state: string }[] = [];
    const seen = new Set<string>();
    for (const c of candidates(agents, new Set(this.st.arms.keys()))) {
      seen.add(c.key);
      const arm = this.st.arms.get(c.key);
      if (!arm) {
        const state = first || priorOf(c.key) ? 'ready' : 'new';
        this.st.arms.set(c.key, { firstSeen: this.now(), state });
        this.st.touch('arms', c.key);
        if (!first) added.push({ key: c.key, label: c.label, state });
      } else if (arm.state === 'gone') {
        arm.state = 'ready';
        this.st.touch('arms', c.key);
      }
    }
    if (!more) {
      for (const [k, arm] of this.st.arms) {
        if (seen.has(k) || arm.state === 'gone' || !agents.some((a) => a.id === splitKey(k).agent)) continue;
        arm.state = 'gone';
        this.st.touch('arms', k);
      }
      this.synced = true;
    }
    this.#save();
    return added;
  }

  estimate(type: string, key: string): Estimate {
    return estimate(this.st, type, key, this.now());
  }

  taste(type: string, key: string): number {
    return taste(this.st, type, key, this.now());
  }

  picks(type: string, key: string): { here: number; all: number } {
    return picks(this.st, type, key);
  }

  /** A launch you picked yourself (or a preview you changed): weight 1, a correction counts more. */
  observe(o: ObserveArgs): { key: string; canon: string; type: string } | null {
    if (!o.agent || o.agent === 'auto' || o.agent === 'wisp') return null;
    const at = o.at ?? this.now();
    const raw = armKey(o.agent, o.model ?? '', o.effort ?? '');
    const c = canon(raw);
    const kind = o.type || classify(o.prompt ?? '', { attachments: o.attachments ?? 0 }).type;
    for (const t of [kind, '*']) {
      const k = `${t}|${c}`;
      const x = this.st.taste.get(k);
      const f = x ? Math.pow(0.5, Math.max(0, at - x.at) / TASTE_HALF_LIFE_MS) : 0;
      this.st.setTaste(k, { n: (x?.n ?? 0) * f + (o.weight ?? 1), at: Math.max(at, x?.at ?? 0), raw: { ...x?.raw, [raw]: (x?.raw[raw] ?? 0) + 1 } });
      this.st.touch('taste', k);
    }
    this.#save();
    return { key: raw, canon: c, type: kind };
  }

  /** Your launches from before wisp learned taste: once, oldest first. */
  backfill(sessions: readonly PastLaunch[]): number {
    if (this.st.backfilled) return 0;
    let n = 0;
    for (const s of [...sessions].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))) {
      if (s.skip || !s.agent || s.agent === 'wisp' || !s.prompt) continue;
      if (this.observe({ agent: s.agent, model: s.model ?? '', effort: s.effort ?? '', prompt: s.prompt, attachments: s.attachments ?? 0, at: s.createdAt ?? this.now() })) n++;
    }
    this.st.backfilled = this.now();
    this.st.dirty.meta = true;
    this.#save();
    return n;
  }

  /** You changed Auto's preview before sending: a point against its pick on this kind, a strong vote for yours. */
  override(o: OverrideArgs): void {
    if (!o.auto || !o.chose || canon(o.auto) === canon(o.chose)) return;
    const { agent, model, effort } = splitKey(o.chose);
    this.observe({ agent, model, effort, prompt: o.prompt ?? '', type: o.type, weight: 2 });
    for (const [t, w] of [[o.type, 0.5], ['*', 0.25]] as const) {
      const s = this.st.statOf(t, canon(o.auto), this.now());
      s.b += w;
      s.at = this.now();
    }
    const pair = { type: o.type, auto: canon(o.auto), chose: canon(o.chose), at: this.now() };
    this.st.pairs.push(pair);
    this.st.dirty.pairs.push(pair);
    for (const old of this.st.pairs.splice(0, Math.max(0, this.st.pairs.length - MAX_PAIRS))) {
      if (old.id !== undefined) this.st.dirty.dropPairs.push(old.id);
      else this.st.dirty.pairs = this.st.dirty.pairs.filter((p) => p !== old);
    }
    this.#save();
  }

  /** Pick an arm (choose.ts); `seed` or `rng` for the dice. */
  choose(o: ChooseArgs, rng?: Rng): Pick | null {
    return choose(this.env(), o, rng ?? (o.seed !== undefined ? mulberry32(o.seed) : Math.random));
  }

  levelUp(route: Partial<Route> & { key?: string }, agents: readonly AgentInfo[]): Pick | null {
    return levelUp(this.env(), route, agents);
  }

  /** A launch went out with this route. id: the session id (`id@machine` for one on a machine). */
  record(id: string, route: Partial<StoredRoute> & { key: string; type: string }): void {
    this.st.routes.set(id, { ...route, at: route.at ?? this.now(), signals: {}, r: null });
    this.st.touch('routes', id);
    const extra = this.st.routes.size - MAX_ROUTES;
    if (extra > 0)
      for (const old of [...this.st.routes.keys()].slice(0, extra)) {
        this.st.routes.delete(old);
        this.st.touch('routes', old);
      }
    this.#save();
  }

  /** Something happened to a routed session: the reward is recomputed, the stats move by the difference. */
  signal(id: string, patch: Signals): StoredRoute | null {
    const route = this.st.routes.get(id);
    if (!route || route.void) return route ?? null;
    Object.assign(route.signals, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
    this.st.touch('routes', id);
    const r = reward(route.signals);
    if (r === null) return this.#save(), route;
    const w = route.manual ? MANUAL_WEIGHT : 1;
    for (const type of [route.type, '*']) {
      const s = this.st.statOf(type, route.key, this.now());
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
    this.#endProbation(route.key);
    this.#save();
    return route;
  }

  /** Probation ends once a harness · model has a few outcomes of its own, at any level. */
  #endProbation(key: string): void {
    const base = baseOf(key);
    const arm = this.st.arms.get(base);
    if (arm?.state !== 'new') return;
    let n = 0;
    for (const [k, x] of this.st.stats) if (k.startsWith('*|') && baseOf(k.slice(2)) === base) n += x.n;
    if (n >= 3) {
      arm.state = 'ready';
      this.st.touch('arms', base);
    }
  }

  route(id: string): StoredRoute | null {
    return this.st.routes.get(id) ?? null;
  }

  /** Outcomes of your own tasks the router has learned from. */
  learned(): number {
    let n = 0;
    for (const r of this.st.routes.values()) if (r.r !== null) n++;
    return n;
  }

  /** A harness (or one model, at every level) hit a usage or rate limit: skip it until it resets. */
  cool(key: string, o: CoolArgs = {}): string {
    const target = o.scope === 'agent' ? `${splitKey(key).agent}:*` : baseOf(key);
    this.st.cooling.set(target, { until: this.now() + (o.ms ?? 10 * 60_000), why: String(o.why ?? '').slice(0, 160) });
    this.st.touch('cooling', target);
    this.#save();
    return target;
  }

  cooling(key: string): Cool | null {
    const c = this.st.cooling;
    const hit = c.get(key) ?? c.get(baseOf(key)) ?? c.get(baseOf(canon(key))) ?? c.get(`${splitKey(key).agent}:*`);
    return hit && hit.until > this.now() ? hit : null;
  }

  /** The run never got to work (the harness was at its limit): forget it ever counted. */
  void(id: string): void {
    const route = this.st.routes.get(id);
    if (!route) return;
    if (route.r !== null) {
      const w = route.manual ? MANUAL_WEIGHT : 1;
      for (const type of [route.type, '*']) {
        const sk = `${type}|${route.key}`;
        const s = this.st.stats.get(sk);
        if (!s) continue;
        s.a -= route.r * w;
        s.b -= (1 - route.r) * w;
        s.n = Math.max(0, s.n - 1);
        this.st.touch('stats', sk);
      }
    }
    route.r = null;
    route.void = true;
    this.st.touch('routes', id);
    this.#save();
  }

  /** Forget outcomes and your picks; the benchmarks stay, and your old launches aren't read again. */
  reset(): void {
    this.st.clearLearned();
    this.st.backfilled ||= this.now();
    this.st.dirty.meta = true;
    this.#save();
  }
}
