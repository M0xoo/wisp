// Running a turn on its harness (v1 runner.js #startTurn's second half): the before:run interceptors
// (a guard line, a changed harness, project trust, budget, a capped channel) may hold or refuse it;
// then the checkpoint, the prompt and the run itself. A run ends exactly once: on exit, LINGER_MS
// after its result, or when a follow-up arrives (release).

import type { Attachment, BeforeRunCtx, Harness, HarnessEvent, HarnessHandle, HarnessRun, SessionId, TurnId } from '@wisp-plugin/runtime-api';
import { handoffNote } from '../handoff.ts';
import { leanTask } from '../lean.ts';
import { agentPrompt } from '../mentions.ts';
import type { Member, Mode, RunOpts, Session, Turn } from '../model.ts';
import { workdir } from '../model.ts';
import { setting } from '../rt.ts';
import type { Live, Rt } from '../rt.ts';
import { sidePrompt } from '../side/prompt.ts';
import { stillWorkingNote } from '../subagents.ts';
import type { Engine, HoldSpec } from './engine.ts';
import { expansions, prefixes, runParts, sideModeOf, systemPromptFor, toolName } from './prompts.ts';

const LINGER_MS = 3000; // how long a CLI may keep running after it reported its result
const BACKGROUND_MAX_MS = 60 * 60_000; // how long a turn may wait on its background tasks

export const sideMode = (e: Engine, agent: string): Mode => sideModeOf(e.rt, agent);

/** A timer on the plugin's scope that can be cancelled (Scope.timeout has no handle). */
export function timer(rt: Rt, ms: number, fn: () => void): () => void {
  const child = rt.scope.child('timer');
  child.timeout(ms, () => {
    child.dispose();
    fn();
  });
  return () => child.dispose();
}

const nameOf = (rt: Rt, s: Session) => (t: Turn): string => rt.points.harness(t.agent || s.agent)?.name ?? (t.agent || s.agent);

/** What the before:run interceptors decide: run (with what they set), hold, or refuse. */
type Gate = { kind: 'run'; ctx: BeforeRunCtx } | { kind: 'hold'; hold: HoldSpec } | { kind: 'refused'; text: string };

async function gate(e: Engine, s: Session, turn: Turn, mode: Mode, opts: RunOpts): Promise<Gate> {
  const ctx: BeforeRunCtx = {
    sessionId: s.id as SessionId,
    turnId: turn.id as TurnId,
    agent: s.agent,
    ...(s.account && { account: s.account }),
    model: s.model,
    mode,
    cwd: workdir(s),
    prompt: turn.prompt,
    ...(opts.by && { by: opts.by }),
    ...(s.parentId && { parentId: s.parentId as SessionId }),
    kind: s.turns.length > 1 ? 'followUp' : 'first',
  };
  try {
    const out = await e.rt.hook<BeforeRunCtx>('before:run', ctx);
    // A subagent, a delegated run or a side discussion never waits: its lead (or the main task) was asked.
    if (out.hold && !s.parentId && !s.delegated && !s.sideOf) {
      const { by, kind, until, data } = out.hold;
      const card = typeof data === 'object' && data !== null && !Array.isArray(data) ? data : {};
      return { kind: 'hold', hold: { ...card, by, reason: kind, agent: s.agent, ...(until !== undefined && { until }) } };
    }
    return { kind: 'run', ctx: out };
  } catch (err) {
    const d = (err as { details?: { reason?: string } }).details;
    return { kind: 'refused', text: d?.reason ?? (err as Error).message };
  }
}

interface RunState {
  handle: HarnessHandle | null;
  released: boolean;
  cancelled: boolean;
  cancelLinger: (() => void) | null;
  resolveDone: () => void;
}

export function launch(e: Engine, s: Session, turn: Turn, attachments: Attachment[], opts: RunOpts, mode: Mode, prev: Turn | undefined): void {
  const rt = e.rt;
  const ctrl = new AbortController();
  const st: RunState = { handle: null, released: false, cancelled: false, cancelLinger: null, resolveDone: () => undefined };
  const done = new Promise<void>((r) => (st.resolveDone = r));
  const live: Live = {
    stop() {
      st.cancelled = true;
      ctrl.abort();
      st.handle?.stop();
    },
    done,
    release: () => release(e, s, turn, st, live),
  };
  // Registered now, before any await: a follow-up arriving meanwhile queues behind this run.
  rt.live.set(s.id, live);
  void start(e, s, turn, attachments, opts, mode, prev, st, live, ctrl).catch((err: unknown) => {
    rt.log.error('a run failed to start', { session: s.id, error: (err as Error).message });
    if (turn.status === 'running') e.finishTurn(s, turn, { isError: true, text: (err as Error).message });
    live.release();
  });
}

