// When things go (v1 later.js tick/pullForward/nextAt). v1 looked every 20 s; here ONE scope timer is
// armed for the soonest due time in the rows (later_entry.at, later_plan.at, both indexed) and re-armed
// whenever an entry or plan changes. Idle, wisp.later wakes nothing at all (a laptop sleeps, a grid box
// stays asleep) and a follow-up goes on its minute, not up to 20 s late. The 20 s look is kept only as a
// retry while something due is waiting on a busy task or the per-look cap. After a restart, what came due
// while wisp was off fires once (marked late), or a day late lands in Needs you instead.
import { clock, MIN_MS, MISSED_MS } from '@wisp-plugin/later-api';
import type { LaterEntry } from '@wisp-plugin/later-api';
import type { Session } from '@wisp-plugin/runtime-api';
import type { PluginContext, Scope } from '@wisp/kernel';
import { budgetService } from './peers.ts';
import type { Hold } from './peers.ts';
import type { Plans } from './plans.ts';
import type { Rows } from './rows.ts';
import { Rt } from './rt.ts';
import { free } from './tasks.ts';
import type { Tasks } from './tasks.ts';

export const PER_TICK = 3; // a restart with a backlog doesn't start a dozen runs at once
export const TICK_MS = 20_000;

export class Scheduler {
  readonly #ctx: PluginContext;
  readonly #rows: Rows;
  readonly #tasks: Tasks;
  readonly #plans: Plans;
  #timer: Scope | undefined;
  #armedAt = Infinity;
  #ticking: Promise<number> | undefined;
  #again = false;

  constructor(ctx: PluginContext, rows: Rows, tasks: Tasks, plans: Plans) {
    this.#ctx = ctx;
    this.#rows = rows;
    this.#tasks = tasks;
    this.#plans = plans;
  }

