// wisp.later: follow-ups, reminders and tasks at a time you or an agent set (v1 server/later.js,
// design/later.md). Entries and plans are rows; the task's view of them is its ext slot.
import { LIMIT_CARRY_ON, laterNote, PLUGIN_ID } from '@wisp-plugin/later-api';
import type { LaterExt, SentMeta } from '@wisp-plugin/later-api';
import { EVENTS as RT_EVENTS, HOOKS, POINTS } from '@wisp-plugin/runtime-api';
import type { FollowUpArgs, PromptPart, Session, SummaryField, Turn } from '@wisp-plugin/runtime-api';
import type { CallContext, EventEnvelope, PluginContext, PluginDef, Verdict } from '@wisp/kernel';
import type { Store } from '@wisp/store';
import { agentSchedule } from './agent.ts';
import type { ScheduleArgs } from './agent.ts';
import { BUDGET_RESET } from './peers.ts';
import type { BudgetReset } from './peers.ts';
import { Plans } from './plans.ts';
import type { PlanArgs } from './plans.ts';
import { registerRoutes } from './routes.ts';
import { openRows } from './rows.ts';
import { Scheduler } from './scheduler.ts';
import { Rt } from './rt.ts';
import { Tasks } from './tasks.ts';
import type { AddArgs, EditBody } from './tasks.ts';

export { openapi } from './openapi.ts';

// @wisp/kernel doesn't export definePlugin yet: the identity it will be
const definePlugin = <T extends PluginDef>(d: T): T => d;

type Args = Record<string, unknown>;
const sid = (a: Args): string => String(a['sessionId'] ?? '');
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const extOf = (s: Session): LaterExt | undefined => (isObj(s.ext[PLUGIN_ID]) ? (s.ext[PLUGIN_ID] as unknown as LaterExt) : undefined);

interface Parts {
  tasks: Tasks;
  plans: Plans;
  sched: Scheduler;
}

function taskCommands(ctx: PluginContext, { tasks, sched }: Parts): void {
  ctx.command<Args, unknown>({ id: 'later.add', run: (a, call) => tasks.add(call, a as unknown as AddArgs) });
  ctx.command<Args, unknown>({ id: 'later.edit', run: (a, call) => tasks.edit(call, sid(a), String(a['item'] ?? ''), a as EditBody) });
  ctx.command<Args, unknown>({ id: 'later.cancel', run: (a, call) => tasks.cancel(call, sid(a), { item: String(a['item'] ?? ''), goalRound: a['goalRound'] === true }) });
  ctx.command<Args, unknown>({ id: 'later.done', run: async (a, call) => (await tasks.done(call, sid(a)), {}) });
  ctx.command<Args, unknown>({ id: 'later.park', run: (a, call) => tasks.park(call, sid(a), { forLater: a['forLater'], state: a['state'], ...(typeof a['by'] === 'string' && { by: a['by'] }) }) });
  ctx.command<Args, unknown>({ id: 'later.list', readOnly: true, run: (a) => tasks.rows.entries(sid(a)) });
  ctx.command<Args, unknown>({ id: 'later.waitAtLimit', run: (a, call) => waitAtLimit(ctx, tasks, call, sid(a), Number(a['at'])) });
  ctx.command<Args, unknown>({ id: 'later.nextAt', readOnly: true, run: () => ({ at: sched.nextAt() }) });
  ctx.command<Args, unknown>({ id: 'later.tick', run: async () => ({ fired: await sched.tick() }) });
  ctx.command<Args, unknown>({ id: 'later.agent.schedule', run: (a, call) => agentSchedule(tasks, call, a as ScheduleArgs) });
}

function planCommands(ctx: PluginContext, { plans }: Parts): void {
  ctx.command<Args, unknown>({ id: 'later.plans', readOnly: true, run: () => plans.list() });
  ctx.command<Args, unknown>({ id: 'later.getPlan', readOnly: true, run: (a) => plans.get(String(a['id'] ?? '')) });
  ctx.command<Args, unknown>({ id: 'later.plan', run: (a, call) => plans.plan(call, a as PlanArgs) });
  ctx.command<Args, unknown>({ id: 'later.editPlan', run: (a, call) => plans.editPlan(call, String(a['id'] ?? ''), a) });
  ctx.command<Args, unknown>({ id: 'later.cancelPlan', run: (a) => ({ ok: plans.cancelPlan(String(a['id'] ?? '')) }) });
}

/**
 * At a usage limit with Settings → Wait for the reset on: the task carries on in the same conversation
 * once the window resets (v1 runner.waitAtLimit). null: it asks you (the limit card) as before.
 */
