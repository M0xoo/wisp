// Auto wired to the rest of wisp (v1 server/services/auto.js): which harnesses are installed here,
// Settings → Auto, what a launch with agent 'auto' runs, the preview, and the outcome signals that
// come back from a task's list row.

import { armKey, autoSettings, classify, GOALS, isGoal, routerOpts } from '@wisp-plugin/router-api';
import type { AgentInfo, ChooseArgs, DecideArgs, Decision, Goal, Pick, PreviewArgs, PreviewResult, SummaryLike } from '@wisp-plugin/router-api';
import type { Router, PastLaunch } from './router.ts';
import { PluginError } from './errors.ts';

export interface AutoDeps {
  router: Router;
  /** looks at every harness (fresh: forget earlier answers, or one harness's) */
  list(o: { fresh?: boolean | string }): Promise<AgentInfo[]>;
  /** Settings → Auto (v1 config.defaults.router) */
  setting(): unknown;
  /** v1 config.defaults.models: `auto` is the goal */
  models(): unknown;
  /** new harnesses or models showed up */
  onAdded(added: { key: string; label: string; state: string }[]): void;
  /** a detection in the background changed what the launcher shows */
  onAgents(): void;
  /** your launches from before Auto learned taste (read once, at the first look) */
  past(): Promise<PastLaunch[]>;
  warn(msg: string): void;
}

export type Auto = ReturnType<typeof createAuto>;

/** The place a launch runs: this computer (name '') or a machine. */
export interface Place {
  name: string;
  agents: AgentInfo[];
}

