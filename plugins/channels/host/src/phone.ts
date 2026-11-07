// The phone (v1 services/phone.js): what a tap or a reply in a channel does to a task, and what the
// channel layer asks of wisp: what there is to choose from (context), a parsed message started
// (startParsed), and what works in a task's thread (stop, status, run, mention). Every action is a
// command of its owner; a task a channel starts below Full auto is created speaking for `agent:capped`
// (plan §6.5), so it and everything it starts stay under the cap, whatever tools it is offered.

import type { Caller, Json, PluginContext } from '@wisp/kernel';
import { POINTS, type Harness, type Mode, type Session } from '@wisp-plugin/runtime-api';
import type { ActArgs, AdapterView, BoxApi, ChannelCtx, MemberView, Parsed, Phone, ProjectView, RunOpts, SessionView, StartOpts } from '@wisp-plugin/channels-api';
import { ackCrew, ackTask, bad, cappedAt, capMode, handleOf, modelLabel, modelNote, needsWisp, tighter, truncate, untrusted } from '@wisp-plugin/channels-api/kit';
import { type Ops, type ReplyResult, localSession, sessionOps, splitId, stayHere } from './ops.ts';
import { DEFAULTS, OTHERS, RUNTIME, asAgents, asMachines, asMembers, asProjects, tryRun } from './wisp.ts';

const BTW_WAIT_MS = 5 * 60_000 + 30_000; // v1 BTW_TIMEOUT_MS, and a little more
const GOALS = ['cheap', 'balanced', 'best']; // v1 router.js GOALS, until wisp.router answers

/** The capability set a task started at this cap speaks for: null at Full auto (ADR-0008). */
export const cappedCaller = (cap: Mode): Caller | undefined => {
  const c = cappedAt(cap);
  if (!c) return undefined;
  return { set: c.mode === 'edits' ? 'agent:capped' : `agent:capped:${c.mode}` };
};

const sentLine = (r: ReplyResult): string => (r.answered ? '✓ Answered' : r.interrupted ? '✓ Sent; the agent picked it up mid-run' : r.queued ? '✓ Queued for when it finishes' : '✓ Sent');

const taggedDelegate = (m: MemberView, where = 'task'): Json => ({
  crew: m.id,
  name: handleOf(m.name),
  label: m.name,
  ...(m.role && { role: m.role }),
  agent: m.agent,
  use: `${m.role ? `${m.role}. ` : ''}The user tagged them in this ${where} to work on it with you: hand them their part rather than doing it all yourself`,
});

export interface PhoneDeps {
  ctx: PluginContext;
  box: BoxApi;
  /** the default project (the hub's) */
  defaultProject(): Promise<ProjectView | null>;
  /** a task began from a channel (or couldn't): the hub tells its transport */
  threadStarted(s: SessionView | null, thread: StartOpts['thread'], member: MemberView | null, err?: Error): void;
  /** where the btw answers come in (the host feeds wisp.runtime's btw events into it) */
  btw: Map<string, (b: { status: string; answer?: string; error?: string } | null) => void>;
}

