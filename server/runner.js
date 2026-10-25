// Session orchestration: launches turns on adapters, folds their events into the
// session record, and handles follow-ups that arrive while the agent is busy: by default
// they interrupt the run and resume the session with the new message; with the `queue`
// setting they wait until the run finishes.

import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapters } from './adapters/index.js';
import { systemPrompt, parsePresentation, heroOf } from './protocol.js';
import { spellGuide } from './spell-guide.js';
import { captureCheckpoint, freshCheckpoint, readGitFile } from './checkpoint.js';
import { teamNote, copies, SUBAGENT_ASK, delegationReport, stillWorkingNote, REPORTS_BACK } from './subagents.js';
import { handoffNote } from './handoff.js';
import { openTerms } from './pty.js';
import { agentPrompt, plainMentions } from './mentions.js';
import { BTW_SYSTEM, BTW_TIMEOUT_MS, MAX_BTW, btwAnswer, btwPrompt } from './btw.js';
import { bad, clip, MODES, newId } from './util.js';

const MAX_ACTIVITY = 400;
const MAX_TEXT = 20_000; // an agent message, kept whole for the transcript up to this
const MAX_OUTPUT = 2_000; // what a tool call returned: its start and end past this
// The calls whose output the transcript shows. A read returns the file and an edit a confirmation.
const OUTPUT_KINDS = new Set(['run', 'search', 'web', 'tool', 'agent']);
const LINGER_MS = 3000; // how long a CLI may keep running after it reported its result
const BACKGROUND_MAX_MS = 60 * 60_000; // how long a turn may wait on its background tasks
const ASK_SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-ask.js');
// The delegate tool lives on the same injected server, so harnesses name it like ask_user.
const delegateTool = (askTool) => askTool && askTool.replace(/ask_user$/, 'delegate');
// The answers a live approval offers. Typed text instead is a "no, do this instead".
export const APPROVAL = { allow: 'Allow', always: 'Always allow in this task', deny: 'Deny' };
const sameAction = (a, b) => a.tool === b.tool && a.detail === b.detail;

// A live approval's answer: the button the user clicked, a yes/no typed out, or anything else,
// which denies the call and hands the agent the user's words.
export function approvalDecision(text) {
  const t = String(text || '').trim();
  if (t === APPROVAL.always || /^(always\b|2$)/i.test(t)) return { decision: 'allow', always: true };
  if (t === APPROVAL.allow || /^(y|yes|ok|allow|approve|go ahead|1)$/i.test(t)) return { decision: 'allow' };
  if (t === APPROVAL.deny || /^(n|no|deny|reject|3)$/i.test(t)) return { decision: 'deny' };
  return { decision: 'deny', message: t };
}

// The follow-up that retries what a turn's permissions refused, once the user allowed it.
function retryPrompt(items, scoped) {
  const list = items.map((b) => `- ${b.tool}${b.detail ? `: \`${b.detail}\`` : ''}`).join('\n');
  const how = scoped ? 'I allowed exactly these for this follow-up' : 'This follow-up runs in Full auto, so nothing is blocked';
  return `These actions were blocked by your permissions last turn:\n${list}\n\n${how}. Run them now and finish the task.`;
}

export { newId };

// A tool call's output for the transcript: whole when short, else its first and last lines (the
// end of a test run or a build is what tells how it went).
export function clipOutput(text) {
  const out = String(text ?? '').replace(/\s+$/, '');
  if (out.length <= MAX_OUTPUT) return out;
  let head = out.slice(0, 600);
  let tail = out.slice(-1300);
  if (head.includes('\n')) head = head.slice(0, head.lastIndexOf('\n'));
  if (tail.includes('\n')) tail = tail.slice(tail.indexOf('\n') + 1);
  const cut = out.slice(head.length, out.length - tail.length);
  const lines = cut.split('\n').length - 1;
  return `${head}\n… ${lines > 1 ? `${lines} lines` : `${cut.length} characters`} cut …\n${tail}`;
}

// Where the agent actually works: its own worktree when it has one, else the project folder.
export const workdir = (s) => s.worktree?.cwd || s.cwd;

// Where the agent works in the task's other folders (also): their worktrees, else the folders.
export const alsoDirs = (s) => (s.also || []).map((a) => a.worktree?.cwd || a.cwd);

// Worktree sessions get told where they are, so they don't go looking for the main checkout. A task
// with other folders (also) gets their paths: that's where the work in them goes.
function workspaceNote(s) {
  const wt = s.worktree;
  const also = s.also || [];
  const out = [];
  if (wt) out.push(`You are in an isolated git worktree (${wt.path}) on branch \`${wt.branch}\`, created from \`${wt.baseRef}\` for this task only. Other agents may be working in the user's main checkout, so make every change here. Dependencies and build output (node_modules, virtualenvs, dist/) are not shared with the main checkout: install them if a command needs them. Leave your changes uncommitted unless the user asks you to commit; the user ships them from wisp (commit, push, pull request).`);
  if (also.length) {
    const line = (a) => (a.worktree ? `- \`${a.worktree.cwd}\`: a worktree of \`${a.cwd}\` on branch \`${a.worktree.branch}\` (from \`${a.worktree.baseRef}\`). Work here, not in \`${a.cwd}\`.` : `- \`${a.cwd}\``);
    out.push(`This task spans ${also.length + 1} folders. Besides your working directory (${workdir(s)}), you work in:\n${also.map(line).join('\n')}\n\nRead and change files in all of them as the task needs, using absolute paths outside your working directory. Run each folder's commands (tests, builds) from inside that folder.${also.some((a) => a.worktree) ? ' Leave the changes there uncommitted too; Ship it opens a pull request per repo.' : ''}`);
  }
  return out.length ? `\n\n## Workspace\n\n${out.join('\n\n')}` : '';
}

// A follow-up's { agent, model, effort }, or null when it's what the session already runs on.
// Fields left out keep the session's; a new harness without a model gets its default.
function changedRun(session, run) {
  if (!run || typeof run !== 'object') return null;
  const agent = run.agent || session.agent;
  const same = agent === session.agent;
  const next = { agent, model: String(run.model ?? (same ? session.model : '') ?? ''), effort: String(run.effort ?? (same ? session.effort : '') ?? '') };
  return same && next.model === (session.model || '') && next.effort === (session.effort || '') ? null : next;
}

// The lead's roster changes between turns. Members it already used keep their child session (by
// name), so delegating to them again continues their conversation.
function setTeam(session, team) {
  if (team.length) session.subagents = team;
  else delete session.subagents;
  session.children ||= {};
}

function autoTitle(prompt) {
  const line = plainMentions(prompt).trim().split('\n')[0].replace(/\s+/g, ' ');
  return line.length > 64 ? `${line.slice(0, 63)}…` : line;
}

// Delegations to members on another machine that the wisp this task came from runs (upstream),
// still waiting for it to pick them up (services/relay.js).
function relaysOf(s, store) {
  const relays = Object.values(s.children || {})
    .map((cid) => store?.get(cid))
    .filter((c) => c?.relay?.upstream && c.turns.at(-1)?.relay?.state === 'pending')
    .map((c) => ({ child: c.id, turn: c.turns.at(-1).id, machine: c.relay.machine }));
  return relays.length ? { relays } : {};
}

