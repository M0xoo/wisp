// What a tap or a reply can do to one task, here or on another machine (v1 phone.js sessionOps). A
// task here is runtime's (and wisp.mcp's for its ask); one on a machine is `<id>@<machine>`, reached
// through wisp.machines. On a grid box a message never reaches another machine (NO_MACHINE).

import type { Json, PluginContext } from '@wisp/kernel';
import type { Session, Turn } from '@wisp-plugin/runtime-api';
import type { BoxApi, SessionView } from '@wisp-plugin/channels-api';
import { bad } from '@wisp-plugin/channels-api/kit';
import { OTHERS, RUNTIME, sessionView } from './wisp.ts';

export const NO_MACHINE = 'A cloud computer doesn’t reach other machines from a channel. Start that in wisp.';

/** `<id>@<machine>` → its parts; null for a task here (v1 machines.js splitId). */
export function splitId(id: string): { id: string; machine: string } | null {
  const i = String(id || '').lastIndexOf('@');
  return i > 0 ? { id: id.slice(0, i), machine: id.slice(i + 1) } : null;
}

/** What a follow-up became, as runtime (or a machine's v1 route) says it. */
export interface ReplyResult {
  answered?: boolean;
  interrupted?: boolean;
  queued?: number | boolean;
  btw?: { id: string };
  [k: string]: unknown;
}

export interface Ops {
  s: SessionView;
  answer(a: string): Promise<unknown>;
  reply(text: string, o?: { mode?: string; run?: Record<string, string> }): Promise<ReplyResult>;
  done(): Promise<boolean>;
  stop(): Promise<unknown>;
}

const TURNS = 3; // the last turn is what a channel reads; a /btw answer may sit one or two back

export async function localSession(ctx: Pick<PluginContext, 'run'>, id: string): Promise<SessionView | null> {
  const s = await ctx.run<Session | null>(RUNTIME.get, { id }).catch((err: unknown) => {
    if ((err as { code?: string })?.code === 'not_found') return null;
    throw err;
  });
  if (!s) return null;
  const turns = await ctx.run<Turn[]>(RUNTIME.turns, { id, limit: TURNS }).catch(() => []);
  return sessionView(s, turns);
}

function localOps(ctx: Pick<PluginContext, 'run'>, s: SessionView): Ops {
  return {
    s,
    answer: (a) => ctx.run(OTHERS.answer, { sessionId: s.id, askId: s.ask?.id ?? '', answer: a }),
    reply: (text, o = {}) => ctx.run<ReplyResult>(RUNTIME.followUp, { id: s.id, text, by: 'channel', ...(o.mode && { mode: o.mode }), ...(o.run && { run: o.run }) }),
    done: async () => {
      if (s.state === 'running' || s.state === 'waiting') return false;
      await ctx.run(RUNTIME.setState, { id: s.id, state: 'done' });
      return true;
    },
    stop: () => ctx.run(RUNTIME.stop, { id: s.id, keepQueue: true }),
  };
}

function machineOps(ctx: Pick<PluginContext, 'run'>, at: { id: string; machine: string }, s: SessionView): Ops {
  const call = (method: string, p: string, body?: Json): Promise<unknown> => ctx.run(OTHERS.machineRequest, { machine: at.machine, method, path: `/sessions/${at.id}${p}`, ...(body !== undefined && { body }) });
  const live = s.state === 'running' || s.state === 'waiting';
  return {
    s,
    answer: (a) => call('POST', '/answer', { text: a }),
    reply: async (t, o = {}) => (await call('POST', '/reply', { text: t, ...(o.mode && { mode: o.mode }), ...o.run })) as ReplyResult,
    done: async () => !live && !!(await call('PATCH', '', { state: 'done' })),
    stop: () => call('POST', '/stop'),
  };
}

/** The task on a machine as v1's GET /sessions/:id returns it, with its id kept as `<id>@<machine>`. */
async function machineSession(ctx: Pick<PluginContext, 'run'>, at: { id: string; machine: string }): Promise<SessionView | null> {
  const s = await ctx.run<SessionView | null>(OTHERS.machineRequest, { machine: at.machine, method: 'GET', path: `/sessions/${at.id}` }).catch((err: unknown) => {
    if ((err as { status?: number; code?: string })?.status === 404 || (err as { code?: string })?.code === 'not_found') return null;
    throw err;
  });
  return s ? { ...s, id: `${at.id}@${at.machine}`, turns: s.turns ?? [] } : null;
}

export async function sessionOps(ctx: Pick<PluginContext, 'run'>, box: BoxApi, sessionId: string): Promise<Ops | null> {
  const at = splitId(sessionId);
  if (!at) {
    const s = await localSession(ctx, sessionId);
    return s && localOps(ctx, s);
  }
  stayHere(box, at.machine);
  const s = await machineSession(ctx, at);
  return s && machineOps(ctx, at, s);
}

/** On a cloud computer a message never reaches another machine; a sandbox is a box of its own. */
export function stayHere(box: BoxApi, machine: string | null | undefined): void {
  if (box.inBox() && machine && machine !== 'sandbox') throw bad(NO_MACHINE, 403);
}