  /** The soonest thing that will run (GET /api/status nextWakeAt): never in the past, or a host would never let an idle wisp stop. */
  nextAt(): number | null {
    const ats = [this.#rows.nextEntryAt(), this.#rows.nextPlanAt()].filter((x): x is number => x !== undefined);
    if (!ats.length) return null;
    return Math.max(Math.min(...ats), this.#ctx.clock.now() + MIN_MS);
  }

  /**
   * Arms the one timer for the soonest due time, or `retry` ms from now when that is sooner. What is
   * already due and still there was held back (a busy task, the cap): the next look is a retry away,
   * never at once, or a busy task would spin the timer.
   */
  arm(retry?: number): void {
    if (!this.#ctx.scope.alive) return;
    const now = this.#ctx.clock.now();
    const next = [this.#rows.nextEntryAt(), this.#rows.nextPlanAt()].filter((x): x is number => x !== undefined);
    const soonest = next.length ? Math.min(...next) : Infinity;
    const at = Math.min(soonest > now ? soonest : now + TICK_MS, retry === undefined ? Infinity : now + retry);
    if (at === this.#armedAt && this.#timer?.alive) return;
    this.#timer?.dispose();
    this.#timer = undefined;
    this.#armedAt = at;
    if (at === Infinity) return;
    const t = this.#ctx.scope.child('later.timer');
    this.#timer = t;
    t.timeout(Math.max(0, at - now), () => {
      this.#armedAt = Infinity;
      void this.tick().catch((e: unknown) => this.#ctx.log.warn(`later: ${(e as Error).message}`));
    });
  }

  /** Looks now. One look at a time: a change during one makes another follow it. → how many went */
  tick(): Promise<number> {
    if (this.#ticking) {
      this.#again = true;
      return this.#ticking;
    }
    const run = async (): Promise<number> => {
      let n = 0;
      do {
        this.#again = false;
        n += await this.#look();
      } while (this.#again);
      return n;
    };
    this.#ticking = run().finally(() => (this.#ticking = undefined));
    return this.#ticking;
  }

  async #look(): Promise<number> {
    const now = this.#ctx.clock.now();
    const st = { fired: 0, retry: false };
    const room = (): boolean => (st.fired < PER_TICK ? (st.fired++, true) : ((st.retry = true), false));
    for (const p of this.#rows.duePlans(now)) {
      if (!room()) break;
      const go = p.kind === 'task' && now - (p.at ?? now) > MISSED_MS ? this.#plans.missed(this.#ctx, p) : this.#plans.run(this.#ctx, p);
      await go.catch((e: unknown) => this.#ctx.log.warn(`later: ${(e as Error).message}`));
    }
    // waiting for a task: done while this missed it starts it; gone or put away, it waits in Drafts
    for (const id of new Set(this.#rows.waitingOn().flatMap((p) => (p.after ? [p.after.id] : [])))) {
      if (st.fired < PER_TICK) st.fired += await this.#plans.taskDone(this.#ctx, id);
    }
    const bySession = new Map<string, LaterEntry[]>();
    for (const l of this.#rows.due(now)) bySession.set(l.sessionId, [...(bySession.get(l.sessionId) ?? []), l]);
    for (const [id, due] of bySession) {
      if (st.fired >= PER_TICK) {
        st.retry = true;
        break;
      }
      await this.#session(id, due, now, room, st).catch((e: unknown) => this.#ctx.log.warn(`later: ${id}: ${(e as Error).message}`));
    }
    this.arm(st.retry ? TICK_MS : undefined);
    return st.fired;
  }

  async #session(id: string, due: LaterEntry[], now: number, room: () => boolean, st: { retry: boolean }): Promise<void> {
    const rt = new Rt(this.#ctx);
    const s = await rt.get(id);
    if (!s) return this.#rows.forget(id);
    // archived: you put it away, so what it had scheduled lapses
    if (s.archived) {
      this.#rows.dropEntries(due.map((l) => l.id));
      return this.#tasks.mirror(this.#ctx, id);
    }
    // not sent by you, and its account is past Automations stop at: it waits for the reset, and the
    // next one due (yours, say) goes instead
    let i = 0;
    for (let h: Hold | null; i < due.length; i++) {
      const l = due[i];
      if (!l || l.remind || l.by === 'user' || !free(s) || !(h = await this.#hold(s))) break;
      await this.#tasks.waitForPlan(this.#ctx, l, h);
    }
    const l = due[i];
    if (!l) return;
    if (!l.remind && !free(s)) {
      st.retry = true; // busy: tries again on the next look
      return;
    }
    if (!room()) return;
    if (!l.remind && now - l.at > MISSED_MS) {
      await this.#tasks.missed(this.#ctx, s, l, clock(l.at, now));
      return;
    }
    await this.#tasks.fire(this.#ctx, s, l);
  }

  /** What holds back automations on the task's account (wisp.budget, when it's there). */
  async #hold(s: Session): Promise<Hold | null> {
    const budget = this.#ctx.tryUse(budgetService);
    return budget ? await budget.hold(s.agent, s.account ?? 'default') : null;
  }

  /**
   * A window of agent's account reset early (budget.reset): what waits on that plan comes due now (a
   * follow-up moved by Automations stop at, one waiting at a limit), and the next look sends it after
   * checking again (the weekly window can still hold after the 5-hour one reset). → how many tasks.
   */
  async pullForward(agent: string, account: string): Promise<number> {
    const budget = this.#ctx.tryUse(budgetService);
    if (budget && ((await budget.hold(agent, account)) || (await budget.resetAt(agent, account)))) return 0;
    const now = this.#ctx.clock.now();
    const rt = new Rt(this.#ctx);
    const moved = new Set<string>();
    const sessions = new Map<string, Session | undefined>();
    for (const l of this.#rows.waiting(now)) {
      if (!sessions.has(l.sessionId)) sessions.set(l.sessionId, await rt.get(l.sessionId));
      const s = sessions.get(l.sessionId);
      if (!s || s.archived) continue;
      const mine = s.agent === agent && (s.account || 'default') === account;
      const waits = (l.held && mine) || (l.limit?.agent === agent && (l.limit.account || 'default') === account);
      if (!waits) continue;
      const { held: _held, ...rest } = l;
      this.#rows.putEntry({ ...rest, at: now });
      moved.add(l.sessionId);
    }
    for (const id of moved) await this.#tasks.mirror(this.#ctx, id);
    if (moved.size) await this.tick();
    return moved.size;
  }

  dispose(): void {
    this.#timer?.dispose();
    this.#timer = undefined;
  }
}
