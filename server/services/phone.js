// Phone (ntfy / Telegram): what a tap or a reply there does to a session, here or on a machine, and
// what the channel layer asks of wisp: what there is to choose from (context), a parsed message
// started (startParsed), and what works in a task's thread (stop, run, mention).

import { adapters } from '../adapters/index.js';
import { BTW_TIMEOUT_MS } from '../btw.js';
import { cappedAt, tighter } from '../capped.js';
import { ackCrew, ackTask, modelLabel, modelNote } from '../channels/lists.js';
import { capMode, needsWisp, untrusted } from '../channels/policy.js';
import { taggedDelegate } from '../crew.js';
import { splitId } from '../machines.js';
import { GOALS } from '../router.js';
import { bad, truncate } from '../util.js';

export function phoneActions(app) {
  const { store, runner, machines } = app;

  // What the phone can do to a session, here or on a machine: { s, answer, reply, done } or null.
  async function sessionOps(sessionId) {
    const at = splitId(sessionId);
    if (!at) {
      const s = store.get(sessionId);
      return s && { s, answer: (a) => runner.answer(s, a), reply: (t, o = {}) => app.launcher.replyTo(s, t, [], undefined, o.mode, o.run), done: () => app.launcher.markDone(s), stop: async () => runner.stop(s) };
    }
    const call = (method, p, body) => machines.json(at.machine, method, `/sessions/${at.id}${p}`, body);
    const s = await call('GET', '').catch((err) => {
      if (err.status === 404) return null;
      throw err;
    });
    const live = s && (s.state === 'running' || s.state === 'waiting');
    return s && { s: machines.session(at.machine, s), answer: (a) => call('POST', '/answer', { text: a }), reply: (t, o = {}) => call('POST', '/reply', { text: t, ...(o.mode && { mode: o.mode }), ...o.run }), done: async () => !live && !!(await call('PATCH', '', { state: 'done' })), stop: () => call('POST', '/stop') };
  }

  // A /btw from the phone: its answer, once it's in (null if it was dismissed or never came).
  async function btwAnswer(sessionId, btwId) {
    for (const end = Date.now() + BTW_TIMEOUT_MS + 30_000; Date.now() < end; ) {
      await new Promise((r) => setTimeout(r, 1500));
      const b = (await sessionOps(sessionId).catch(() => null))?.s.turns.flatMap((t) => t.btw || []).find((x) => x.id === btwId);
      if (!b) return null;
      if (b.status !== 'running') return b;
    }
    return null;
  }

  const sentLine = (r) => (r.answered ? '✓ Answered' : r.interrupted ? '✓ Sent; the agent picked it up mid-run' : r.queued ? '✓ Queued for when it finishes' : '✓ Sent');

  // Sends a follow-up and says what became of it. Not awaited: the bot keeps taking messages while a
  // /btw's side run answers.
  async function followUp(ops, sessionId, text, later, o) {
    const r = await ops.reply(text, o);
    if (r.btw) {
      btwAnswer(sessionId, r.btw.id).then((b) => b && later?.(truncate(b.status === 'done' ? `btw: ${b.answer}` : `Couldn’t answer that: ${b.error}`, 4000))).catch(() => {});
      return later ? '✓ Asking on the side; the agent keeps working. The answer follows here.' : '✓ Asked on the side; the answer shows on the card in wisp.';
    }
    return sentLine(r);
  }

  // Counts only, and only fixed values: never what a message said.
  const count = (kind, detail = '') => app.telemetry?.track('channel_event', { kind, ...(detail && { detail }) });

  // Everything a message may pick from, for grammar.js and lists.js.
  async function context() {
    const crew = app.crew?.list || [];
    return {
      projects: store.config.projects,
      machines: (store.config.machines || []).filter((m) => !m.sandbox).map((m) => ({ id: m.id, name: m.name, kind: m.kind, computer: m.computer, usable: machines.usable(m.id), agents: machines.agentsOf(m.id) })),
      agents: await app.auto.agents(),
      adapters: Object.values(adapters),
      crew,
      crewView: crew.map((m) => app.crew.view(m)),
      goals: Object.keys(GOALS),
      defaultProject: app.remote.defaultProject(),
      defaultAgent: store.config.defaults.agent || '',
      sandbox: !!app.sandbox?.available?.(),
      tasks: store.all().filter((s) => (s.state === 'running' || s.state === 'waiting') && !s.parentId && !s.delegated),
    };
  }

  const placeOf = (ctx, mid) => (mid === 'sandbox' ? 'sandbox' : (mid && ctx.machines.find((m) => m.id === mid)?.name) || '');

  // A member's model, effort and mode for one job: only what differs from theirs.
  function memberRun(m, p, cap, fallback) {
    const { mode, refused } = capMode(p.mode, cap, fallback ?? m.mode);
    if (refused) throw bad(refused);
    return { ...(p.model && { model: p.model }), ...(p.effort && { effort: p.effort }), ...(mode !== m.mode && { mode }) };
  }

  function crewAck(m, p, run, out, ctx, fallback) {
    const queued = out.queued !== undefined;
    const shown = run.mode || p.mode || (fallback && m.mode);
    const [model, mode] = [run.model || m.model, run.mode || m.mode];
    return ackCrew({
      name: m.name,
      ahead: queued ? out.queued - 1 + app.crew.busy(m) : null,
      paused: m.paused,
      project: ctx.projects.find((x) => x.path === m.cwd)?.name || '',
      label: modelLabel(ctx, m.agent, model, run.effort || m.effort, mode),
      mode: shown,
      machine: placeOf(ctx, m.sandbox ? 'sandbox' : m.machine),
      task: p.prompt,
      notes: [...p.notes, ...(Object.keys(run).length ? [`${run.model || run.effort ? 'That model' : 'That mode'} is for this job only.`] : []), modelNote(ctx, m.agent, model, mode)],
    });
  }

  return {
    context,
    count,
    // A routed message's way back: through the grid, which holds the bot (channels/routed.js).
    onGrid: () => !!app.computer?.view().on,
    gridReply: (thread, text) => app.computer.reply(thread, text),
    // A queued job's thread got its first reply: that's kept with the job.
    threadSaved: () => app.crew?.changed(),
    // Where a thread's follow-up runs, for the models `with` may name.
    threadCtx: async (sessionId) => {
      const ops = await sessionOps(sessionId).catch(() => null);
      return { agent: ops?.s.agent || '', machine: splitId(sessionId)?.machine || '' };
    },
    // A parsed message (grammar.js) with nothing wrong with it. → { ack, session | queued }.
    // cap: the most this chat may ask for (policy.js capMode). fallback: the mode when none was asked
    // for; without one, the launcher's or the member's. about: what the prompt says the message is
    // about (policy.js untrusted). thread: where it answers, kept with a crew job that has to wait
    // (server/crew.js).
    startParsed: async (p, { channel, name, sender = '', cap = 'auto', fallback, about = '', thread = null, ctx = null }) => {
      ctx ||= await context();
      const origin = { kind: channel, name };
      const prompt = untrusted(p.prompt, { channel: name, sender, about });
      // Below Full auto, the task and all it starts stay under the cap (server/capped.js).
      const capped = cappedAt(cap);
      if (p.crew) {
        const run = memberRun(p.crew, p, cap, fallback);
        const out = await app.crew.assign(p.crew, { prompt, job: 'task', origin, tagged: p.tagged, ...(Object.keys(run).length && { run }), ...(capped && { capped }), thread });
        count('start', 'crew');
        return { ...out, ack: crewAck(p.crew, p, run, out, ctx, fallback) };
      }
      const d = store.config.defaults;
      const project = p.project || ctx.defaultProject;
      const agent = p.agent || d.agent || 'claude';
      const model = p.model ?? d.models?.[agent] ?? (agent === (d.agent || 'claude') ? d.model : '') ?? '';
      const { mode, refused } = capMode(p.mode, cap, fallback ?? (d.mode || 'auto'));
      if (refused) throw bad(refused);
      const machine = p.machine ?? (project.machine || undefined);
      const [s] = await app.launcher.launchAny({ prompt, cwd: project.path, machine, agent, model, ...(p.effort && { effort: p.effort }), mode, ...(capped && { capped }), ...(p.tagged.length && { subagents: p.tagged.map((m) => taggedDelegate(m)) }) }, origin);
      app.broadcast('config', {});
      app.remote.threadStarted(s, thread, null);
      count('start', p.agent || p.model || p.effort ? 'with' : 'plain');
      const [ran, used] = [s.agent || agent, s.model ?? model];
      return { session: s, ack: ackTask({ project: project.name, label: modelLabel(ctx, ran, used, s.effort || p.effort, mode), mode, machine: placeOf(ctx, machine), task: s.title || p.prompt, notes: [...p.notes, modelNote(ctx, ran, used, mode)] }) };
    },
    // `stop` in a thread. Queued follow-ups stay, held (runner.stop): the next message carries them on.
    stop: async (sessionId) => {
      const ops = await sessionOps(sessionId).catch((err) => ({ error: err.message }));
      if (ops?.error) return `Can’t reach it: ${ops.error}`;
      if (!ops) return 'That session is gone.';
      const { s } = ops;
      if (s.state !== 'running' && s.state !== 'waiting') return 'It isn’t running.';
      const held = s.queue?.length || 0;
      await ops.stop();
      count('thread', 'stop');
      return `■ Stopped.${held ? ` ${held} queued follow-up${held > 1 ? 's' : ''} kept: your next message carries them on.` : ''}`;
    },
    status: async (sessionId) => {
      const ops = await sessionOps(sessionId).catch((err) => ({ error: err.message }));
      if (ops?.error) return `Can’t reach it: ${ops.error}`;
      if (!ops) return 'That session is gone.';
      const { s } = ops;
      const q = s.queue?.length || 0;
      return `${{ running: 'Working', waiting: 'Waiting for you', review: 'Ready for review', done: 'Done' }[s.state] || s.state}: ${s.title}${q ? ` (${q} queued${s.queueHeld ? ', held' : ''})` : ''}`;
    },
    // A follow-up in a thread, as `act` sends one, wrapped, with any `with` from the message.
    // approvals false: a channel that can't answer a tool approval (policy.js approvalsHere).
    run: async (sessionId, p, { name, sender = '', cap = 'auto', later, btw = false, about = '', approvals = true }) => {
      const ops = await sessionOps(sessionId).catch((err) => ({ error: err.message }));
      if (ops?.error) return `Can’t reach it: ${ops.error}`;
      if (!ops) return 'That session is gone.';
      const { s } = ops;
      if (s.agent === 'wisp') return 'That is the tour; it can’t take follow-ups.';
      if (s.kind === 'reminder') return 'A reminder has no agent to follow up with. Start a new task instead.';
      if (app.terms.get(s.id)?.code === null && !s.tui) return 'This task is open in a terminal. Carry on there, or end the terminal first.';
      if (!approvals && needsWisp(s.ask)) return 'That’s waiting for an approval, which only wisp can give: answer it there.';
      const text = untrusted(p.prompt, { channel: name, sender, about: s.ask ? '' : about });
      if (btw) return followUp(ops, sessionId, `/btw ${text}`, later);
      // The task's own cap holds whichever chat this comes from; only you, in wisp, lift it.
      const asked = capMode(p.mode, tighter(cap, s.capped), s.mode);
      if (asked.refused) return asked.refused;
      const moved = p.agent || p.model || p.effort;
      // A crew job keeps the member's harness, as its first turn did (crew.js #jobRun).
      const member = app.crew?.get(s.crew?.id);
      if (member && p.agent && p.agent !== s.agent) return `${member.name} stays on ${adapters[s.agent]?.name || s.agent}: a job can’t change harness.`;
      if (member?.agent === 'auto' && moved) return `${member.name} is on Auto, which picks the model itself.`;
      const want = { ...(p.agent && { agent: p.agent }), ...(p.model && { model: p.model }), ...(p.effort && { effort: p.effort }) };
      // On a machine its own route checks the harness; here it's checked before anything moves.
      const run = moved ? (splitId(sessionId) ? want : await app.launcher.followUpRun(s, want)) : undefined;
      // Before it's sent: the send moves s itself.
      const agent = p.agent || s.agent;
      const note = moved || asked.mode !== s.mode ? modelNote({ adapters: Object.values(adapters) }, agent, p.model || (agent === s.agent ? s.model : ''), asked.mode) : '';
      const line = await followUp(ops, sessionId, text, later, { ...(asked.mode !== s.mode && { mode: asked.mode }), ...(run && { run }) });
      count('thread', moved ? 'with' : 'follow-up');
      return [moved ? `${line} · ${modelLabel(await context(), agent, p.model, p.effort, asked.mode)}` : line, note].filter(Boolean).join('\n');
    },
    // @Ada in a task's thread: the mention path (crew.ask). Their answer shows on the task, and comes
    // back to this thread under their name.
    mention: async (sessionId, p, { name, sender = '', cap = 'auto', fallback, about = '', thread = null, ctx = null }) => {
      const s = store.get(sessionId);
      if (!s) throw bad('@names only reach tasks on this computer.');
      ctx ||= await context();
      const most = tighter(cap, s.capped);
      const capped = cappedAt(most);
      const run = memberRun(p.crew, p, most, fallback);
      const out = await app.crew.ask(p.crew, s, untrusted(p.prompt, { channel: name, sender, about }), [], p.tagged, { thread, shown: p.prompt, capped, ...(Object.keys(run).length && { run }) });
      count('thread', 'mention');
      return { ...out, ack: crewAck(p.crew, p, run, out, ctx, fallback) };
    },
    // /new from Telegram: the launcher's remembered harness, model and mode, like `wisp "…"`.
    launch: async ({ project, prompt }) => {
      const d = store.config.defaults;
      const agent = d.agent || 'claude';
      const model = d.models?.[agent] ?? d.model ?? '';
      const [s] = await app.launcher.launchAny({ prompt, cwd: project.path, machine: project.machine || undefined, agent, model, mode: d.mode || 'auto' }, { kind: 'telegram', name: 'Telegram' });
      app.broadcast('config', {});
      return s;
    },
    // later(text): a message sent after this one (Telegram), for a /btw's answer. approvals false: a
    // channel that can't answer a tool approval, as in run: ask or task may be on another machine.
    act: async ({ sessionId, kind, ref, index, text, later, approvals }) => {
      const ops = await sessionOps(sessionId).catch((err) => ({ error: err.message }));
      if (ops?.error) return `Can’t reach it: ${ops.error}`;
      if (!ops) return 'That session is gone.';
      const { s } = ops;
      if (approvals === false && needsWisp(s.ask)) return 'That’s waiting for an approval, which only wisp can give: answer it there.';
      if (kind === 'answer') {
        if (!s.ask || s.ask.id !== ref) return 'That question was already answered.';
        const answer = s.ask.options[index];
        if (answer === undefined) return 'Unknown option.';
        await ops.answer(answer);
        return `✓ Answered: ${answer}`;
      }
      if (kind === 'reply') {
        const turn = s.turns.at(-1);
        if (!turn || turn.id !== ref || s.state === 'running') return 'That was already answered.';
        const q = turn.presentation?.blocks?.findLast((b) => b?.type === 'question');
        const o = q?.options?.[index];
        const msg = typeof o === 'string' ? o : o?.reply || o?.label;
        if (!msg) return 'Unknown option.';
        await ops.reply(msg);
        return `✓ Sent: ${typeof o === 'string' ? o : o.label || msg}`;
      }
      if (kind === 'done') {
        if (s.turns.at(-1)?.id !== ref && ref) return 'There is newer work on that session; open wisp to review it.';
        return (await ops.done()) ? '✓ Marked done' : 'It is still working.';
      }
      if (s.agent === 'wisp') return 'That is the tour; it can’t take follow-ups.';
      return followUp(ops, sessionId, String(text || '').trim(), later);
    },
  };
}