export function summarize(s, store) {
  const project = store?.projectFor(s.cwd);
  const last = s.turns.at(-1);
  const hero = heroOf(last?.presentation);
  const lastAct = last?.activity?.findLast?.((a) => a.kind !== 'text');
  // A lead blocked on its subagents says who it's waiting for.
  const busy = last?.status === 'running' ? (last.delegations || []).filter((d) => store?.get(d.sessionId)?.turns.find((t) => t.id === d.turnId)?.status === 'running') : [];
  const waitingOn = busy.length ? `Waiting on ${[...new Set(busy.map((d) => d.name))].join(', ')}` : '';
  return {
    id: s.id,
    title: s.title,
    agent: s.agent,
    cwd: s.cwd,
    scratch: store?.isScratch?.(s.cwd) || undefined,
    project: s.agent === 'wisp' ? 'tour' : (store?.isScratch?.(s.cwd) ? 'General' : project?.name) || path.basename(s.cwd || ''),
    projectId: project?.id || null,
    color: project?.color || 'slate',
    mode: s.mode,
    model: s.model,
    effort: s.effort || '',
    state: s.state,
    unread: s.unread,
    archived: !!s.archived,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    turnCount: s.turns.length,
    queued: s.queue?.length || 0,
    status: last?.status === 'running' || s.auto?.busy ? 'running' : hero?.status || (last?.status === 'error' ? 'blocked' : 'info'),
    preview: hero?.summary || '',
    live: s.ask ? `Asks: ${s.ask.question}` : last?.status === 'running' ? waitingOn || lastAct?.label || 'Starting up' : s.auto?.busy ? s.auto.label : '',
    term: openTerms.has(s.id) || undefined, // taken over in the page: a terminal is open
    asks: !!s.ask || !!last?.presentation?.blocks?.some((b) => b.type === 'question'),
    question: s.ask?.question || '',
    options: s.ask?.options?.length ? s.ask.options : undefined, // its choices, answered from the row on a phone
    approval: !!s.ask?.permission, // the question is a live approval (Allow / Deny)
    branch: s.worktree?.branch || '',
    // The task's other folders: their project, worktree branch and PR, for the card and the filter.
    ...(s.also?.length && {
      also: s.also.map((a) => {
        const p = store?.projectFor(a.cwd);
        return { cwd: a.cwd, project: p?.name || path.basename(a.cwd), projectId: p?.id || null, color: p?.color || 'slate', branch: a.worktree?.branch || '', pr: a.pr ? { number: a.pr.number, url: a.pr.url, state: a.pr.state, draft: a.pr.draft, review: a.pr.review, checks: a.pr.checks, conflict: !!a.pr.conflict } : null };
      }),
    }),
    toShip: s.toShip || null, // { dirty, ahead, unpushed } of the worktree, null until checked
    // Other open tasks in the same repo changing the same files (services/overlaps.js)
    ...(s.overlaps?.length && !s.archived && ['running', 'waiting', 'review'].includes(s.state) && { overlaps: s.overlaps }),
    shipping: s.shipping || null, // { step: 'start' | 'commit' | 'push' | 'pr', update } while Ship it runs
    pr: s.pr ? { number: s.pr.number, url: s.pr.url, state: s.pr.state, draft: s.pr.draft, review: s.pr.review, checks: s.pr.checks, conflict: !!s.pr.conflict } : null,
    // wisp fixing the PR's merge conflicts on its own: { step: 'fixing' | 'pushing' | 'done' | 'failed', why }
    conflictFix: s.conflictFix ? { step: s.conflictFix.step, why: s.conflictFix.why || '' } : null,
    groupId: s.groupId || null,
    origin: s.origin || null, // { kind: 'recipe' | 'trigger' | 'telegram', id, name }
    ...(s.kind && { kind: s.kind }), // 'spell': a Cast a spell task
    moved: s.moved || null, // { from }: carried on here from another place (services/move.js)
    movedTo: s.movedTo || null, // { id, place }: this one carried on there, and was archived
    // The roster, for the stacked logos on the card: used = delegated to at least once, busy = working now.
    team: (s.subagents || []).flatMap((m) =>
      copies(m).map((name) => {
        // A crew member's jobs are its own tasks: the latest one this lead handed it.
        const child = store?.get(m.crew ? s.turns.flatMap((t) => t.delegations || []).findLast((d) => d.member === m.name)?.sessionId : s.children?.[name]);
        return { name, agent: child?.agent || m.agent, model: m.model, effort: m.effort, used: !!child, busy: child?.state === 'running', ...(m.crew && { crew: m.crew }) };
      }),
    ),
    ...(s.parentId && { parentId: s.parentId, member: s.member }),
    // A crew member's job (server/crew.js): what it was asked (for the member's thread) and the
    // tasks it followed up in.
    ...(s.crew && { crew: { id: s.crew.id, job: s.crew.job, ...(s.crew.from && { from: s.crew.from }), prompt: plainMentions(s.turns[0]?.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 280), ...(s.crew.sent?.length && { sent: s.crew.sent }) } }),
    ...(s.delegated && { delegated: true }), // a delegate's run for a lead on another wisp (services/relay.js), not a task
    ...relaysOf(s, store),
    followups: s.turns.slice(1).filter((t) => t.by !== 'wisp').length, // yours, not Auto's repair rounds
    // Auto's steps after the run: the last test check, repairs, a hand-over, the best-of-2 pick.
    auto: s.auto
      ? {
          strategy: s.auto.strategy,
          busy: !!s.auto.busy,
          stage: s.auto.stage,
          repairs: s.auto.repairs,
          check: s.auto.checks.at(-1) ? (({ verdict, command, passed, failed, newFailures, note }) => ({ verdict, command, passed, failed, newFailures: newFailures?.length || 0, note }))(s.auto.checks.at(-1)) : null,
          escalatedTo: s.auto.escalatedTo || null,
          escalatedFrom: s.auto.escalatedFrom || null,
          reason: s.auto.reason || null, // why it moved on: tests | error | limit
          pick: s.auto.pick && !s.auto.pick.pending ? s.auto.pick : null,
        }
      : null,
    // Auto: what it picked and why, for the card's tooltip.
    route: s.route ? { goal: s.route.goal, type: s.route.type, label: s.route.label, effort: s.route.effort, chance: s.route.chance, n: s.route.n, usd: s.route.usd, explored: s.route.explored, trying: s.route.trying, alternatives: s.route.alternatives, ...(s.route.switched && { switched: true }) } : null,
  };
}

export class Runner extends EventEmitter {
  // bridge: { url, token } — how the injected ask_user MCP server reaches us.
  constructor(store, bridge) {
    super();
    this.store = store;
    this.bridge = bridge;
    this.live = new Map(); // sessionId -> adapter handle
    this.stopping = new Set();
    this.interrupting = new Set();
    this.handing = new Set(); // ids whose run ended with a follow-up waiting to start: they stay in Working
    this.deleting = new Set(); // ids being deleted: their run ends quietly, no card back in Needs you, no "ready"
    this.answers = new Map(); // askId -> answer, until the MCP server picks it up
    this.sides = new Map(); // /btw id -> { sessionId, handle }: side questions being answered
    this.promptExtra = () => ''; // (session) => text appended to the system prompt (learned preferences)
    this.spellBlocks = () => []; // (session) => block types spells add, for the protocol
    this.routeAuto = null; // (prompt, { cwd }) => { agent, model, route } for subagents set to Auto
    // The crew (server/crew.js): a job's note in its system prompt, what its turn hands back
    // ({ quiet }), and a lead's delegation to a member (a job of its own, made by the crew).
    this.crewNote = () => '';
    this.crewTurn = () => ({});
    this.crewDelegate = null;
    this.crewChild = () => null; // a member's job on another machine, as last fetched (id → session)
    this.pipeline = null; // Auto's check / repair / hand-over steps (server/pipeline.js)

    // Anything that was mid-flight when wisp last died is now orphaned.
    for (const s of store.all()) {
      const t = s.turns.at(-1);
      delete s.ask;
      if (s.auto?.busy) Object.assign(s.auto, { busy: false, stage: 'cancelled', label: '' }); // Auto's step died with wisp
      if (s.state === 'running' || s.state === 'waiting' || t?.status === 'running') {
        if (t?.status === 'running') this.#finishTurn(s, t, { isError: true, stopped: true, text: '' }, 'wisp was restarted while this was running.');
        s.state = 'review';
        store.save(s);
      }
      const asked = s.turns.flatMap((x) => x.btw || []).filter((b) => b.status === 'running');
      for (const b of asked) Object.assign(b, { status: 'error', error: 'wisp was restarted before this was answered.' });
      if (asked.length) store.save(s);
    }
  }