export function makePhone(d: PhoneDeps): Phone & { refresh(): Promise<void> } {
  const { ctx, box } = d;
  const state = { gridOn: false };
  const ops = (id: string): Promise<Ops | null> => sessionOps(ctx, box, id);
  const reach = async (id: string): Promise<Ops | { error: string } | null> => ops(id).catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }));
  const count = (kind: string, detail = ''): void => void tryRun(ctx, OTHERS.telemetry, { event: 'channel_event', props: { kind, ...(detail && { detail }) } }, null);
  const adapters = (): AdapterView[] => ctx.contributions<Harness>(POINTS.harness).map((h) => ({ id: h.id, name: h.name, models: h.models, ...(h.efforts && { efforts: h.efforts }), ...(h.modelOverride && { modelOverride: h.modelOverride.bind(h) }) }));

  async function context(): Promise<ChannelCtx> {
    const [projects, machines, agents, crew, goals, sandbox, tasks, defaultProject] = await Promise.all([
      tryRun(ctx, OTHERS.projects, {}, []).then(asProjects),
      box.inBox() ? Promise.resolve([]) : tryRun(ctx, OTHERS.machines, {}, []).then(asMachines),
      tryRun(ctx, OTHERS.agents, {}, []).then(asAgents),
      tryRun(ctx, OTHERS.crewList, {}, []).then(asMembers),
      tryRun<string[]>(ctx, OTHERS.goals, {}, GOALS),
      tryRun(ctx, OTHERS.sandbox, {}, false),
      tryRun<Session[]>(ctx, RUNTIME.list, {}, []),
      d.defaultProject(),
    ]);
    return {
      projects,
      machines: machines.filter((m) => !m.sandbox),
      agents,
      adapters: adapters(),
      crew,
      crewView: crew,
      goals,
      defaultProject,
      defaultAgent: ctx.settings.get<string>(DEFAULTS.agent) ?? '',
      sandbox: !!sandbox,
      tasks: tasks.filter((s) => (s.state === 'running' || (s as { status?: string }).status === 'waiting') && !s.parentId).map((s) => ({ id: s.id, title: s.title, state: (s as { status?: string }).status === 'waiting' ? 'waiting' : s.state })),
    };
  }

  /** A /btw's answer once it's in, or null (dismissed, or it never came). */
  const btwAnswer = (btwId: string): Promise<{ status: string; answer?: string; error?: string } | null> =>
    new Promise((resolve) => {
      d.btw.set(btwId, (b) => (d.btw.delete(btwId), resolve(b)));
      ctx.scope.timeout(BTW_WAIT_MS, () => d.btw.get(btwId)?.(null));
    });

  // Sends a follow-up and says what became of it. Not awaited: the bot keeps taking messages while a
  // /btw's side run answers.
  async function followUp(o: Ops, text: string, later: ((t: string) => void) | undefined, opts?: { mode?: string; run?: Record<string, string> }): Promise<string> {
    const r = await o.reply(text, opts);
    if (r.btw) {
      btwAnswer(r.btw.id).then((b) => b && later?.(truncate(b.status === 'done' ? `btw: ${b.answer}` : `Couldn’t answer that: ${b.error}`, 4000)), () => {});
      return later ? '✓ Asking on the side; the agent keeps working. The answer follows here.' : '✓ Asked on the side; the answer shows on the card in wisp.';
    }
    return sentLine(r);
  }

  const placeOf = (c: ChannelCtx, mid: string | null | undefined): string => (mid === 'sandbox' ? 'sandbox' : (mid && c.machines.find((m) => m.id === mid)?.name) || '');

  // A member's model, effort and mode for one job: only what differs from theirs.
  function memberRun(m: MemberView, p: Parsed, cap: Mode, fallback?: Mode): Record<string, string> {
    const { mode, refused } = capMode(p.mode, cap, fallback ?? m.mode);
    if (refused) throw bad(refused);
    return { ...(p.model && { model: p.model }), ...(p.effort && { effort: p.effort }), ...(mode && mode !== m.mode && { mode }) };
  }

  function crewAck(m: MemberView, p: Parsed, run: Record<string, string>, out: { queued?: number }, c: ChannelCtx, fallback?: Mode): string {
    const queued = out.queued !== undefined;
    const shown = (run['mode'] || p.mode || (fallback && m.mode)) as Mode | undefined;
    const [model, mode] = [run['model'] || m.model || '', (run['mode'] || m.mode) as Mode];
    return ackCrew({
      name: m.name,
      ahead: queued ? (out.queued ?? 0) - 1 + (m.running ?? 0) : null,
      paused: !!m.paused,
      project: c.projects.find((x) => x.path === m.cwd)?.name || '',
      label: modelLabel(c, m.agent, model, run['effort'] || m.effort || '', mode),
      mode: shown,
      machine: placeOf(c, m.sandbox ? 'sandbox' : m.machine),
      task: p.prompt,
      notes: [...p.notes, ...(Object.keys(run).length ? [`${run['model'] || run['effort'] ? 'That model' : 'That mode'} is for this job only.`] : []), modelNote(c, m.agent, model, mode)],
    });
  }

  async function startCrew(p: Parsed & { crew: MemberView }, o: StartOpts, c: ChannelCtx, prompt: string, cap: Mode): Promise<{ ack: string; queued?: number }> {
    stayHere(box, p.machine);
    stayHere(box, p.crew.machine);
    const run = memberRun(p.crew, p, cap, o.fallback);
    const capped = cappedAt(cap);
    const out = await ctx.run<{ queued?: number }>(OTHERS.crewAssign, { member: p.crew.id, prompt, job: 'task', origin: { kind: o.channel, name: o.name }, tagged: p.tagged.map((m) => m.id), ...(Object.keys(run).length && { run }), ...(capped && { capped }), thread: o.thread ?? null }, cappedCaller(cap) ? { caller: cappedCaller(cap) as Caller } : undefined);
    count('start', 'crew');
    return { ...out, ack: crewAck(p.crew, p, run, out, c, o.fallback) };
  }

  async function startParsed(p: Parsed, o: StartOpts): Promise<{ ack: string; session?: SessionView; queued?: number }> {
    const c = o.ctx ?? (await context());
    const cap = o.cap ?? 'auto';
    const prompt = untrusted(p.prompt, { channel: o.name, sender: o.sender ?? '', about: o.about ?? '' });
    if (p.crew) return startCrew({ ...p, crew: p.crew }, o, c, prompt, cap);
    const project = p.project || c.defaultProject;
    if (!project) throw bad('No projects yet. Open a folder in wisp first.');
    const dAgent = ctx.settings.get<string>(DEFAULTS.agent) || '';
    const agent = p.agent || dAgent || 'claude';
    const models = ctx.settings.get<Record<string, string>>(DEFAULTS.models) ?? {};
    const model = p.model ?? models[agent] ?? (agent === (dAgent || 'claude') ? (ctx.settings.get<string>(DEFAULTS.model) ?? '') : '');
    const { mode, refused } = capMode(p.mode, cap, o.fallback ?? ctx.settings.get<Mode>(DEFAULTS.mode) ?? 'auto');
    if (refused || !mode) throw bad(refused);
    const machine = p.machine ?? (project.machine || undefined);
    stayHere(box, machine);
    // Below Full auto, the task and all it starts stay under the cap: it speaks for agent:capped.
    const capped = cappedAt(cap);
    const args = {
      prompt, cwd: project.path, agent, model, mode, by: 'channel',
      ...(machine && { machine }), ...(p.effort && { effort: p.effort }),
      ...(p.tagged.length && { subagents: p.tagged.map((m) => taggedDelegate(m)) }),
      ext: { 'wisp.channels': { origin: { kind: o.channel, name: o.name }, ...(capped && { capped }) } },
    };
    const caller = cappedCaller(cap);
    const { id } = await ctx.run<{ id: string }>(RUNTIME.create, args, caller ? { caller } : undefined);
    const s = (await localSession(ctx, id).catch(() => null)) ?? { id, title: '', state: 'running', agent, model, turns: [] };
    d.threadStarted(s, o.thread ?? null, null);
    count('start', p.agent || p.model || p.effort ? 'with' : 'plain');
    const [ran, used] = [s.agent || agent, s.model ?? model];
    return { session: s, ack: ackTask({ project: project.name, label: modelLabel(c, ran, used, s.effort || p.effort || '', mode), mode, machine: placeOf(c, machine), task: s.title || p.prompt, notes: [...p.notes, modelNote(c, ran, used, mode)] }) };
  }

  const gone = async (id: string): Promise<Ops | string> => {
    const o = await reach(id);
    if (o && 'error' in o) return `Can’t reach it: ${o.error}`;
    return o ?? 'That session is gone.';
  };

  async function stop(sessionId: string): Promise<string> {
    const o = await gone(sessionId);
    if (typeof o === 'string') return o;
    const { s } = o;
    if (s.state !== 'running' && s.state !== 'waiting') return 'It isn’t running.';
    const held = s.queue?.length || 0;
    await o.stop();
    count('thread', 'stop');
    return `■ Stopped.${held ? ` ${held} queued follow-up${held > 1 ? 's' : ''} kept: your next message carries them on.` : ''}`;
  }

  async function status(sessionId: string): Promise<string> {
    const o = await gone(sessionId);
    if (typeof o === 'string') return o;
    const { s } = o;
    const q = s.queue?.length || 0;
    const word = ({ running: 'Working', waiting: 'Waiting for you', review: 'Ready for review', done: 'Done' } as Record<string, string>)[s.state] || s.state;
    return `${word}: ${s.title}${q ? ` (${q} queued${s.queueHeld ? ', held' : ''})` : ''}`;
  }

  // A follow-up in a thread, as `act` sends one, wrapped, with any `with` from the message.
  async function run(sessionId: string, p: Parsed, o: RunOpts): Promise<string> {
    const got = await gone(sessionId);
    if (typeof got === 'string') return got;
    const { s } = got;
    if (s.agent === 'wisp') return 'That is the tour; it can’t take follow-ups.';
    if (s.kind === 'reminder') return 'A reminder has no agent to follow up with. Start a new task instead.';
    const term = await tryRun(ctx, OTHERS.terminalOpen, { sessionId: s.id }, { open: false });
    if (term.open && !s.tui) return 'This task is open in a terminal. Carry on there, or end the terminal first.';
    if (o.approvals === false && needsWisp(s.ask)) return 'That’s waiting for an approval, which only wisp can give: answer it there.';
    const text = untrusted(p.prompt, { channel: o.name, sender: o.sender ?? '', about: s.ask ? '' : (o.about ?? '') });
    if (o.btw) return followUp(got, `/btw ${text}`, o.later);
    // The task's own cap holds whichever chat this comes from; only you, in wisp, lift it.
    const asked = capMode(p.mode, tighter(o.cap ?? 'auto', s.capped ?? null), s.mode ?? 'auto');
    if (asked.refused) return asked.refused;
    const moved = p.agent || p.model || p.effort;
    const members = moved ? asMembers(await tryRun(ctx, OTHERS.crewList, {}, [])) : [];
    const member = members.find((m) => m.id === s.crew?.id);
    if (member && p.agent && p.agent !== s.agent) return `${member.name} stays on ${adapters().find((a) => a.id === s.agent)?.name || s.agent}: a job can’t change harness.`;
    if (member?.agent === 'auto' && moved) return `${member.name} is on Auto, which picks the model itself.`;
    const want = { ...(p.agent && { agent: p.agent }), ...(p.model && { model: p.model }), ...(p.effort && { effort: p.effort }) };
    const agent = p.agent || s.agent;
    const note = moved || asked.mode !== s.mode ? modelNote({ adapters: adapters() }, agent, p.model || (agent === s.agent ? s.model || '' : ''), asked.mode ?? 'auto') : '';
    const line = await followUp(got, text, o.later, { ...(asked.mode && asked.mode !== s.mode && { mode: asked.mode }), ...(moved && { run: want }) });
    count('thread', moved ? 'with' : 'follow-up');
    return [moved ? `${line} · ${modelLabel(await context(), agent, p.model ?? '', p.effort ?? '', asked.mode ?? 'auto')}` : line, note].filter(Boolean).join('\n');
  }

  // @Ada in a task's thread: the mention path. Their answer comes back to this thread under their name.
  async function mention(sessionId: string, p: Parsed, o: StartOpts): Promise<{ ack: string; queued?: number }> {
    const s = splitId(sessionId) ? null : await localSession(ctx, sessionId);
    if (!s || !p.crew) throw bad('@names only reach tasks on this computer.');
    stayHere(box, p.crew.machine);
    const c = o.ctx ?? (await context());
    const most = tighter(o.cap ?? 'auto', s.capped ?? null);
    const capped = cappedAt(most);
    const run = memberRun(p.crew, p, most, o.fallback);
    const text = untrusted(p.prompt, { channel: o.name, sender: o.sender ?? '', about: o.about ?? '' });
    const caller = cappedCaller(most);
    const out = await ctx.run<{ queued?: number }>(OTHERS.crewAsk, { member: p.crew.id, sessionId, text, tagged: p.tagged.map((m) => m.id), thread: o.thread ?? null, shown: p.prompt, ...(capped && { capped }), ...(Object.keys(run).length && { run }) }, caller ? { caller } : undefined);
    count('thread', 'mention');
    return { ...out, ack: crewAck(p.crew, p, run, out, c, o.fallback) };
  }

  // /new from Telegram: the launcher's remembered harness, model and mode, like `wisp "…"`.
  async function launch({ project, prompt }: { project: ProjectView; prompt: string }): Promise<SessionView | null> {
    stayHere(box, project.machine);
    const agent = ctx.settings.get<string>(DEFAULTS.agent) || 'claude';
    const model = ctx.settings.get<Record<string, string>>(DEFAULTS.models)?.[agent] ?? ctx.settings.get<string>(DEFAULTS.model) ?? '';
    const mode = ctx.settings.get<Mode>(DEFAULTS.mode) || 'auto';
    const { id } = await ctx.run<{ id: string }>(RUNTIME.create, { prompt, cwd: project.path, agent, model, mode, by: 'channel', ...(project.machine && { machine: project.machine }), ext: { 'wisp.channels': { origin: { kind: 'telegram', name: 'Telegram' } } } });
    return localSession(ctx, id);
  }

  async function act(a: ActArgs): Promise<string> {
    const got = await gone(a.sessionId);
    if (typeof got === 'string') return got;
    const { s } = got;
    if (a.approvals === false && needsWisp(s.ask)) return 'That’s waiting for an approval, which only wisp can give: answer it there.';
    const index = a.index ?? 0;
    if (a.kind === 'answer') {
      if (!s.ask || s.ask.id !== a.ref) return 'That question was already answered.';
      const answer = s.ask.options?.[index];
      if (answer === undefined) return 'Unknown option.';
      await got.answer(answer);
      return `✓ Answered: ${answer}`;
    }
    if (a.kind === 'reply') {
      const turn = s.turns.at(-1);
      if (!turn || turn.id !== a.ref || s.state === 'running') return 'That was already answered.';
      const q = turn.presentation?.blocks?.findLast((b) => b?.type === 'question') as { options?: unknown[] } | undefined;
      const opt = q?.options?.[index] as string | { reply?: string; label?: string } | undefined;
      const msg = typeof opt === 'string' ? opt : opt?.reply || opt?.label;
      if (!msg) return 'Unknown option.';
      await got.reply(msg);
      return `✓ Sent: ${typeof opt === 'string' ? opt : opt?.label || msg}`;
    }
    if (a.kind === 'done') {
      if (s.turns.at(-1)?.id !== a.ref && a.ref) return 'There is newer work on that session; open wisp to review it.';
      return (await got.done()) ? '✓ Marked done' : 'It is still working.';
    }
    if (s.agent === 'wisp') return 'That is the tour; it can’t take follow-ups.';
    return followUp(got, String(a.text || '').trim(), a.later);
  }

  return {
    context,
    count,
    onGrid: () => state.gridOn,
    gridReply: (thread, text) => ctx.run(OTHERS.gridReply, { thread, text }),
    threadSaved: () => void tryRun(ctx, OTHERS.crewChanged, {}, null),
    threadCtx: async (sessionId) => {
      const o = await ops(sessionId).catch(() => null);
      return { agent: o?.s.agent || '', machine: splitId(sessionId)?.machine || '' };
    },
    startParsed,
    stop,
    status,
    run,
    mention,
    launch,
    act,
    projects: async () => asProjects(await tryRun(ctx, OTHERS.projects, {}, [])),
    session: (id) => (splitId(id) ? ops(id).then((o) => o?.s ?? null) : localSession(ctx, id)),
    sessions: async () => {
      const list = await tryRun<Session[]>(ctx, RUNTIME.list, {}, []);
      const live = list.filter((s) => !s.parentId && (s.state === 'running' || (s as { status?: string }).status === 'waiting'));
      return (await Promise.all(live.map((s) => localSession(ctx, s.id).catch(() => null)))).filter((s): s is SessionView => !!s);
    },
    refresh: async () => {
      state.gridOn = !!(await tryRun(ctx, OTHERS.gridOn, {}, false));
    },
  };
}