async function waitAtLimit(ctx: PluginContext, tasks: Tasks, call: CallContext, sessionId: string, at: number): Promise<unknown> {
  if (ctx.settings.get<string>('limitWait') !== 'on') return null;
  const rt = new Rt(call);
  const s = await rt.get(sessionId);
  if (!s) return null;
  const agent = (await rt.last(s.id).catch(() => undefined))?.agent || s.agent;
  const when = Math.max(Number.isFinite(at) ? at : 0, ctx.clock.now() + 61_000);
  // a subagent, five already waiting, ten in a row: the card asks instead
  return tasks.addTo(call, s, { sessionId: s.id, text: LIMIT_CARRY_ON, by: 'wisp', at: when, limit: { agent, account: s.account || 'default' } }).catch(() => null);
}

function listen(ctx: PluginContext, { tasks, plans, sched }: Parts): void {
  const warn = (e: unknown): void => ctx.log.warn(`later: ${(e as Error).message}`);
  ctx.on<{ sessionId: string; turnId: string }>(RT_EVENTS.started, (e) => tasks.turnStarted(ctx, e.data.sessionId, e.data.turnId).catch(warn));
  // a task that was busy when its follow-up came due: it goes as soon as the turn lands
  ctx.on<{ sessionId: string }>(RT_EVENTS.finished, (e) => {
    if (tasks.rows.entries(e.data.sessionId).some((l) => l.at <= ctx.clock.now())) void sched.tick().catch(warn);
  });
  ctx.on<{ id: string }>(RT_EVENTS.changed, (e: EventEnvelope<{ id: string }>) => {
    if (tasks.rows.waitingOn(e.data.id).length) void plans.taskDone(ctx, e.data.id).catch(warn);
  });
  ctx.on<{ id: string }>(RT_EVENTS.deleted, (e) => {
    tasks.rows.forget(e.data.id);
    if (tasks.rows.waitingOn(e.data.id).length) plans.lost(e.data.id, 'deleted');
  });
  ctx.on<BudgetReset>(BUDGET_RESET, (e) => void sched.pullForward(e.data.agent, e.data.account || 'default').catch(warn));
}

function contribute(ctx: PluginContext): void {
  ctx.contribute<SummaryField>(POINTS.summary, {
    plugin: PLUGIN_ID,
    fields: (s) => {
      const x = extOf(s);
      if (!x) return {};
      return { ...(x.later && { later: x.later }), ...(x.forLater && { forLater: x.forLater }), ...(x.reminder && { reminder: x.reminder }), ...(x.kind && { kind: x.kind }), ...(x.origin && { origin: x.origin }) };
    },
  });
  // the note the agent reads ahead of a follow-up it (or you) scheduled; the bubble shows only the text
  ctx.contribute<PromptPart>(POINTS.prompt, {
    id: 'later.note',
    part: () => '',
    prefix: (s: Session, turn: Turn) => {
      if (turn.by !== 'later') return '';
      const meta = (isObj(turn.ext[PLUGIN_ID]) ? turn.ext[PLUGIN_ID] : extOf(s)?.sent) as SentMeta | undefined;
      return meta ? laterNote(meta, ctx.clock.now()) : '';
    },
  });
  // a reminder of its own has no agent to talk to
  ctx.intercept<FollowUpArgs>({
    hook: HOOKS.beforeFollowUp,
    run: async (a, call): Promise<Verdict<FollowUpArgs>> => {
      const s = await new Rt(call).get(a.id).catch(() => undefined);
      return s && extOf(s)?.kind === 'reminder' ? { kind: 'veto', code: 'conflict', message: 'A reminder has no agent to follow up with. Start a new task instead.' } : { kind: 'continue' };
    },
  });
}

export default definePlugin({
  id: PLUGIN_ID,
  setup(ctx: PluginContext) {
    const rows = openRows(ctx.service<Store>('store'));
    const parts = {} as Parts;
    const changed = (): void => parts.sched?.arm();
    parts.tasks = new Tasks(ctx, rows, changed);
    parts.plans = new Plans(ctx, rows, changed);
    parts.sched = new Scheduler(ctx, rows, parts.tasks, parts.plans);
    ctx.scope.add(() => parts.sched.dispose());
    taskCommands(ctx, parts);
    planCommands(ctx, parts);
    listen(ctx, parts);
    contribute(ctx);
    registerRoutes(ctx);
    // the first look: what came due while wisp was off goes once (late), then the timer takes over
    ctx.scope.timeout(0, () => void parts.sched.tick().catch((e: unknown) => ctx.log.warn(`later: ${(e as Error).message}`)));
  },
});