  // subagents: the team a lead may delegate to. parentId/member: this session is one of them.
  // also: the task's other folders, [{ cwd, worktree }] (services/launch.js).
  // history / title / moved: a task moved here from another place, with the turns it had there.
  create({ id = newId(), prompt, cwd, also = [], agent = 'claude', mode = 'auto', model = '', effort = '', attachments = [], worktree = null, groupId = null, origin = null, subagents = [], parentId = null, member = '', route = null, auto = null, scout = null, history = [], title = '', moved = null, kind = '', relay = null, delegated = null, crew = null }) {
    if (!adapters[agent] && !(relay && agent === 'auto')) throw new Error(`Unknown agent: ${agent}`);
    const now = Date.now();
    const session = {
      id,
      title: title || autoTitle(prompt),
      titleAuto: !title,
      agent,
      cwd,
      mode,
      model,
      effort,
      state: 'running',
      unread: false,
      createdAt: now,
      updatedAt: now,
      agentSessionId: null,
      agentSessions: {}, // harness -> its own conversation id, so switching back resumes it
      queue: [],
      turns: [...history],
      ...(moved && { moved }),
      ...(kind && { kind }), // 'spell': a Cast a spell task (server/spell-guide.js)
      ...(worktree && { worktree }),
      ...(also.length && { also }),
      ...(groupId && { groupId }),
      ...(origin && { origin }),
      ...(subagents.length && { subagents, children: {} }),
      ...(auto && { auto: { strategy: 'single', busy: false, stage: '', label: '', repairs: 0, checks: [], ...auto } }), // server/pipeline.js
      ...(scout && { scout }), // what the scout found before it started (server/scout.js)
      ...(parentId && { parentId, member }),
      ...(relay && { relay }), // a member on another machine: { machine, place, upstream? } (services/relay.js)
      ...(delegated && { delegated }), // a delegate's run for a lead elsewhere: { lead, name }
      ...(crew && { crew }), // a crew member's job: { id, job, from?, reply? } (server/crew.js)
      ...(route && { route }), // how Auto picked agent, model and level (server/router.js)
    };
    this.store.put(session);
    if (!parentId && !delegated) for (const dir of [...also.map((a) => a.cwd), cwd]) this.store.touchProject(dir); // a subagent's cwd may be the lead's worktree
    this.#startTurn(session, prompt, attachments);
    return session;
  }

  // mode: switch the permission mode (plan / edits / auto) from this follow-up on. A queued
  // follow-up keeps its own, so the run before it isn't affected. run: { agent, model, effort }
  // switches the harness, model and thinking level the same way (see #switchRun).
  // grants / once: a retry of what the last turn's permissions blocked (see approveBlocked).
  // by: 'wisp' for a follow-up wisp sends itself (Auto's repair round). Anything else is the
  // user's, and cancels whatever Auto was about to do next.
  // team: a new roster of subagents (normalized; [] drops them) for this follow-up and the ones after it.
  reply(session, text, attachments = [], { queue = false, mode, run, team, grants, once, by } = {}) {
    if (!MODES.has(mode) || mode === session.mode) mode = undefined;
    run = changedRun(session, run);
    if (session.parentId || (team && JSON.stringify(team) === JSON.stringify(session.subagents || []))) team = undefined;
    if (by !== 'wisp') this.pipeline?.cancel(session);
    const extra = { ...(mode && { mode }), ...(run && { run }), ...(team && { team }), ...(grants?.length && { grants }), ...(MODES.has(once) && { once }), ...(by === 'wisp' && { by }) };
    if (session.ask && !Object.keys(extra).length) {
      this.answer(session, text);
      return { answered: true };
    }
    const handle = this.live.get(session.id);
    if (handle) {
      const turn = session.turns.at(-1);
      // The run already produced its result and the CLI is only lingering on its way out:
      // there's nothing to wait for, so let it go and start the follow-up now.
      if (turn?.status !== 'running') {
        session.queue.push({ id: newId(), text, attachments, ...extra });
        handle.release();
        return { queued: session.queue.length > 0 };
      }
      // Interrupting needs an agent session to resume; before the agent reports one, queue.
      if (queue || !session.agentSessionId) {
        session.queue.push({ id: newId(), text, attachments, ...extra });
        this.#touch(session);
        return { queued: true, ahead: session.queue.length - 1 };
      }
      // Ahead of anything queued, but after earlier interrupting follow-ups, so they keep their order.
      const at = session.queue.findIndex((q) => !q.now);
      session.queue.splice(at < 0 ? session.queue.length : at, 0, { id: newId(), text, attachments, now: true, ...extra });
      this.#interrupt(session);
      return { interrupted: true };
    }
    if (mode) session.mode = mode;
    if (run) this.#switchRun(session, run);
    if (team) setTeam(session, team);
    this.#startTurn(session, text, attachments, extra);
    return { queued: false };
  }

  // The card under a turn whose permissions refused something: allow retries it as a follow-up,
  // with exactly those actions allowed where the harness can scope a grant, else in Full auto for
  // that one follow-up. Deny just closes the card.
  approveBlocked(session, { turnId, allow }) {
    const turn = turnId ? session.turns.find((t) => t.id === turnId) : session.turns.at(-1);
    if (!turn?.blocked?.length) throw bad('Nothing on that turn is waiting for approval.', 404);
    if (turn.approval) throw bad(`Already ${turn.approval}.`, 409);
    // A CLI still lingering after its result doesn't count: reply() lets it go and starts the retry.
    if (turn !== session.turns.at(-1) || (this.live.has(session.id) && turn.status === 'running')) throw bad('The task has moved on since; send a follow-up instead.', 409);
    turn.approval = allow ? 'allowed' : 'denied';
    if (!allow) {
      this.#touch(session, { turn: turn.id });
      return { denied: true };
    }
    const scoped = turn.blocked.every((b) => b.rule !== undefined);
    const out = this.reply(session, retryPrompt(turn.blocked, scoped), [], scoped ? { grants: turn.blocked.map((b) => b.rule) } : { once: 'auto' });
    this.#touch(session, { turn: turn.id });
    return { ...out, scoped };
  }

