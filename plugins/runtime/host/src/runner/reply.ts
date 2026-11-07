// Follow-ups and the queue (v1 runner.js reply, changedRun, #switchRun, accounts, unqueue,
// sendQueued, mergeQueued, editQueued, reorderQueue, approveBlocked). A follow-up that arrives while
// the agent is busy interrupts the run and resumes the conversation with it, or with `queue` waits
// until the run finishes. A Stop never discards queued follow-ups: it holds them.

import type { Attachment } from '@wisp-plugin/runtime-api';
import { mapEffort } from '../handoff.ts';
import type { QueueItem, RunOpts, Session } from '../model.ts';
import { isMode } from '../model.ts';
import { bad, shortId } from '../util.ts';
import type { Engine, ReplyOpts, ReplyOut } from './engine.ts';

type Run = NonNullable<RunOpts['run']>;

/** A follow-up's { agent, model, effort }, or null when it's what the session already runs on. */
export function changedRun(e: Engine, s: Session, run: Partial<Run> | undefined): Run | null {
  if (!run || typeof run !== 'object') return null;
  const agent = run.agent || s.agent;
  const same = agent === s.agent;
  const h = e.rt.points.harness(agent);
  const model = String(run.model ?? (same ? s.model : '') ?? '');
  const levels = (model && h?.models?.find((m) => m.id === model)?.efforts) || h?.efforts || [];
  // No effort with a switch to another harness: the task keeps its thinking level, as that harness names it.
  const effort = String(run.effort ?? (same ? s.effort : mapEffort(s.effort, levels)) ?? '');
  const next: Run = { agent, model, effort, ...(run.account !== undefined && { account: String(run.account || '') }) };
  const unchanged = same && next.model === (s.model || '') && next.effort === (s.effort || '') && (next.account === undefined || next.account === (s.account || ''));
  return unchanged ? null : next;
}

/** Which account a run of `agent` gets ('' when the harness has only the CLI's own login). */
export function accountFor(e: Engine, agent: string, want = '', byHand = true): string {
  const a = e.rt.points.accounts(agent);
  if (!a?.multi()) return '';
  if (want && want !== 'auto' && a.get(want)) return want;
  return a.pick(want === 'auto' ? '' : want, { byHand });
}

/** Another account of the same harness from the next turn on. Conversations that stay with the login start fresh. */
export function switchAccount(e: Engine, s: Session, want: string): void {
  const next = accountFor(e, s.agent, want);
  const was = s.account || '';
  if (!next || next === was) return;
  if (e.rt.points.accounts(s.agent)?.perLogin) {
    if (s.agentSessionId) s.agentSessions[`${s.agent}@${was || 'default'}`] = s.agentSessionId;
    s.agentSessionId = s.agentSessions[`${s.agent}@${next}`] ?? null;
  }
  s.account = next;
}

/** A follow-up on another harness, model or thinking level: a harness change resumes its own conversation. */
export function switchRun(e: Engine, s: Session, run: Run): void {
  if (s.agentSessionId) s.agentSessions[s.agent] = s.agentSessionId;
  for (const t of s.turns) t.agent ||= s.agent;
  if (s.agent !== run.agent) {
    s.agent = run.agent;
    s.agentSessionId = s.agentSessions[run.agent] ?? null;
    const acc = accountFor(e, run.agent, run.account ?? '');
    if (acc) s.account = acc;
    else delete s.account;
  } else if (run.account !== undefined) switchAccount(e, s, run.account);
  s.model = run.model;
  s.effort = run.effort;
}

/** The lead's roster changes between turns; members it already used keep their child session. */
function setTeam(s: Session, team: NonNullable<RunOpts['team']>): void {
  if (team.length) s.subagents = team;
  else delete s.subagents;
  s.children ||= {};
}

/** A queued follow-up as the next turn: its own mode, harness, account and team from here on. */
export function startQueued(e: Engine, s: Session, next: QueueItem): void {
  if (next.mode) s.mode = next.mode;
  if (next.run && e.rt.points.harness(next.run.agent)) switchRun(e, s, next.run);
  if (next.account) switchAccount(e, s, next.account);
  if (next.team) setTeam(s, next.team);
  const { id: _id, text, attachments, now: _now, ...opts } = next;
  e.startTurn(s, text, attachments, opts);
}

