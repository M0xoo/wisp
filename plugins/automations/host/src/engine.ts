// The trigger loop (v1 server/triggers.js class Triggers): a 20 s tick fires schedules once per
// matching minute and polls the GitHub watchers when they're due; Run now, a hook's delivery and a
// task's events fire the rest. What a trigger fires goes, in order of preference, to the task already
// on that CI branch (a follow-up), to the crew member it names (crew.assign), or to a new task
// (runtime.create, its origin in the task's ext slot). Unattended work waits out Automations stop at
// (budget): held, the row says it skipped and why, and a reset releases it.

import type { Json, Log, ProcService } from '@wisp/kernel';
import { EXT, HOOK_KINDS, TASK_KINDS, cronMatches, parseCron } from '@wisp-plugin/automations-api';
import type { Held, Origin, PluginRecipe, Recipe } from '@wisp-plugin/automations-api';
import { COMMANDS as RT } from '@wisp-plugin/runtime-api';
import type { Session, StartArgs } from '@wisp-plugin/runtime-api';
import type { BudgetService, Hold } from '@wisp-plugin/budget-api';
import { HeldError } from './held.ts';
import { render } from './hooks.ts';
import { fill, findRecipe } from './recipes.ts';
import type { Repo } from './rows.ts';
import { taskFor, type TaskInfo } from './tasks.ts';
import type { Member, Trigger } from './types.ts';
import { PluginError, errorText, isObj } from './util.ts';
import { poll } from './watch.ts';

export const TICK_MS = 20_000;
const MAX_BRANCHES = 50; // the CI watcher's branch → task links it keeps

/** What the engine reaches: rows, the clock, gh, the budget, and other plugins' commands. */
export interface Deps {
  repo: Repo;
  now(): number;
  log: Log;
  proc: ProcService;
  budget(): BudgetService | undefined;
  /** a root call as this plugin */
  run<R>(cmd: string, args?: unknown): Promise<R>;
  /** the recipes a trigger may name: yours, then plugins' */
  recipes(): readonly (Recipe | PluginRecipe)[];
  /** a crew member by id, null when it isn't on the crew (or there's no crew) */
  member(id: string): Promise<Member | null>;
}

export type Started = Record<string, Json>;
export interface FireOptions {
  task?: TaskInfo | null;
  manual?: boolean;
  hook?: boolean;
}

export class Engine {
  readonly d: Deps;
  readonly busy = new Set<string>();
  constructor(d: Deps) {
    this.d = d;
  }

  async tick(): Promise<void> {
    const now = this.d.now();
    const minute = Math.floor(now / 60_000);
    for (const t of this.d.repo.list()) {
      if (!t.enabled || this.busy.has(t.id) || TASK_KINDS.has(t.kind) || HOOK_KINDS.has(t.kind)) continue;
      if (t.kind === 'schedule') {
        let due = false;
        try {
          due = t.lastMinute !== minute && cronMatches(parseCron(t.cron), new Date(now));
        } catch {
          continue; // a cron that no longer parses never fires
        }
        if (!due) continue;
        t.lastMinute = minute;
        await this.guard(t, () => this.fire(t, {}));
      } else if (now - (t.lastPolledAt || 0) >= t.every * 60_000) {
        await this.guard(t, () => poll(this, t));
      }
    }
  }

  /** Run now, from the UI: a schedule fires, a watcher polls (and fires for anything new). */
  async runNow(t: Trigger): Promise<Started[]> {
    if (TASK_KINDS.has(t.kind)) throw new PluginError('conflict', `This trigger starts when a task ${t.kind === 'done' ? 'is marked done' : 'finishes'}: there's nothing to run now.`);
    if (HOOK_KINDS.has(t.kind)) throw new PluginError('conflict', 'This trigger starts when its URL is called: there’s nothing to run now.');
    const out = await this.guard(t, async () => (t.kind === 'schedule' ? [await this.fire(t, {}, { manual: true })] : poll(this, t, { force: true, manual: true })), true);
    return out ?? [];
  }

  /** A delivery at a hook's URL: its task, null when held for the plan. */
  hook(t: Trigger, vars: Record<string, unknown>): Promise<Started | null> {
    return this.guard(t, () => this.fire(t, vars, { hook: true }), true);
  }

  async guard<R>(t: Trigger, fn: () => Promise<R>, rethrow = false): Promise<R | null> {
    this.busy.add(t.id);
    try {
      const r = await fn();
      t.lastError = '';
      return r;
    } catch (err) {
      if (err instanceof HeldError) {
        const h = err.held;
        t.held = { at: this.d.now(), why: String(h.why).slice(0, 300), agent: h.agent, ...(h.until !== undefined && { until: h.until }), ...(h.load && { load: true }) } satisfies Held;
        t.lastError = '';
        return null;
      }
      t.lastError = errorText(err).slice(0, 300);
      if (rethrow) throw err;
      return null;
    } finally {
      this.busy.delete(t.id);
      // the row may be gone (deleted while it ran): only a trigger still there is written back
      if (this.d.repo.triggers.get(t.id) === t) this.d.repo.saveTrigger(t);
    }
  }