  // A follow-up on another harness, model or thinking level. A model or level change resumes the
  // same conversation; a harness change resumes that harness's own one (if it ran earlier in this
  // task) or starts it fresh, and #startTurn hands it the turns it missed.
  #switchRun(session, { agent, model, effort }) {
    session.agentSessions ||= {};
    // Sessions from before agentSessions: their conversation belongs to the harness they ran on.
    if (session.agentSessionId) session.agentSessions[session.agent] = session.agentSessionId;
    for (const t of session.turns) t.agent ||= session.agent;
    // Auto's pick was overruled: the card stops crediting it, and the router learns (services/auto.js).
    if (session.route && (agent !== session.agent || model !== session.model || effort !== (session.effort || ''))) session.route.switched = true;
    if (agent !== session.agent) {
      session.agent = agent;
      session.agentSessionId = session.agentSessions[agent] || null;
    }
    session.model = model;
    session.effort = effort;
  }

  // Drop a follow-up that hasn't gone out yet.
  unqueue(session, itemId) {
    const at = session.queue.findIndex((q) => q.id === itemId);
    if (at < 0) return false;
    session.queue.splice(at, 1);
    this.#touch(session);
    return true;
  }

  // /btw: a side question, answered by a read-only run of its own while the task's run carries on
  // (server/btw.js). It lands on the latest turn and never reaches the task's conversation.
  btw(session, question, attachments = []) {
    const turn = session.turns.at(-1);
    if (!turn) throw bad('Nothing to ask about yet.', 409);
    if ([...this.sides.values()].filter((x) => x.sessionId === session.id).length >= MAX_BTW) throw bad(`${MAX_BTW} side questions are still being answered. Ask again once one is in.`, 429);
    const entry = {
      id: newId(),
      question,
      status: 'running',
      askedAt: Date.now(),
      agent: session.agent,
      model: session.model || '',
      ...(attachments.length && { attachments: attachments.map(({ id, name, mime, size }) => ({ id, name, mime, size })) }),
    };
    (turn.btw ||= []).push(entry);
    this.#sideRun(session, turn, entry, attachments, !!adapters[session.agent]?.fork && !!session.agentSessionId);
    this.#btwChanged(session, turn);
    return entry;
  }

  // forked: on a copy of the agent's conversation, so it knows what the run did and why. A fork
  // that fails (a CLI too old to fork) asks again with wisp's record of the task instead.
  #sideRun(session, turn, entry, attachments, forked) {
    const adapter = adapters[entry.agent];
    const name = (t) => adapters[t.agent || session.agent]?.name || t.agent || session.agent;
    const question = agentPrompt(entry.question, this.store, { tool: null, self: session.id });
    entry.forked = forked;
    let reply = null;
    let handle;
    try {
      handle = adapter.run({
        prompt: btwPrompt(session, question, { forked, name }),
        attachments,
        cwd: workdir(session),
        dirs: alsoDirs(session),
        resumeId: forked ? session.agentSessionId : null,
        fork: forked,
        mode: 'plan',
        model: entry.model,
        effort: session.effort || '',
        systemPrompt: BTW_SYSTEM,
        onEvent: (ev) => {
          if (ev.type === 'result') reply = ev;
        },
      });
    } catch (err) {
      reply = { isError: true, text: err.message };
      handle = { done: Promise.resolve(), stop() {} };
    }
    const side = { sessionId: session.id, handle, timedOut: false };
    this.sides.set(entry.id, side);
    const timer = setTimeout(() => ((side.timedOut = true), handle.stop()), BTW_TIMEOUT_MS);
    handle.done.then(() => {
      clearTimeout(timer);
      if (this.sides.get(entry.id) !== side) return; // dismissed, or the task was deleted
      this.sides.delete(entry.id);
      const ok = reply && !reply.isError && !reply.stopped;
      if (!ok && forked && !side.timedOut) return this.#sideRun(session, turn, entry, attachments, false);
      if (ok) Object.assign(entry, { status: 'done', answer: btwAnswer(reply.text), ...(reply.stats?.costUsd && { costUsd: reply.stats.costUsd }) });
      else Object.assign(entry, { status: 'error', error: side.timedOut ? `No answer after ${BTW_TIMEOUT_MS / 60_000} minutes.` : clip(reply?.text || 'The side run ended without an answer.', 400) });
      entry.answeredAt = Date.now();
      this.#btwChanged(session, turn);
    });
  }

  // Dismiss a side question, stopping its run if it's still going.
  dropBtw(session, id) {
    const turn = session.turns.find((t) => t.btw?.some((b) => b.id === id));
    if (!turn) return false;
    turn.btw = turn.btw.filter((b) => b.id !== id);
    if (!turn.btw.length) delete turn.btw;
    this.sides.get(id)?.handle.stop();
    this.sides.delete(id);
    this.#btwChanged(session, turn);
    return true;
  }

  // The task is going away: its side questions stop too.
  stopSides(session) {
    for (const [id, side] of this.sides) {
      if (side.sessionId !== session.id) continue;
      this.sides.delete(id);
      side.handle.stop();
    }
  }

  // A side entry changed (a /btw answer, or a crew member's answer to an @mention: server/crew.js).
  sideChanged(session, turn) {
    this.#btwChanged(session, turn);
  }

  // A side question changed: the card repaints it in place. The task's own state is untouched.
  #btwChanged(session, turn) {
    this.store.save(session);
    this.emit('turn', { sessionId: session.id, turnId: turn.id });
  }

  // ask_user: the agent is blocked inside a tool call until answer() is called.
  // permission: set for a live approval ({ tool, action, detail }), see requestApproval().
  ask(session, { question, context, options, permission }) {
    const turn = session.turns.at(-1);
    session.ask = {
      id: newId(),
      question: String(question || '').trim() || 'The agent has a question.',
      context: context ? String(context) : '',
      options: Array.isArray(options) ? options.map(String).slice(0, 6) : [],
      askedAt: Date.now(),
      ...(permission && { permission }),
    };
    session.state = 'waiting';
    session.unread = true;
    delete session.archived; // a question needs the user, so it comes back to the feed
    const label = permission ? `Needs your OK to ${permission.action}` : `Asked you: ${session.ask.question}`;
    if (turn) this.#onEvent(session, turn, { type: 'tool', kind: 'ask', label });
    this.#touch(session, { turn: turn?.id });
    this.emit('finished', { session: summarize(session, this.store) });
    return session.ask.id;
  }

  // Live approval: the harness asks before a tool call its permission mode doesn't allow on its
  // own (Claude's --permission-prompt-tool). It waits on the answer like ask_user; something the
  // user said "always" to earlier in this task goes through at once.
  requestApproval(session, { tool, input }) {
    const adapter = adapters[session.agent];
    const p = adapter.permission?.(String(tool || ''), input && typeof input === 'object' ? input : {}, workdir(session)) || { tool: String(tool || 'tool'), action: `use ${tool}`, detail: '' };
    const turn = session.turns.at(-1);
    if ((session.grants || []).some((g) => sameAction(g, p))) {
      if (turn) this.#onEvent(session, turn, { type: 'tool', kind: 'answer', label: `Allowed (always in this task): ${p.action}` });
      return { decision: 'allow' };
    }
    const id = this.ask(session, {
      question: `Allow ${adapter.name} to ${p.action}?`,
      context: p.why || '',
      options: [APPROVAL.allow, APPROVAL.always, APPROVAL.deny],
      permission: { tool: p.tool, action: p.action, detail: p.detail },
    });
    return { id };
  }

  answer(session, text) {
    const ask = session.ask;
    if (!ask) return false;
    ask.answer = text;
    const turn = session.turns.at(-1);
    let label = `You answered: ${text}`;
    if (ask.permission) {
      const d = approvalDecision(text);
      this.answers.set(ask.id, { answer: text, ...d });
      const p = ask.permission;
      if (d.always) (session.grants ||= []).push({ tool: p.tool, detail: p.detail });
      // Denied here, so the turn's "blocked" card shouldn't offer it again.
      if (d.decision === 'deny' && turn) (turn.denied ||= []).push({ tool: p.tool, detail: p.detail });
      label = d.decision === 'allow' ? `You allowed${d.always ? ' (always in this task)' : ''}: ${p.action}` : `You denied: ${p.action}${d.message ? ` (“${d.message}”)` : ''}`;
    } else this.answers.set(ask.id, { answer: text });
    delete session.ask;
    session.state = this.live.has(session.id) ? 'running' : 'review';
    if (turn) this.#onEvent(session, turn, { type: 'tool', kind: 'answer', label });
    this.#touch(session, { turn: turn?.id });
    return true;
  }

  // { answer } once answered (plus { decision, message? } for an approval), { pending }, or { cancelled }.
  pollAnswer(askId) {
    if (this.answers.has(askId)) {
      const out = this.answers.get(askId);
      this.answers.delete(askId);
      return out;
    }
    const open = this.store.all().some((s) => s.ask?.id === askId);
    return open ? { pending: true } : { cancelled: true };
  }

  // delegate: the lead hands tasks to members of its team. Each member is one child session,
  // created on first use and resumed after that. Returns one record (or { error }) per task.
  async delegate(lead, tasks) {
    const turn = lead.turns.at(-1);
    if (turn?.status !== 'running') throw bad('The lead agent is not running.', 409);
    const team = lead.subagents || [];
    if (!team.length) throw bad('This session has no subagents. The user can add them when launching.');
    const out = [];
    const claimed = new Set(); // copies handed a task in this call
    const busy = (name) => claimed.has(name) || this.live.has(lead.children?.[name]);
    for (const task of Array.isArray(tasks) ? tasks.slice(0, 12) : []) {
      const want = String(task?.subagent || '').trim();
      const m = team.find((x) => x.name === want || copies(x).includes(want));
      const prompt = String(task?.prompt || '').trim();
      if (!m) {
        out.push({ subagent: want, error: `No subagent named "${want}". The team: ${team.map((x) => x.name).join(', ')}.` });
        continue;
      }
      if (!prompt) {
        out.push({ subagent: want, error: 'The task prompt is empty.' });
        continue;
      }
      // A member name goes to its first free copy; a copy name (codex#2) to that copy.
      const slot = (want === m.name ? copies(m) : [want]).find((n) => !busy(n));
      if (!slot) {
        out.push({ subagent: want, error: `${want} is still working${m.count > 1 && want === m.name ? ` (all ${m.count} copies)` : ''} on earlier tasks. Wait with subagent_results, then delegate again.` });
        continue;
      }
      claimed.add(slot);
      // A crew member: the crew starts a job for it, in its own folder, that the user sees.
      if (m.crew) {
        const job = await Promise.resolve(this.crewDelegate?.(lead, m, prompt) ?? { error: 'The crew is not available.' }).catch((err) => ({ error: err.message }));
        if (job.error) {
          out.push({ subagent: want, error: job.error });
          continue;
        }
        const d = { id: newId(), name: slot, member: m.name, crew: m.crew, agent: job.agent, model: job.model, effort: job.effort, sessionId: job.id, turnId: job.turns.at(-1).id, prompt, startedAt: Date.now() };
        (turn.delegations ||= []).push(d);
        out.push(d);
        continue;
      }
      let child = this.store.get(lead.children?.[slot]);
      // A member on another machine: the wisp that reaches it runs it there (services/relay.js).
      const relay = m.machine ? { machine: m.machine, place: m.place || '', ...(m.upstream && { upstream: true }) } : null;
      if (child && (relay || adapters[child.agent])) {
        child.cwd = workdir(lead); // follows the lead if its worktree moved
        child.mode = lead.mode; // and its mode, if a follow-up switched it
        if (relay) child.relay = relay; // the member may have moved between turns
        else delete child.relay;
        this.#startTurn(child, prompt);
      } else {
        // An Auto member is routed on its first task and keeps that pick, so later tasks resume it.
        // One on another machine is routed there, with the harnesses that machine has.
        const pick = m.agent === 'auto' && !relay ? this.routeAuto?.(prompt, { cwd: workdir(lead) }) : null;
        if (m.agent === 'auto' && !relay && !pick) {
          out.push({ subagent: want, error: 'Auto found no harness to run this on.' });
          continue;
        }
        const run = pick ? { agent: pick.agent, model: pick.model, effort: pick.effort || '', route: pick.route } : { agent: m.agent, model: m.model, effort: m.effort };
        child = this.create({ prompt, cwd: workdir(lead), ...run, mode: lead.mode, parentId: lead.id, member: slot, relay });
        (lead.children ||= {})[slot] = child.id;
      }
      const d = { id: newId(), name: slot, member: m.name, agent: child.agent, model: child.model, effort: child.effort, ...(relay && { place: relay.place }), sessionId: child.id, turnId: child.turns.at(-1).id, prompt, startedAt: Date.now(), owed: true }; // owed until the lead has its report
      (turn.delegations ||= []).push(d);
      out.push(d);
    }
    const sent = out.filter((d) => !d.error);
    if (sent.length) this.#onEvent(lead, turn, { type: 'tool', kind: 'agent', label: `Delegated to ${[...new Set(sent.map((d) => d.name))].join(', ')}` });
    this.#touch(lead, { turn: turn.id });
    return out;
  }

  // A relayed member's live line (services/relay.js): what its run over there is doing.
  relayed(child, turn, { kind = 'agent', label }) {
    this.#onEvent(child, turn, { type: 'tool', kind: String(kind).slice(0, 20), label: String(label).slice(0, 200) });
  }

  // A relayed member's run ended over there: its report, edits (already applied to the lead's
  // folder when applied.applied) and what ran, as this turn's.
  relayDone(child, turn, { status, presentation, stats, changes = [], agent, model, effort, error, applied = {}, kept }) {
    if (turn.status !== 'running') return;
    if (agent && adapters[agent]) Object.assign(child, { agent, model: String(model || ''), effort: String(effort || '') });
    Object.assign(turn, { agent: child.agent, model: child.model, effort: child.effort || '' });
    turn.relay.state = 'done';
    if (applied.applied || kept) for (const c of Array.isArray(changes) ? changes.slice(0, 500) : []) if (c?.file) this.#onEvent(child, turn, { type: 'change', file: String(c.file), op: /^\w{1,12}$/.test(c.op || '') ? c.op : 'edit', edits: Array.isArray(c.edits) ? c.edits : [] });
    const place = child.relay?.place || 'the other machine';
    const note = error
      ? null
      : applied.conflicts?.length
        ? { type: 'callout', tone: 'warn', title: 'Applied with conflicts', text: `Its changes from ${place} clashed with edits made meanwhile. Conflict markers are left in: ${applied.conflicts.join(', ')}.` }
        : applied.error
          ? { type: 'callout', tone: 'danger', title: 'Changes not applied', text: `Its changes from ${place} didn’t apply to the lead’s folder (${applied.error}). The patch is saved at ${applied.file}.` }
          : kept
            ? { type: 'callout', tone: 'info', title: `Changes stayed on ${place}`, text: 'The folder isn’t a git repo, so its changes couldn’t be brought back.' }
            : null;
    const blocks = presentation?.blocks?.length
      ? [...presentation.blocks]
      : [{ type: 'hero', title: 'Something went wrong', summary: error || 'The run on the other machine ended without a report.', status: 'blocked' }];
    if (note) blocks.splice(blocks[0]?.type === 'hero' ? 1 : 0, 0, note);
    turn.presentation = { ...(presentation || {}), blocks };
    turn.stats = stats || null;
    turn.endedAt = Date.now();
    turn.status = error ? 'error' : ['done', 'error', 'stopped'].includes(status) ? status : 'error';
    child.state = 'review';
    child.unread = false;
    this.store.save(child, { now: true });
    this.#touch(child, { turn: turn.id });
    this.#touchLead(child);
    this.#delegateDone(child, turn);
  }

  // Delegations by id (any turn), or the current turn's when ids is empty, with their child sessions.
  delegations(lead, ids = []) {
    const all = lead.turns.flatMap((t) => t.delegations || []);
    const list = ids.length ? all.filter((d) => ids.includes(d.id)) : lead.turns.at(-1)?.delegations || [];
    return list.map((d) => ({ d, child: this.store.get(d.sessionId) || this.crewChild(d.sessionId) }));
  }

  // A delegate's run ended. A lead still running collects the report itself (subagent_results, or
  // #reportBack when its turn ends); one whose turn already ended gets it as a follow-up now.
  // A stopped run owes nothing: the user stopped it, or the lead with it.
  #delegateDone(child, turn) {
    const lead = this.store.get(child.parentId);
    const d = lead?.turns.at(-1)?.delegations?.find((x) => x.owed && x.turnId === turn.id);
    if (!d) return;
    if (turn.status === 'stopped') delete d.owed;
    else if (lead.turns.at(-1).status !== 'running') this.#reportBack(lead);
  }

  // Sends the lead the reports of its finished delegations that it hasn't read, as one follow-up
  // from wisp (merged into one still waiting in its queue). Returns whether it sent any.
  // ending: called from the lead's own #finishTurn, whose run lets go and starts the queue itself.
  #reportBack(lead, { ending = false } = {}) {
    if (this.deleting.has(lead.id)) return false;
    const done = (lead.turns.at(-1)?.delegations || []).filter((d) => d.owed && this.store.get(d.sessionId)?.turns.find((t) => t.id === d.turnId)?.status !== 'running');
    if (!done.length) return false;
    for (const d of done) delete d.owed;
    const reports = done.map((d) => delegationReport(d, this.store.get(d.sessionId), adapters)).join('\n\n---\n\n');
    const waiting = lead.queue.find((q) => q.reports);
    if (waiting) waiting.text += `\n\n---\n\n${reports}`;
    else if (ending || this.live.has(lead.id)) lead.queue.push({ id: newId(), text: `${REPORTS_BACK}\n\n${reports}`, attachments: [], by: 'wisp', reports: true });
    else this.#startTurn(lead, `${REPORTS_BACK}\n\n${reports}`, [], { by: 'wisp', reports: true });
    // A CLI only lingering after its result: let it go so the follow-up starts now.
    if (!ending && this.live.has(lead.id)) this.live.get(lead.id).release();
    this.#touch(lead);
    return true;
  }

  // A session's own fields changed outside a run (a crew job's follow-ups): save it and send its summary.
  refresh(session) {
    this.#touch(session);
  }

  // A crew job on another machine ended (server/crew.js): the lead that delegated it re-renders.
  touchLead(leadId, childId) {
    const lead = this.store.get(leadId);
    const turn = lead?.turns.findLast((t) => t.delegations?.some((d) => d.sessionId === childId));
    if (turn) this.#touch(lead, { turn: turn.id });
  }

  // A child's state changed: the lead's card shows it, so the lead's turn re-renders too.
  #touchLead(child) {
    const lead = (child.parentId || child.crew?.from?.id) && this.store.get(child.parentId || child.crew.from.id);
    if (!lead) return;
    const turn = lead.turns.findLast((t) => t.delegations?.some((d) => d.sessionId === child.id)) || lead.turns.at(-1);
    this.#touch(lead, { turn: turn?.id });
  }

  stop(session) {
    this.pipeline?.cancel(session);
    session.queue = [];
    delete session.ask;
    for (const cid of Object.values(session.children || {})) {
      const child = this.store.get(cid);
      if (child) this.stop(child);
    }
    // A member on another machine: its turn ends here, and the relay stops the run over there.
    const last = session.turns.at(-1);
    if (session.relay && last?.status === 'running') this.#finishTurn(session, last, { stopped: true, text: '' });
    if (!this.live.has(session.id)) return;
    this.stopping.add(session.id);
    this.live.get(session.id).stop();
  }

  // Whether a run still works on the session. A CLI only lingering after its result (up to
  // LINGER_MS) is let go here: the task already shows as done, so Ship it and undo don't wait on it.
  working(session) {
    const handle = this.live.get(session.id);
    if (!handle) return false;
    if (session.turns.at(-1)?.status === 'running' || session.queue.length) return true;
    handle.release();
    return this.live.has(session.id);
  }

  // Stop the current run but keep the queue: done.finally() starts the next follow-up.
  #interrupt(session) {
    if (this.interrupting.has(session.id)) return; // already on its way down
    this.interrupting.add(session.id);
    this.stopping.add(session.id);
    this.live.get(session.id).stop();
  }

  // The record of a new turn, with the checkpoint taken before the agent touches anything.
  #newTurn(session, prompt, attachments, mode = session.mode) {
    const id = newId();
    // A subagent's edits land in the lead's turn, whose checkpoint already covers them.
    const checkpoint =
      session.agent === 'wisp' || session.parentId
        ? null
        : !session.turns.length && session.worktree?.head
          ? freshCheckpoint(session.worktree)
          : captureCheckpoint(workdir(session), session.id, id);
    return {
      id,
      prompt,
      agent: session.agent,
      model: session.model,
      effort: session.effort || '',
      mode,
      attachments: attachments.map(({ id, name, mime, size }) => ({ id, name, mime, size })),
      startedAt: Date.now(),
      endedAt: null,
      status: 'running',
      checkpoint,
      activity: [],
      changes: [],
      presentation: null,
      stats: null,
    };
  }

  // The wisp protocol for this run: a lead hears about its team, a subagent that it can't ask.
  #systemPrompt(session, adapter, team) {
    const sub = session.parentId || session.delegated; // a delegate here, or one for a lead on another wisp
    const extraBlocks = sub ? [] : this.spellBlocks(session);
    const base = sub
      ? systemPrompt({ ask: SUBAGENT_ASK })
      : systemPrompt({ askTool: adapter.askTool, extraBlocks, apps: this.store.config?.defaults?.apps !== 'off' }) + teamNote(team, adapters, delegateTool(adapter.askTool ?? 'mcp__wisp__ask_user'));
    const spell = session.kind === 'spell' ? spellGuide(adapter.askTool ?? 'mcp__wisp__ask_user') : '';
    const crew = session.crew ? this.crewNote(session) : '';
    return base + spell + crew + workspaceNote(session) + this.promptExtra(session);
  }

  // wisp's own MCP server (ask_user, delegate), for harnesses that take one. Subagents get none.
  #mcpServers(session, adapter, team) {
    if (!this.bridge || adapter.askTool === null || session.parentId || session.delegated) return {};
    return {
      wisp: {
        command: process.execPath,
        args: [ASK_SERVER],
        // Inside the desktop app execPath is the Electron binary; without
        // ELECTRON_RUN_AS_NODE it boots a second app (extra Dock icon) per turn.
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          WISP_URL: this.bridge.url,
          WISP_TOKEN: this.bridge.token,
          WISP_SESSION: session.id,
          WISP_TURN: session.turns.at(-1)?.id || '', // so a run's leftover helper can tell its turn is over
          ...(adapter.approveTool && { WISP_APPROVE: '1' }),
          ...(session.kind === 'spell' && { WISP_SPELLS: '1' }),
          ...(team.length && { WISP_TEAM: JSON.stringify(team.map((m) => ({ name: m.name, agent: m.crew ? `${m.label || m.name} of the user's crew${m.role ? `, ${m.role}` : ''}` : adapters[m.agent]?.name || m.agent, model: m.crew ? 'own folder and memory' : m.model, effort: m.effort, use: m.use, count: m.count || 1, copies: copies(m), ...(m.machine && { place: m.place || 'another machine' }) }))) }),
        },
      },
    };
  }

  // grants: harness rules allowing what the user approved, for this turn only. once: a mode for
  // this turn only (an approved retry the harness can't scope runs in Full auto).
  #startTurn(session, prompt, attachments = [], { grants = [], once, by, reports } = {}) {
    const mode = MODES.has(once) ? once : session.mode;
    const turn = this.#newTurn(session, prompt, attachments, mode);
    if (session.relay) turn.relay = { state: 'pending' }; // until the relay picks it up
    if (by === 'wisp') turn.by = 'wisp'; // sent by wisp (Auto's repair round), not by you
    if (reports) turn.reports = true; // ...with the reports of delegates that finished after the lead's turn
    // Side questions still being answered move to the new turn: the old one folds away on the card.
    const prev = session.turns.at(-1);
    // A crew member's follow-up brings its thread along, so its answer stays above what it asked for.
    const byCrew = /^@\[[^\]\n]{1,200}\]\(crew:[a-z0-9]{6,40}\)/.test(prompt);
    const open = prev?.btw?.filter((b) => b.status === 'running' || (byCrew && b.crew)) || [];
    if (open.length) {
      prev.btw = prev.btw.filter((b) => !open.includes(b));
      if (!prev.btw.length) delete prev.btw;
      turn.btw = open;
    }
    // Delegations whose report the lead hasn't had (a follow-up interrupted it) move too: the new
    // turn waits on them, subagent_results finds them, and their edits count on it.
    const owed = (!session.parentId && prev?.delegations?.filter((d) => d.owed)) || [];
    if (owed.length) {
      prev.delegations = prev.delegations.filter((d) => !d.owed);
      if (!prev.delegations.length) delete prev.delegations;
      turn.delegations = owed;
    }
    session.turns.push(turn);
    session.state = 'running';
    session.unread = false;
    delete session.archived;
    this.#touch(session, { turn: turn.id });
    this.#touchLead(session);
    this.emit('started', { session, turn });
    // A member on another machine runs over there: the relay carries it (services/relay.js).
    if (session.relay) {
      if (!session.relay.upstream) this.emit('relay', { session, turn });
      return;
    }

    let released = false;
    let linger;
    const adapter = adapters[session.agent];
    // Leads get the delegate tool next to ask_user; subagents get neither (nobody to ask).
    const team = adapter.askTool !== null && !session.delegated ? session.subagents || [] : [];
    // A harness that hasn't seen every earlier turn (the user switched to it) gets them first.
    const handoff = session.parentId ? '' : handoffNote(session, session.agent, session.agentSessionId, (t) => adapters[t.agent]?.name || t.agent);
    // Mentioned tasks: a lead reads them with wisp_session; a run without wisp's tools gets their reports.
    const tools = !session.parentId && !session.delegated && adapter.askTool !== null && this.bridge;
    const text = agentPrompt(prompt, this.store, { tool: tools ? (adapter.askTool ?? 'mcp__wisp__ask_user').replace(/ask_user$/, 'wisp_session') : null, self: session.id });
    const still = owed.length && team.length && this.bridge ? stillWorkingNote(owed) : '';
    const handle = adapter.run({
      prompt: [handoff, still, text].filter(Boolean).join('\n\n'),
      attachments,
      cwd: workdir(session),
      dirs: alsoDirs((session.parentId && this.store.get(session.parentId)) || session), // the task's other folders (a subagent's are its lead's)
      resumeId: session.agentSessionId,
      mode,
      grants,
      model: session.model,
      effort: session.effort || '',
      systemPrompt: this.#systemPrompt(session, adapter, team),
      // A lead with a team delegates through wisp, so the harness's own subagent tool is switched off.
      delegating: team.length > 0 && !!this.bridge,
      mcpServers: this.#mcpServers(session, adapter, team),
      onEvent: (ev) => {
        if (released) return; // a lingering process we already let go of
        const waiting = this.#onEvent(session, turn, ev) === 'waiting';
        // A CLI can outlive its result (flushing, or a background process it spawned holding
        // stdout open, so 'close' never fires). Don't hold the session hostage to that. A result
        // that left background tasks running gets up to BACKGROUND_MAX_MS for its next one.
        if (ev.type === 'result') {
          clearTimeout(linger);
          linger = setTimeout(release, waiting ? BACKGROUND_MAX_MS : LINGER_MS);
        }
      },
    });
    // Ends the run exactly once: on exit, LINGER_MS after the result, or when a follow-up arrives.
    const release = () => {
      if (released) return;
      // Gone while waiting on background work (stopped, interrupted, or it died): the result it
      // gave before waiting is the best we have.
      if (turn.status === 'running') this.#finishTurn(session, turn, turn.interim || { isError: true, text: 'The agent exited without a result.' });
      released = true;
      clearTimeout(linger);
      handle.stop();
      if (this.live.get(session.id) !== handle) return;
      this.live.delete(session.id);
      this.interrupting.delete(session.id);
      this.stopping.delete(session.id); // a stop that landed after the result has nothing left to stop
      const next = session.queue.shift();
      if (next?.mode) session.mode = next.mode;
      if (next?.run && adapters[next.run.agent]) this.#switchRun(session, next.run);
      if (next?.team) setTeam(session, next.team);
      const handed = this.handing.delete(session.id);
      if (next && this.store.get(session.id)) this.#startTurn(session, next.text, next.attachments, next);
      // Kept in Working for a follow-up that was then taken back or stopped: it lands in your queue after all.
      else if (handed) this.settle(session, { quiet: true });
      else this.#touch(session);
    };
    handle.release = release;
    this.live.set(session.id, handle);
    handle.done.finally(release);
  }

  #onEvent(session, turn, ev) {
    switch (ev.type) {
      case 'session':
        session.agentSessionId = ev.id;
        (session.agentSessions ||= {})[session.agent] = ev.id;
        return;
      case 'tool':
      case 'tool_error':
      case 'text': {
        const item = { t: Date.now(), kind: ev.type === 'tool' ? ev.kind : ev.type === 'text' ? 'text' : 'error' };
        if (ev.type === 'tool') {
          Object.assign(item, { label: ev.label, file: ev.file, detail: ev.detail });
          if (ev.id) item.call = String(ev.id); // a tool_output later finds its call by this
          if (ev.output && OUTPUT_KINDS.has(item.kind)) item.output = clipOutput(ev.output);
        } else if (ev.type === 'text') item.label = ev.text.slice(0, MAX_TEXT);
        else item.label = `${ev.name || 'Tool'} failed: ${ev.text}`;
        turn.activity.push(item);
        // The transcript says how many of the oldest steps it no longer has.
        if (turn.activity.length > MAX_ACTIVITY) turn.trimmed = (turn.trimmed || 0) + turn.activity.splice(0, turn.activity.length - MAX_ACTIVITY).length;
        this.emit('activity', { sessionId: session.id, turnId: turn.id, item });
        this.#touch(session, { quiet: ev.type === 'text' });
        return;
      }
      case 'tool_output': {
        // What a call returned, for the transcript: matched to the call by the harness's id.
        const item = ev.id && turn.activity.findLast((a) => a.call === String(ev.id));
        const output = clipOutput(ev.text);
        if (!item || !OUTPUT_KINDS.has(item.kind) || !output.trim()) return;
        item.output = output;
        this.emit('activity', { sessionId: session.id, turnId: turn.id, item, update: true });
        this.store.save(session);
        return;
      }
      case 'change': {
        let entry = turn.changes.find((c) => c.file === ev.file);
        if (!entry) {
          let beforeFile = ev.beforeFile;
          if (turn.checkpoint?.commit && !path.isAbsolute(ev.file)) {
            const fromGit = readGitFile(workdir(session), turn.checkpoint.commit, ev.file);
            if (fromGit !== null) beforeFile = fromGit;
            else if (!(turn.checkpoint.untracked || []).includes(ev.file)) beforeFile = null;
          }
          turn.changes.push((entry = { file: ev.file, op: ev.op, ...(beforeFile !== undefined ? { beforeFile } : {}), edits: [] }));
        }
        if (ev.op === 'create' && entry.edits.length === 0) entry.op = 'create';
        delete entry.reverted;
        const from = entry.edits.length;
        entry.edits.push(...ev.edits);
        // The transcript shows each edit under the call that made it: [from, to) in entry.edits.
        const call = !ev.by && turn.activity.findLast((a) => a.kind === 'edit' && a.file === ev.file);
        if (call) call.edits = [call.edits?.[0] ?? from, entry.edits.length];
        if (ev.by && !entry.by?.includes(ev.by)) (entry.by ||= []).push(ev.by);
        this.store.save(session);
        // A subagent's edits are the lead's too: they show up in its files, diffs and Ship it.
        const lead = session.parentId && this.store.get(session.parentId);
        const leadTurn = lead?.turns.at(-1);
        if (leadTurn?.status === 'running') this.#onEvent(lead, leadTurn, { ...ev, by: session.member });
        return;
      }
      case 'blocked': {
        // A tool call the harness's permissions refused. The card after the turn offers to retry it.
        const item = { tool: String(ev.tool || 'tool'), detail: String(ev.detail ?? ''), ...(ev.rule !== undefined && { rule: ev.rule }) };
        const list = (turn.blocked ||= []);
        if (!list.some((b) => sameAction(b, item))) list.push(item);
        this.store.save(session);
        return;
      }
      case 'background': {
        turn.background = ev.tasks;
        if (turn.interim) this.#waitItem(session, turn);
        else this.store.save(session);
        return;
      }
      case 'result':
        // It ended its turn in plain text with background tasks still running ("I'll report once
        // it's done"): the CLI wakes it up when they finish and it reports again, so the turn stays
        // open. A full presentation is a finished task that left something up (a dev server).
        if (ev.background > 0 && !ev.isError && parsePresentation(ev.text).fallback) {
          turn.interim = { text: ev.text, stats: ev.stats };
          this.#waitItem(session, turn);
          return 'waiting';
        }
        this.#finishTurn(session, turn, ev);
        return;
    }
  }

  // The live line while a turn waits on its background tasks.
  #waitItem(session, turn) {
    const tasks = turn.background || [];
    const label = !tasks.length
      ? 'Background work finished, wrapping up'
      : tasks.length === 1
        ? `Waiting on background task: ${tasks[0]}`
        : `Waiting on ${tasks.length} background tasks`;
    this.#onEvent(session, turn, { type: 'tool', kind: 'background', label: label.slice(0, 200) });
  }

  #finishTurn(session, turn, ev, reason) {
    let crewOut = {};
    turn.endedAt = Date.now();
    delete turn.interim;
    delete turn.background;
    turn.stats = ev.stats || null;
    delete session.ask;
    if (this.stopping.delete(session.id)) ev = { ...ev, stopped: true };
    const interrupted = ev.stopped && this.interrupting.has(session.id);
    if (ev.stopped) {
      turn.status = 'stopped';
      turn.presentation = {
        blocks: [
          interrupted
            ? { type: 'hero', title: 'Interrupted', summary: 'You sent a follow-up while this was running, so it picked that up instead.', status: 'partial' }
            : { type: 'hero', title: 'Stopped', summary: reason || 'You stopped this run. Follow up to pick it back up.', status: 'partial' },
          ...(turn.changes.length ? [{ type: 'files', items: turn.changes.map((c) => ({ path: c.file, change: c.op === 'create' ? 'added' : 'modified' })) }] : []),
        ],
      };
    } else if (ev.isError) {
      turn.status = 'error';
      turn.presentation = {
        blocks: [
          { type: 'hero', title: 'Something went wrong', summary: 'The agent run ended with an error.', status: 'blocked' },
          { type: 'terminal', command: `${session.agent} run`, output: ev.text || 'No output.', exitCode: 1 },
          { type: 'next', items: ['Try again', 'Explain what went wrong'] },
        ],
      };
    } else {
      turn.status = 'done';
      turn.raw = ev.text; // kept so the turn can be re-parsed if the parser improves
      turn.presentation = parsePresentation(ev.text);
      if (session.crew) crewOut = this.crewTurn(session, turn) || {}; // its memory comes out of the report
      this.store.keepImages(session, turn);
      this.store.keepDocs?.(session, turn);
      const hero = heroOf(turn.presentation);
      // Compare runs keep the prompt's title: they're one task, and one run's headline shouldn't name it.
      if (hero?.title && session.titleAuto && session.turns.length === 1 && !session.groupId) session.title = hero.title;
    }
    if (!ev.stopped) blockedCard(turn);
    // A lead that ends its turn without reading what its delegates finished gets it as a follow-up.
    if (!ev.stopped && !session.parentId) this.#reportBack(session, { ending: true });
    // Auto checks the work before it reaches you: the session stays in Working meanwhile.
    // A follow-up starts as soon as this run lets go: stay in Working rather than flash through Needs you.
    const handing = this.live.has(session.id) && (interrupted || session.queue.length > 0);
    if (handing) this.handing.add(session.id);
    const holding = !handing && !!this.pipeline?.wants(session, turn, ev);
    session.state = holding || handing ? 'running' : 'review';
    session.unread = !holding && !handing;
    // A crew check-in that found nothing (archived too), or a job whose answer went elsewhere:
    // filed under Done, nobody is pinged.
    const quiet = (crewOut.quiet || crewOut.filed) && !holding && !handing;
    if (quiet) Object.assign(session, { state: 'done', unread: false, ...(crewOut.quiet && { archived: true }) });
    this.store.save(session, { now: true });
    this.#touch(session, { turn: turn.id });
    this.emit('ended', { session, turn, interrupted, errorText: ev.isError && !ev.stopped ? ev.text : '' });
    this.#touchLead(session);
    if (session.parentId) this.#delegateDone(session, turn);
    if (holding) setImmediate(() => this.pipeline.run(session, turn));
    // The follow-up starts right away; don't notify for the run it replaced. A subagent reports
    // to its lead, not to the user.
    else if (!handing && !quiet && !session.parentId && !session.delegated && !this.deleting.has(session.id)) this.emit('finished', { session: summarize(session, this.store) });
  }

  // Auto is done with a session it held: it lands in your queue (quiet: handed to another run,
  // which will be the one to notify).
  settle(session, { quiet = false } = {}) {
    if (session.state !== 'running' || (this.live.has(session.id) && session.turns.at(-1)?.status === 'running')) return this.#touch(session);
    session.state = 'review';
    session.unread = !quiet;
    this.store.save(session, { now: true });
    this.#touch(session, { turn: session.turns.at(-1)?.id });
    if (!quiet && !session.parentId && !session.delegated && !this.deleting.has(session.id)) this.emit('finished', { session: summarize(session, this.store) });
  }

  // A line in a turn's activity from wisp itself (Auto's check, repair, hand-over).
  note(session, turn, { kind = 'check', label }) {
    const item = { t: Date.now(), kind, label: String(label).slice(0, 300), by: 'wisp' };
    turn.activity.push(item);
    this.emit('activity', { sessionId: session.id, turnId: turn.id, item });
    this.#touch(session, { turn: turn.id });
  }

  #touch(session, { turn, quiet } = {}) {
    if (this.deleting.has(session.id)) return; // going away: a last summary would bring its card back
    session.updatedAt = Date.now();
    this.store.save(session);
    if (!quiet) this.emit('summary', summarize(session, this.store));
    if (turn) this.emit('turn', { sessionId: session.id, turnId: turn });
  }
}

