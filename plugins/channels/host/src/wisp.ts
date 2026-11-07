// What wisp.channels asks of other plugins, in one place: every command id it runs that isn't its own,
// and how it reads another plugin's slot of a session. Runtime's ids come from its api; the rest are
// the owners' (crew, machines, router, workspace, terminal, telemetry, mcp, settings), named here as
// the port brief has them until each owner's api exports a constant (listed in the channels report).

import type { CallContext, Caller, Json, PluginContext } from '@wisp/kernel';
import { COMMANDS as RUNTIME, type Session, type Turn } from '@wisp-plugin/runtime-api';
import type { AgentView, AskView, MachineView, MemberView, ProjectView, SessionView, TurnView } from '@wisp-plugin/channels-api';

export { RUNTIME };

export const OTHERS = {
  projects: 'workspace.projects', // {} → ProjectView[]   (v1 config.projects)
  agents: 'router.agents', // {} → AgentView[]   (v1 app.auto.agents(): what's installed here)
  goals: 'router.goals', // {} → string[]   (v1 Object.keys(GOALS))
  crewList: 'crew.list', // {} → MemberView[] with running/queue (v1 crew.list + crew.view)
  crewAssign: 'crew.assign', // { member, prompt, job, origin, tagged, run?, thread } → { queued? | session? }
  crewAsk: 'crew.ask', // { member, sessionId, text, tagged, thread, shown, run? } → { queued? }
  crewChanged: 'crew.threadSaved', // {} → {}   (a queued job's thread got its first reply)
  machines: 'machines.list', // {} → MachineView[] (+ sandbox flag)
  machineRequest: 'machines.request', // { machine, method, path, body? } → Json   (v1 machines.json)
  sandbox: 'machines.sandbox.available', // {} → boolean
  gridOn: 'machines.computer.on', // {} → boolean   (v1 app.computer.view().on)
  gridReply: 'machines.computer.reply', // { thread, text } → Json
  terminalOpen: 'terminal.openFor', // { sessionId } → { open: boolean }   (v1 terms.get(id).code === null)
  telemetry: 'telemetry.track', // { event, props } → {}
  answer: 'mcp.ask.answer', // { sessionId, askId, answer } → {}
  settingsSet: 'settings.set', // { key, value } → {}   (the edge's settings plugin)
} as const;

/** Events channels listens to that aren't runtime's. */
export const OTHER_EVENTS = {
  askOpened: 'ask.opened', // wisp.mcp: { sessionId, ask }
  machineFinished: 'machines.session.finished', // wisp.machines: { session: Summary of `<id>@<machine>` }
  btwDone: 'btw.finished', // wisp.runtime (btw.js): { sessionId, btw: { id, status, answer?, error? } }
} as const;

/** The user's defaults v1 kept in config.defaults, as runtime's settings. */
export const DEFAULTS = { agent: 'runtime.agent', model: 'runtime.model', models: 'runtime.models', mode: 'runtime.mode' } as const;

export type Runner = Pick<PluginContext, 'run'> | CallContext;

/** A command that may not be there yet (another plugin off, or not built): its fallback instead. */
export async function tryRun<R>(ctx: Pick<PluginContext, 'run'>, cmd: string, args: unknown, fallback: R, caller?: Caller): Promise<R> {
  try {
    return await ctx.run<R>(cmd, args, caller ? { caller } : undefined);
  } catch {
    return fallback;
  }
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** runtime's Turn → what a channel reads of it. */
export function turnView(t: Turn): TurnView {
  const btw = rec(t.ext)['wisp.btw'];
  return {
    id: t.id,
    status: t.status,
    model: t.model,
    stats: (t.stats as TurnView['stats']) ?? null,
    presentation: t.presentation ? { blocks: t.presentation.blocks } : null,
    ...(Array.isArray(btw) && { btw: btw as TurnView['btw'] }),
  };
}

/**
 * runtime's Session (+ its last turns) → v1's session JSON, the part channels read. Other plugins'
 * slots: wisp.mcp's open ask (state 'waiting'), wisp.crew's job, wisp.later's kind, runtime's side
 * discussion, and channels' own cap.
 */
export function sessionView(s: Session, turns: readonly Turn[]): SessionView {
  const ext = rec(s.ext);
  const ask = (rec(ext['wisp.mcp'])['ask'] as AskView | undefined) ?? null;
  const own = rec(ext['wisp.channels']);
  const crew = rec(ext['wisp.crew']);
  const side = rec(ext['wisp.side'])['of'];
  return {
    id: s.id,
    title: s.title,
    state: ask ? 'waiting' : s.state,
    agent: s.agent,
    model: s.model,
    effort: s.effort,
    mode: s.mode,
    cwd: s.cwd,
    ...(s.parentId && { parentId: s.parentId }),
    ...(typeof side === 'string' && { sideOf: { id: side } }),
    ...(Object.keys(crew).length && { crew: crew as SessionView['crew'] }),
    ...(typeof rec(ext['wisp.later'])['kind'] === 'string' && { kind: String(rec(ext['wisp.later'])['kind']) }),
    capped: (own['capped'] as SessionView['capped']) ?? null,
    ask,
    queue: s.queue,
    ...(s.queueHeld && { queueHeld: true }),
    ...(own['delegated'] === true && { delegated: true }),
    turns: turns.map(turnView),
  };
}

export const asProjects = (v: unknown): ProjectView[] => (Array.isArray(v) ? (v as ProjectView[]) : []);
export const asAgents = (v: unknown): AgentView[] => (Array.isArray(v) ? (v as AgentView[]) : []);
export const asMachines = (v: unknown): (MachineView & { sandbox?: boolean })[] => (Array.isArray(v) ? (v as MachineView[]) : []);
export const asMembers = (v: unknown): MemberView[] => (Array.isArray(v) ? (v as MemberView[]) : []);
export const asJson = (v: unknown): Json => (v === undefined ? null : (v as Json));