function extraOf(o: ReplyOpts, mode: ReplyOpts['mode'], run: Run | null, team: ReplyOpts['team']): RunOpts {
  const by = o.by;
  const compact = by === 'compact';
  return {
    ...(by === 'wisp' && o.goal !== undefined && { goal: o.goal }),
    ...(mode && { mode }),
    ...(run && { run }),
    ...(team && { team }),
    ...(o.grants?.length && { grants: o.grants }),
    ...(isMode(o.once) && { once: o.once }),
    ...((by === 'wisp' || by === 'later' || compact) && { by }),
    ...(by === 'later' && o.later !== undefined && { later: o.later }),
    ...(o.side && { side: o.side }),
    ...(o.reports && { reports: true }),
  };
}

/**
 * A follow-up. by: 'wisp' for one wisp sends itself, 'later' for a scheduled one, 'compact' for
 * Compact now; anything else is the user's, and cancels what Auto or a goal was about to do next.
 */
export function reply(e: Engine, s: Session, text: string, attachments: Attachment[] = [], o: ReplyOpts = {}): ReplyOut {
  const rt = e.rt;
  const mode = !isMode(o.mode) || o.mode === s.mode || s.sideOf ? undefined : o.mode; // a side discussion's mode is its harness's
  const run = changedRun(e, s, o.run);
  const team = s.parentId || s.sideOf || (o.team && JSON.stringify(o.team) === JSON.stringify(s.subagents ?? [])) ? undefined : o.team;
  const compact = o.by === 'compact';
  if (o.by !== 'wisp' && !compact) e.cancelAfter(s, { ...(o.by && { by: o.by }) });
  if (o.by !== 'wisp' && !compact) delete s.queueHeld; // you're back: a queue a Stop held carries on after this
  const extra = extraOf(o, mode, run, team);
  if (s.ask && !Object.keys(extra).length) {
    e.answer(s, text);
    return { answered: true };
  }
  let queue = !!o.queue;
  // A held run goes first: what you send now queues behind it. Switched to Full auto, a run held on
  // the repo's trust card goes in Full auto, unasked.
  const held = s.turns.at(-1);
  if (held?.status === 'held') {
    if (mode === 'auto' && held.held?.project && held.run) held.run.opts = { ...held.run.opts, mode };
    e.releaseHeld(s);
    queue = true;
  }
  let handle = rt.live.get(s.id);
  // A CLI only lingering after its result has nothing left to wait for: let it go, so the hold holds.
  if (o.hold && handle && s.turns.at(-1)?.status !== 'running' && !s.queue.length) {
    handle.release();
    handle = undefined;
  }
  if (o.hold && !handle) {
    e.holdTurn(s, text, attachments, extra, o.hold);
    return { held: true };
  }
  if (handle) return replyWhileLive(e, s, text, attachments, extra, queue, handle);
  if (mode) s.mode = mode;
  if (run) switchRun(e, s, run);
  if (team) setTeam(s, team);
  e.startTurn(s, text, attachments, extra);
  return { queued: false, ...(s.turns.at(-1) && { turnId: s.turns.at(-1)?.id }) };
}

function replyWhileLive(e: Engine, s: Session, text: string, attachments: Attachment[], extra: RunOpts, queue: boolean, handle: { release(): void }): ReplyOut {
  const turn = s.turns.at(-1);
  const item: QueueItem = { id: shortId(), text, attachments, ...extra };
  // The run already produced its result and the CLI is only lingering on its way out: start now.
  if (turn?.status !== 'running') {
    s.queue.push(item);
    handle.release();
    return { queued: s.queue.length > 0 };
  }
  // Interrupting needs an agent session to resume; before the agent reports one, queue.
  if (queue || !s.agentSessionId) {
    s.queue.push(item);
    e.touch(s);
    return { queued: true, ahead: s.queue.length - 1 };
  }
  // Ahead of anything queued, but after earlier interrupting follow-ups, so they keep their order.
  const at = s.queue.findIndex((q) => !q.now);
  s.queue.splice(at < 0 ? s.queue.length : at, 0, { ...item, now: true });
  e.interrupt(s);
  return { interrupted: true };
}

/** Drop a follow-up that hasn't gone out yet. */
export function unqueue(e: Engine, s: Session, itemId: string): boolean {
  const at = s.queue.findIndex((q) => q.id === itemId);
  if (at < 0) return false;
  s.queue.splice(at, 1);
  if (!s.queue.length) delete s.queueHeld;
  e.touch(s);
  return true;
}