// What the turn's permissions refused, as one "blocked" block after the hero: the harness's own
// reports (which can carry a rule to allow exactly that) merged with the agent's "blocked" block,
// minus anything the user already denied. turn.blocked keeps the list for the retry.
function blockedCard(turn) {
  const blocks = turn.presentation?.blocks || [];
  const own = blocks.filter((b) => b.type === 'blocked').flatMap((b) => (Array.isArray(b.items) ? b.items : []));
  const items = [...(turn.blocked || [])];
  for (const i of own) {
    if (!i || typeof i !== 'object') continue;
    const item = { tool: String(i.tool || 'tool'), detail: String(i.detail ?? i.command ?? i.path ?? ''), ...(i.why && { why: String(i.why) }) };
    const known = items.find((b) => sameAction(b, item) || (item.detail && b.detail === item.detail));
    if (known) known.why ||= item.why;
    else items.push(item);
  }
  // The agent may name a tool its own way (shell for Bash): the same command still counts.
  const left = items.filter((b) => !(turn.denied || []).some((d) => sameAction(d, b) || (b.detail && d.detail === b.detail))).slice(0, 12);
  if (left.length) turn.blocked = left;
  else delete turn.blocked;
  if (!turn.presentation) return;
  const rest = blocks.filter((b) => b.type !== 'blocked');
  if (left.length) rest.splice(rest[0]?.type === 'hero' ? 1 : 0, 0, { type: 'blocked', items: left.map(({ rule, ...b }) => b) });
  turn.presentation.blocks = rest;
}