export function createAuto(d: AutoDeps) {
  const { router } = d;
  let here: AgentInfo[] = [];
  let detecting = 0;
  let answered = 0; // the newest detection that has finished
  let unsynced = false;
  let backfilled = false;

  const opts = (): ReturnType<typeof routerOpts> => routerOpts(d.setting());
  /**
   * The allowed harnesses narrow Auto's pick wherever one of them can run. A place that has none of
   * them (a machine with other harnesses signed in) gets what it has: the list is set from this
   * computer's harnesses and shouldn't make Auto refuse to run anywhere else.
   */
  const allowedAt = (agents: readonly AgentInfo[]): string[] | null => {
    const { allowed } = opts();
    return allowed && agents.some((a) => a.available && allowed.includes(a.id)) ? allowed : null;
  };
  const goalOf = (model?: string): Goal => {
    if (isGoal(model)) return model;
    const m = d.models();
    const set = typeof m === 'object' && m !== null && !Array.isArray(m) ? (m as Record<string, unknown>)['auto'] : undefined;
    return isGoal(set) ? set : 'balanced';
  };
  // Every pick reads Settings → Auto: launches, the pipeline's hand-overs, subagents.
  router.prefs = (): Partial<ChooseArgs> => {
    const { explore, blocked, prefer, habits } = opts();
    return { explore, blocked, prefer, habits, allowed: allowedAt(here) };
  };

  /** The arms catch up with the last detection (outside any interceptor: it writes). */
  const settle = (): void => {
    if (!unsynced) return;
    unsynced = false;
    const added = router.sync(here);
    if (added.length) d.onAdded(added);
  };

  const backfill = async (): Promise<void> => {
    try {
      router.backfill(await d.past());
    } catch (e) {
      d.warn(`router backfill: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /**
   * An older detection still running (with what it read before a sign-in) doesn't overwrite a newer
   * answer when it finishes. Newer ones that are only running don't count: every look at the list
   * starts one, and looks faster than a detection would throw away every answer.
   * `write: false` (inside an interceptor): the arms catch up later, in `settle`.
   */
  const detect = async (o: { fresh?: boolean | string; write?: boolean } = {}): Promise<AgentInfo[]> => {
    const n = ++detecting;
    const agents = await d.list(o.fresh === undefined ? {} : { fresh: o.fresh });
    if (n < answered) return here.length ? here : agents;
    answered = n;
    here = agents;
    unsynced = true;
    if (o.write === false) return agents;
    if (!backfilled) (backfilled = true), void backfill();
    settle();
    return agents;
  };
  const agents = async (o: { write?: boolean } = {}): Promise<AgentInfo[]> => (here.length ? here : await detect(o));
  /** The last detection right away, checked again in the background; onAgents if that changed anything. */
  const listed = async (): Promise<AgentInfo[]> => {
    if (!here.length) return detect();
    const before = JSON.stringify(here);
    detect().then((now) => JSON.stringify(now) !== before && d.onAgents(), () => undefined);
    return here;
  };

  /** agent 'auto' → a harness, model and thinking level picked from `place`'s harnesses. */
  const resolve = (a: DecideArgs, place: Place, o: { preview: boolean; seed?: number }): Pick => {
    const pick = router.choose({
      prompt: a.prompt, attachments: a.attachments?.length ?? 0, agents: place.agents, goal: goalOf(a.model), important: !!a.important,
      exclude: a.exclude ?? [], needDelegate: !!a.team, allowed: allowedAt(place.agents), pin: a.pin ?? null, preview: o.preview, ...(o.seed !== undefined && { seed: o.seed }),
    });
    if (!pick) throw new PluginError('unavailable', place.name ? `Auto found no harness installed and signed in on ${place.name}. Sign in to one there (Run with → pick it).` : 'Auto found no installed harness to run this on.');
    return pick;
  };

  const decision = (p: Pick): Decision => {
    const r = p.route;
    return { agent: p.agent, model: p.model, effort: p.effort, key: p.key, label: p.label, goal: r.goal, type: r.type, size: r.size, chance: r.chance, usd: r.usd, minutes: r.minutes, tier: r.tier, why: r.why, alternatives: r.alternatives, suggest: r.suggest ?? null, route: r };
  };

  /** What Auto would run for this prompt before you send it: the same pick every time (no dice). */
  const preview = (b: PreviewArgs, place: Place): PreviewResult => {
    const pick = router.choose({ prompt: b.prompt ?? '', attachments: b.attachments ?? 0, agents: place.agents, goal: goalOf(b.goal), needDelegate: !!b.team, allowed: allowedAt(place.agents), preview: true });
    if (!pick) return { pick: null, why: place.name ? `Nothing Auto may use is signed in on ${place.name}` : 'Nothing Auto may use can run right now' };
    const { route: _route, agent, model, effort, key, label, ...rest } = decision(pick);
    return { pick: { agent, model, effort, key, label }, ...rest };
  };

  /** A launch you picked yourself after Auto's preview showed something else. */
  const overrode = (o: { key: string; type?: string } | undefined, chosen: { agent: string; model?: string; effort?: string }, prompt: string): void => {
    if (!o || typeof o.key !== 'string' || !chosen.agent || chosen.agent === 'auto') return;
    router.override({ type: typeof o.type === 'string' ? o.type : classify(prompt).type, auto: o.key, chose: armKey(chosen.agent, chosen.model ?? '', chosen.effort ?? ''), prompt });
  };

  /**
   * A routed session's outcome so far, from its list row (here or on a machine). Follow-ups after the
   * first turn count as corrections; a merged or closed PR settles it, unless the user moved the task
   * to another harness or model first.
   */
  const signals = (sum: SummaryLike): void => {
    if (!sum.id || !router.route(sum.id) || sum.status === 'running' || sum.state === 'running') return;
    const pr = sum.pr?.state;
    const hero = sum.status === 'done' || sum.status === 'partial' || sum.status === 'blocked' || sum.status === 'info' ? sum.status : undefined;
    router.signal(sum.id, {
      ...(hero && { hero }),
      followups: sum.followups ?? Math.max(0, (sum.turnCount || 1) - 1),
      ...(pr === 'MERGED' && { merged: true }),
      ...(pr === 'CLOSED' && { closed: true }),
      ...(sum.route?.switched && { switched: true }),
    });
    // Moved to another harness or model in a follow-up: that one is what you wanted, once.
    const route = router.route(sum.id);
    if (route && sum.route?.switched && !route.manual && !route.signals.switchedTo && sum.agent && sum.agent !== 'auto') {
      router.observe({ agent: sum.agent, model: sum.model ?? '', effort: sum.effort ?? '', type: route.type, weight: 2 });
      router.signal(sum.id, { switchedTo: armKey(sum.agent, sum.model ?? '', sum.effort ?? '') });
    }
  };

  const settings = (): Record<string, unknown> & ReturnType<typeof routerOpts> & ReturnType<typeof autoSettings> => ({ ...opts(), ...autoSettings(d.setting()) });

  return { detect, agents, listed, here: (): AgentInfo[] => here, settle, opts, allowedAt, goalOf, signals, resolve, decision, preview, overrode, settings, goals: GOALS };
}