async function start(e: Engine, s: Session, turn: Turn, attachments: Attachment[], opts: RunOpts, mode: Mode, prev: Turn | undefined, st: RunState, live: Live, ctrl: AbortController): Promise<void> {
  const rt = e.rt;
  const h = rt.points.harness(s.agent);
  const g = await gate(e, s, turn, mode, opts);
  if (rt.db.get(s.id) !== s || s.turns.at(-1) !== turn || turn.status !== 'running') return void live.release();
  if (st.cancelled) return void live.release(); // stopped or interrupted before it ran: release finishes it
  if (g.kind === 'hold') return void holdInstead(e, s, turn, attachments, opts, g.hold, prev, st, live);
  if (g.kind === 'refused' || !h) {
    e.finishTurn(s, turn, { isError: true, text: g.kind === 'refused' ? g.text : `Unknown agent: ${s.agent}` });
    return void live.release();
  }
  if (g.ctx.untrusted) turn.untrusted = true; // ran without the repo's hooks and servers
  // A subagent's edits land in the lead's turn, whose checkpoint already covers them.
  if (s.agent !== 'wisp' && !s.parentId && !s.sideOf && rt.checkpoints) turn.checkpoint = await rt.checkpoints.capture(workdir(s), s.id, turn.id).catch(() => null);
  if (st.cancelled) return void live.release();
  const run = await buildRun(e, s, turn, h, attachments, opts, mode, g.ctx);
  if (st.cancelled) return void live.release();
  spawn(e, s, turn, h, run, st, live, ctrl);
}

/** The turn was recorded as running; an interceptor held it: it becomes a held turn instead. */
function holdInstead(e: Engine, s: Session, turn: Turn, attachments: Attachment[], opts: RunOpts, hold: HoldSpec, prev: Turn | undefined, st: RunState, live: Live): void {
  s.turns.pop();
  e.rt.db.dropTurn(s, turn);
  if (prev) {
    if (turn.btw?.length) prev.btw = [...(prev.btw ?? []), ...turn.btw];
    if (turn.delegations?.length) prev.delegations = [...(prev.delegations ?? []), ...turn.delegations];
    e.rt.db.save(s, { turns: [prev] });
  }
  st.released = true;
  if (e.rt.live.get(s.id) === live) e.rt.live.delete(s.id);
  st.resolveDone();
  e.holdTurn(s, turn.prompt, attachments, opts, hold);
}

async function buildRun(e: Engine, s: Session, turn: Turn, h: Harness, attachments: Attachment[], opts: RunOpts, mode: Mode, ctx: BeforeRunCtx): Promise<Omit<HarnessRun, 'signal' | 'onEvent'>> {
  const rt = e.rt;
  // Leads get the delegate tool next to ask_user; subagents get neither (nobody to ask).
  const team: Member[] = h.askTool !== null && !s.delegated ? (s.subagents ?? []) : [];
  const acc = rt.points.accounts(s.agent);
  const perLogin = !!s.account && !!acc?.perLogin;
  const mine = perLogin ? (t: Turn): boolean => (t.agent || s.agent) === s.agent && (t.account || 'default') === s.account : undefined;
  const handoff = s.parentId ? '' : handoffNote(s, s.agent, s.agentSessionId, nameOf(rt, s), mine);
  // Mentioned tasks: a lead reads them with wisp_session; a run without wisp's tools gets their reports.
  const tools = !s.parentId && !s.delegated && h.askTool !== null && !!rt.bridge;
  const text = agentPrompt(turn.prompt, (id) => rt.db.get(id), { tool: tools ? toolName(h.askTool, 'wisp_session') : null, self: s.id, extra: expansions(rt, s, turn.prompt, tools) });
  const owed = turn.delegations?.filter((d) => d.owed) ?? [];
  const still = owed.length && team.length && rt.bridge ? stillWorkingNote(owed) : '';
  const main = s.sideOf ? (rt.db.get(s.sideOf.id) ?? null) : null;
  if (main && s.sideOf) s.sideOf.cwd = workdir(main); // where the main task works now (it may have moved)
  const said = s.sideOf ? sidePrompt(main, text, nameOf(rt, main ?? s)) : text;
  const delegating = team.length > 0 && !!rt.bridge;
  const subagentModel = s.agent === 'claude' && !delegating ? (s.subagentModel ?? setting(rt, 'subagentModel')) || '' : '';
  const skills = s.agent === 'claude' && s.skills === 'off' ? 'off' : '';
  if (subagentModel) turn.run = { ...turn.run, subagentModel };
  if (skills) turn.run = { ...turn.run, skills };
  const parts = runParts(e, s, h, team, mode, turn.id);
  const lead = s.parentId ? rt.db.get(s.parentId) : undefined;
  const plain = !!turn.plain;
  return {
    // Anything in front of /compact stops it being a command.
    prompt: opts.by === 'compact' ? turn.prompt : [handoff, still, ...prefixes(rt, s, turn), said].filter(Boolean).join('\n\n'),
    attachments,
    cwd: workdir(s),
    dirs: [...((lead ?? main ?? s).dirs ?? []), ...parts.dirs],
    ...(s.agentSessionId && { resumeId: s.agentSessionId }),
    ...(s.agentSessionId && priorTotals(s) !== null && { prior: priorTotals(s) as never }),
    mode,
    model: s.model,
    effort: s.effort || '',
    systemPrompt: await systemPromptFor(e, s, h, team, plain),
    mcpServers: parts.mcpServers,
    grants: opts.grants ?? [],
    env: { WISP_TASK: s.id, ...parts.env },
    ...(ctx.accountEnv && { accountEnv: ctx.accountEnv }),
    delegating,
    subagentModel,
    skills,
    untrusted: !!ctx.untrusted,
    quiet: leanTask(s, setting(rt, 'leanRuns')),
    gate: !!s.sideOf && mode === 'edits',
    capped: !!s.capped,
    probe: true,
  };
}