  /** A window of this harness reset early: rows skipped for its plan stop saying so. */
  release(agent: string): number {
    const was = this.d.repo.list().filter((t) => t.held && t.held.agent === agent);
    for (const t of was) delete t.held;
    if (was.length) this.d.repo.saveTrigger(...was);
    return was.length;
  }

  async #hold(agent: string, account: string | undefined): Promise<void> {
    const h = await this.d.budget()?.hold(agent, account || 'default');
    if (h) throw new HeldError(h);
  }

  /** manual: Run now. Anything else is unattended and waits out Automations stop at (it's skipped). */
  async fire(t: Trigger, vars: Record<string, unknown>, o: FireOptions = {}): Promise<Started> {
    const recipe = t.recipeId ? findRecipe(this.d.recipes(), t.recipeId) : null;
    if (t.recipeId && !recipe) throw new Error('Its recipe was deleted.');
    const template = recipe ? recipe.prompt : t.prompt;
    // A hook's text comes from outside: its {{…}} are filled last, so a {name} in it stays as written.
    const prompt = (o.hook ? render(template, vars, t.params) : fill(template, { ...t.params, ...(vars as Record<string, Json>) }, { strict: false })).trim();
    if (!prompt) throw new Error('The prompt came out empty.');
    const branch = t.kind === 'ci' ? String(vars['branch'] ?? '') : '';
    const open = branch ? await taskFor(this, t, branch) : null;
    const origin: Origin = { kind: 'trigger', id: t.id, name: t.name };
    if (open) {
      if (!o.manual) await this.#hold(open.agent, open.account);
      await this.d.run(RT.followUp, { id: open.id, text: prompt, queue: true, by: 'trigger' });
      return this.#ran(t, branch, open.id, { id: open.id, title: open.title, followUp: true });
    }
    if (t.crew) return this.#assign(t, prompt, origin, branch, o);
    const agent = t.agent || recipe?.agent || '';
    if (!o.manual && agent) await this.#hold(agent, undefined);
    const args: StartArgs = {
      prompt,
      cwd: o.task?.cwd || t.cwd,
      ...(agent && { agent }),
      ...((t.model || recipe?.model) && { model: t.model || recipe?.model }),
      ...((t.effort || recipe?.effort) && { effort: t.effort || recipe?.effort }),
      ...((t.mode || recipe?.mode) && { mode: (t.mode || recipe?.mode) as StartArgs['mode'] & string }),
      ...(!o.manual && { by: 'trigger' }),
      ext: { [EXT]: { origin: { ...origin } } },
    };
    const { id } = await this.d.run<{ id: string }>(RT.create, args);
    return this.#ran(t, branch, id, await started(this, id, origin));
  }

  // A trigger that sends its work to a crew member: the member's job, or its place in the queue.
  async #assign(t: Trigger, prompt: string, origin: Origin, branch: string, o: FireOptions): Promise<Started> {
    const task = o.task;
    // A task watcher's job is about that task: the member may follow up on it.
    const about = task ? { job: 'event', event: t.kind, from: { id: task.id, title: task.title || 'Untitled' } } : { job: 'trigger', from: { id: t.id, title: t.name } };
    let out: Record<string, unknown>;
    try {
      out = await this.d.run<Record<string, unknown>>('crew.assign', { crewId: t.crew, prompt, ...about, origin, unattended: !o.manual, ext: { [EXT]: { origin } } });
    } catch (err) {
      const h = isObj(err) && isObj(err['details']) ? err['details']['held'] : undefined;
      if (isObj(h)) throw new HeldError(h as unknown as Hold);
      if (isObj(err) && err['code'] === 'not_found') throw new Error('The crew is not available.');
      throw err;
    }
    if (isObj(out['held'])) throw new HeldError(out['held'] as unknown as Hold);
    const s = isObj(out['session']) ? out['session'] : null;
    const result: Started = s ? { ...(s as Started), origin: { ...origin } } : { queued: (out['queued'] as Json) ?? true, crew: t.crew };
    return this.#ran(t, branch, typeof s?.['id'] === 'string' ? s['id'] : null, result);
  }

  #ran(t: Trigger, branch: string, id: string | null, out: Started): Started {
    delete t.held;
    t.lastRunAt = this.d.now();
    t.lastSessionId = id || t.lastSessionId;
    t.runs = (t.runs || 0) + 1;
    if (branch && id) t.tasks = Object.fromEntries([[branch, id], ...Object.entries(t.tasks || {}).filter(([b]) => b !== branch)].slice(0, MAX_BRANCHES));
    return out;
  }
}

/** What a started task looks like in the answer (v1 sent the session's summary). */
export async function started(e: Engine, id: string, origin: Origin): Promise<Started> {
  try {
    const s = await e.d.run<Session>(RT.get, { id });
    return { id, title: s.title, agent: s.agent, model: s.model, effort: s.effort, mode: s.mode, cwd: s.cwd, state: s.state, origin: { ...origin } };
  } catch {
    return { id, origin: { ...origin } };
  }
}