/** Send now: this queued follow-up goes next, interrupting the run, or at once when nothing runs. */
export function sendQueued(e: Engine, s: Session, itemId: string): boolean {
  const at = s.queue.findIndex((q) => q.id === itemId);
  if (at < 0) return false;
  const [q] = s.queue.splice(at, 1);
  if (!q) return false;
  delete s.queueHeld;
  if (q.by !== 'wisp') e.cancelAfter(s, {});
  const handle = e.rt.live.get(s.id);
  if (!handle) {
    startQueued(e, s, q);
    return true;
  }
  const first = s.queue.findIndex((x) => !x.now);
  const running = s.turns.at(-1)?.status === 'running';
  s.queue.splice(first < 0 ? s.queue.length : first, 0, running && s.agentSessionId ? { ...q, now: true } : q);
  if (!running) handle.release();
  else if (s.agentSessionId) e.interrupt(s);
  else e.touch(s);
  return true;
}

/** Combine queued follow-ups into one (ids, in the queue's order): it goes where the first was. Only yours. */
export function mergeQueued(e: Engine, s: Session, ids: readonly string[]): boolean {
  const want = new Set(ids);
  const picked = s.queue.filter((q) => want.has(q.id) && q.by !== 'wisp');
  const [first, ...rest] = picked;
  if (!first || !rest.length) return false;
  first.text = picked.map((q) => q.text.trim()).join('\n\n');
  first.attachments = picked.flatMap((q) => q.attachments ?? []);
  s.queue = s.queue.filter((q) => !rest.includes(q));
  e.touch(s);
  return true;
}

/** Change what a queued follow-up says. Only yours: wisp's own (reports back, repairs) aren't. */
export function editQueued(e: Engine, s: Session, itemId: string, text: string): boolean {
  const q = s.queue.find((x) => x.id === itemId);
  if (!q || q.by === 'wisp') return false;
  q.text = text;
  e.touch(s);
  return true;
}

/** Put the queue in this order. Unknown ids are skipped; ones left out keep their place at the end. */
export function reorderQueue(e: Engine, s: Session, ids: readonly string[]): boolean {
  if (!s.queue.length) return false;
  const byId = new Map(s.queue.map((q) => [q.id, q]));
  const picked = [...new Set(ids)].map((id) => byId.get(id)).filter((q): q is QueueItem => !!q);
  const rest = s.queue.filter((q) => !picked.includes(q));
  s.queue.splice(0, s.queue.length, ...picked, ...rest);
  e.touch(s);
  return true;
}

function retryPrompt(items: readonly { tool: string; detail: string }[], scoped: boolean): string {
  const list = items.map((b) => `- ${b.tool}${b.detail ? `: \`${b.detail}\`` : ''}`).join('\n');
  const how = scoped ? 'I allowed exactly these for this follow-up' : 'This follow-up runs in Full auto, so nothing is blocked';
  return `These actions were blocked by your permissions last turn:\n${list}\n\n${how}. Run them now and finish the task.`;
}

/**
 * The card under a turn whose permissions refused something: allow retries it as a follow-up, with
 * exactly those actions allowed where the harness can scope a grant, else in Full auto once.
 */
export function approveBlocked(e: Engine, s: Session, o: { turnId?: string; allow: boolean }): ReplyOut & { denied?: boolean; scoped?: boolean } {
  const turn = o.turnId ? s.turns.find((t) => t.id === o.turnId) : s.turns.at(-1);
  if (!turn?.blocked?.length) throw bad('Nothing on that turn is waiting for approval.', 404);
  if (o.allow && s.sideOf) throw bad('A side discussion can’t allow this: ask the main task to do it.', 409);
  if (turn.approval) throw bad(`Already ${turn.approval}.`, 409);
  // A CLI still lingering after its result doesn't count: reply() lets it go and starts the retry.
  if (turn !== s.turns.at(-1) || (e.rt.live.has(s.id) && turn.status === 'running')) throw bad('The task has moved on since; send a follow-up instead.', 409);
  turn.approval = o.allow ? 'allowed' : 'denied';
  if (!o.allow) {
    e.touch(s, { turn });
    return { denied: true };
  }
  const scoped = turn.blocked.every((b) => b.rule !== undefined);
  const out = reply(e, s, retryPrompt(turn.blocked, scoped), [], scoped ? { grants: turn.blocked.map((b) => b.rule ?? '') } : { once: 'auto' });
  e.touch(s, { turn });
  return { ...out, scoped };
}