/** What the harness's counters held after this conversation's last turn (stats.totals). */
export function priorTotals(s: Session): Record<string, unknown> | null {
  const here = (st: Record<string, unknown>): boolean => {
    const thread = (st['totals'] as { thread?: string } | undefined)?.thread;
    return !thread || thread === s.agentSessionId;
  };
  const st = s.turns.findLast((t) => t.stats && (t.agent || s.agent) === s.agent && here(t.stats))?.stats;
  if (!st) return null;
  return (st.totals as Record<string, unknown> | undefined) ?? { costUsd: st.costUsd, models: st['models'], inputTokens: st['inputTokens'], cachedInputTokens: st['cachedInputTokens'], outputTokens: st['outputTokens'] };
}

function spawn(e: Engine, s: Session, turn: Turn, h: Harness, run: Omit<HarnessRun, 'signal' | 'onEvent'>, st: RunState, live: Live, ctrl: AbortController): void {
  const rt = e.rt;
  const onEvent = (ev: HarnessEvent): void => {
    // A lingering process we already let go of. A `cli` event is no process; nor is `billing` from the sign-in check.
    if (st.released && ev.type !== 'cli' && ev.type !== 'billing') return;
    const waiting = e.onEvent(s, turn, ev) === 'waiting';
    // A CLI can outlive its result (flushing, or a background process holding stdout open). A result
    // that left background tasks running gets up to BACKGROUND_MAX_MS for its next one.
    if (ev.type === 'result') {
      st.cancelLinger?.();
      st.cancelLinger = timer(rt, waiting ? BACKGROUND_MAX_MS : LINGER_MS, () => live.release());
    }
  };
  try {
    st.handle = h.run({ ...run, signal: ctrl.signal, onEvent });
  } catch (err) {
    // The system prompt and roster go on the command line and in the env, and the OS caps those.
    const code = (err as { code?: string }).code;
    const big = code === 'E2BIG' || code === 'ENAMETOOLONG';
    const team = s.subagents ?? [];
    const text = big ? `This run's instructions are too long for this computer to start it${team.length ? `: its team has ${team.length} delegates` : ''}. (${(err as Error).message})` : (err as Error).message;
    e.finishTurn(s, turn, { isError: true, text });
    return void live.release();
  }
  st.handle.done.then(
    () => live.release(),
    () => live.release(),
  );
}

/** Ends the run exactly once, and starts what waits behind it (v1 release()). */
function release(e: Engine, s: Session, turn: Turn, st: RunState, live: Live): void {
  if (st.released) return;
  const rt = e.rt;
  // Gone while waiting on background work (stopped, interrupted, or it died): the result it gave before waiting is the best we have.
  if (turn.status === 'running' && s.turns.includes(turn)) e.finishTurn(s, turn, turn.interim ?? (st.cancelled ? { stopped: true, text: '' } : { isError: true, text: 'The agent exited without a result.' }));
  st.released = true;
  st.cancelLinger?.();
  st.handle?.stop();
  st.resolveDone();
  if (rt.live.get(s.id) !== live) return;
  rt.live.delete(s.id);
  rt.interrupting.delete(s.id);
  rt.stopping.delete(s.id); // a stop that landed after the result has nothing left to stop
  const next = s.queueHeld ? undefined : s.queue.shift();
  const handed = rt.handing.delete(s.id);
  if (next && rt.db.get(s.id) === s) e.startQueued(s, next);
  // Kept in Working for a follow-up that was then taken back or stopped: it lands in your queue after all.
  else if (handed) e.settle(s, { quiet: true });
  else e.touch(s);
}
