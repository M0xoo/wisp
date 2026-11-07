// A task's turns (v1 runner.js create, #newTurn, #startTurn, #holdTurn, release, skipHeld, #touch):
// what a new task and a new turn look like, and the state moves around them. Starting the harness is
// runner/launch.ts; it runs after the before:run interceptors, so a hold can still stop it.

import type { Attachment } from '@wisp-plugin/runtime-api';
import { plainMentions } from '../mentions.ts';
import type { Mode, RunOpts, Session, Turn } from '../model.ts';
import { isMode } from '../model.ts';
import { setting } from '../rt.ts';
import { newId, shortId } from '../util.ts';
import type { CreateOpts, Engine, HoldSpec } from './engine.ts';
import { launch, sideMode } from './launch.ts';

export const bare = (list: readonly Attachment[] = []): Attachment[] => list.map(({ id, name, mime, size }) => ({ id, name, mime, size }));

function autoTitle(prompt: string): string {
  const line = (plainMentions(prompt).trim().split('\n')[0] ?? '').replace(/\s+/g, ' ');
  return line.length > 64 ? `${line.slice(0, 63)}…` : line;
}

/** Settings → General → wisp blocks off: plain markdown answers (not crew jobs, spells, panes or subagents). */
export const plainAnswer = (e: Engine, s: Session): boolean => setting(e.rt, 'blocks') === 'off' && !s.keepBlocks && s.kind !== 'spell' && s.kind !== 'pane' && !s.parentId && !s.delegated;

export function touch(e: Engine, s: Session, o: { turn?: Turn | undefined; quiet?: boolean; now?: boolean } = {}): void {
  if (e.rt.deleting.has(s.id)) return; // going away: a last summary would bring its card back
  s.updatedAt = e.rt.clock.now();
  e.rt.db.save(s, { turns: [o.turn], summary: !o.quiet, ...(o.now && { now: true }) });
  if (!o.quiet) e.rt.emit('session.changed', { id: s.id });
}

/** A child's state changed: the lead's card shows it, so the lead's row and turn repaint too. */
export function touchLead(e: Engine, child: Session): void {
  const lead = child.parentId ? e.rt.db.get(child.parentId) : undefined;
  if (!lead) return;
  const turn = lead.turns.findLast((t) => t.delegations?.some((d) => d.sessionId === child.id)) ?? lead.turns.at(-1);
  touch(e, lead, { turn });
}

export function newTurn(e: Engine, s: Session, prompt: string, attachments: readonly Attachment[], mode: Mode = s.mode): Turn {
  return {
    id: newId(e.rt.clock.now()),
    prompt,
    agent: s.agent,
    model: s.model,
    effort: s.effort || '',
    ...(s.account && { account: s.account }),
    mode,
    attachments: bare(attachments),
    startedAt: e.rt.clock.now(),
    endedAt: null,
    status: 'running',
    checkpoint: null,
    activity: [],
    changes: [],
    presentation: null,
    stats: null,
  };
}

function fields(o: CreateOpts): Partial<Session> {
  return {
    ...(o.workdir && { workdir: o.workdir }),
    ...(o.dirs?.length && { dirs: [...o.dirs] }),
    ...(o.moved && { moved: o.moved }),
    ...(o.forkedFrom && { forkedFrom: o.forkedFrom }),
    ...(o.sideOf && { sideOf: o.sideOf }),
    ...(o.sharedFrom && { sharedFrom: o.sharedFrom }),
    ...(o.capped && { capped: o.capped }),
    ...(o.kind && { kind: o.kind }),
    ...(o.groupId && { groupId: o.groupId }),
    ...(o.origin && { origin: o.origin }),
    ...(o.subagents?.length && { subagents: o.subagents, children: {} }),
    ...(o.parentId && { parentId: o.parentId, member: o.member ?? '' }),
    ...(o.relay && { relay: o.relay }),
    ...(o.delegated && { delegated: o.delegated }),
    ...(o.subagentModel !== undefined && { subagentModel: o.subagentModel }),
    ...(o.skills === 'off' && { skills: o.skills }),
    ...(o.trial && { trial: o.trial }),
    ...(o.keepBlocks && { keepBlocks: true }),
  };
}

export function create(e: Engine, o: CreateOpts): Session {
  const agent = o.agent ?? 'claude';
  if (!e.rt.points.harness(agent) && !(o.relay && agent === 'auto')) throw new Error(`Unknown agent: ${agent}`);
  const now = e.rt.clock.now();
  // You started it yourself (not a crew job, schedule, trigger or subagent): the pick skips one at its limit.
  const account = e.accountFor(agent, o.account ?? '', o.byHand ?? (!o.origin && !o.parentId && !o.delegated));
  const s: Session = {
    id: o.id ?? newId(now),
    title: o.title || autoTitle(o.prompt),
    titleAuto: !o.title,
    agent,
    cwd: o.cwd,
    mode: isMode(o.mode) ? o.mode : 'auto',
    model: o.model ?? '',
    effort: o.effort ?? '',
    ...(account && { account }),
    state: 'running',
    unread: false,
    createdAt: now,
    updatedAt: now,
    agentSessionId: null,
    agentSessions: {},
    queue: [],
    turns: [...(o.history ?? [])],
    ...fields(o),
    ext: { ...(o.ext ?? {}) },
  };
  e.rt.db.put(s);
  e.rt.emit('session.created', { id: s.id });
  const attachments = o.attachments ?? [];
  if (o.idle) Object.assign(s, { state: 'review', unread: false });
  else if (o.tui) tuiTurn(e, s, o.prompt, attachments);
  else if (o.hold) holdTurn(e, s, o.prompt, attachments, {}, o.hold);
  else e.startTurn(s, o.prompt, attachments);
  return s;
}

/** Terminal sessions: the task is the agent's own CLI in a terminal; wisp keeps the prompt as its one turn. */
function tuiTurn(e: Engine, s: Session, prompt: string, attachments: readonly Attachment[]): void {
  const turn = newTurn(e, s, prompt, attachments);
  const name = e.rt.points.harness(s.agent)?.name ?? s.agent;
  Object.assign(turn, { tui: true, status: 'done', endedAt: e.rt.clock.now(), presentation: { blocks: [{ type: 'hero', title: 'In the terminal', summary: `This task runs in ${name}'s own terminal. Open it to carry on.`, status: 'info' }] } });
  s.turns.push(turn);
  Object.assign(s, { tui: true, state: 'review', unread: false });
  touch(e, s, { turn });
}

/**
 * A run held before it starts (a limit line, a changed harness, project trust): its prompt shows,
 * with a card (Start now, Wait, Skip), and the task waits in Needs you. opts: what the follow-up
 * carried, used when it goes.
 */
export function holdTurn(e: Engine, s: Session, prompt: string, attachments: readonly Attachment[], opts: RunOpts, hold: HoldSpec): void {
  const now = e.rt.clock.now();
  const kind = s.turns.length ? 'followUp' : 'first';
  const { by, reason, agent, until, project, harness, ...card } = hold;
  const turn: Turn = {
    id: newId(now),
    prompt,
    agent: opts.run?.agent || s.agent,
    model: opts.run?.model ?? s.model,
    effort: opts.run?.effort ?? (s.effort || ''),
    ...(s.account && { account: s.account }),
    mode: opts.mode || s.mode,
    attachments: bare(attachments),
    ...((opts.by === 'wisp' || opts.by === 'compact') && { by: opts.by }),
    ...(opts.by === 'wisp' && opts.goal !== undefined && { goal: opts.goal }),
    ...(opts.by === 'later' && opts.later !== undefined && { later: opts.later }),
    startedAt: now,
    endedAt: null,
    status: 'held',
    // A changed harness or an untrusted repo has no reset to wait for: it waits for Trust, or Skip.
    held: project ? { kind, agent, by, reason, project, at: now } : harness !== undefined ? { kind, agent, by, reason, harness, at: now } : { ...card, kind, agent, by, reason, until: until ?? now + 3_600_000, at: now },
    run: { attachments: [...attachments], opts },
    activity: [],
    changes: [],
    presentation: null,
    stats: null,
  };
  s.turns.push(turn);
  s.state = 'review';
  s.unread = true;
  delete s.archived;
  touch(e, s, { turn });
  e.rt.emit('turn.held', { sessionId: s.id, turnId: turn.id, by, kind: reason });
}

/** The held turn goes now (Start now, or its reset came). false when there's none. */
export function releaseHeld(e: Engine, s: Session): boolean {
  const t = s.turns.at(-1);
  if (t?.status !== 'held') return false;
  s.turns.pop();
  e.rt.db.dropTurn(s, t);
  const opts = t.run?.opts ?? {};
  const next = { ...opts, id: shortId(), text: t.prompt, attachments: t.run?.attachments ?? [] };
  if (e.rt.live.has(s.id)) {
    s.queue.push(next);
    touch(e, s);
    return true;
  }
  e.startQueued(s, next);
  return true;
}

/** Skip this run: the held turn stays, stopped, so the task says what was skipped and when. */
export function skipHeld(e: Engine, s: Session): boolean {
  const t = s.turns.at(-1);
  if (t?.status !== 'held' || !t.held) return false;
  const h = t.held;
  const why = h.project ? 'This repo’s hooks, servers or setup weren’t trusted.' : h.harness !== undefined ? `${e.rt.points.harness(h.agent)?.name ?? h.agent} had changed and wasn’t trusted.` : `${String(h['label'] ?? 'Its usage')} window was near its limit.`;
  Object.assign(t, { status: 'stopped', skipped: true, endedAt: e.rt.clock.now(), presentation: { blocks: [{ type: 'hero', title: 'Skipped before it started', summary: why, status: 'info' }] } });
  delete t.run;
  s.state = 'done';
  s.unread = false;
  touch(e, s, { turn: t });
  return true;
}

/** Moves what the new turn picks up from the one before: side questions still out, unread delegations. */
export function carryOver(s: Session, prev: Turn | undefined, turn: Turn, prompt: string): void {
  if (!prev) return;
  // A crew member's follow-up brings its thread along, so its answer stays above what it asked for.
  const byCrew = /^@\[[^\]\n]{1,200}\]\(crew:[a-z0-9]{6,40}\)/.test(prompt);
  const open = prev.btw?.filter((b) => b.status === 'running' || (byCrew && b.crew)) ?? [];
  if (open.length) {
    prev.btw = (prev.btw ?? []).filter((b) => !open.includes(b));
    if (!prev.btw.length) delete prev.btw;
    turn.btw = open;
  }
  // Delegations whose report the lead hasn't had (a follow-up interrupted it) move too.
  const owed = (!s.parentId && prev.delegations?.filter((d) => d.owed)) || [];
  if (owed.length) {
    prev.delegations = (prev.delegations ?? []).filter((d) => !d.owed);
    if (!prev.delegations.length) delete prev.delegations;
    turn.delegations = owed;
  }
}

/** Puts back what carryOver moved, for a turn that ends up held before it ran. */
export function undoCarry(prev: Turn | undefined, turn: Turn): void {
  if (!prev) return;
  if (turn.btw?.length) prev.btw = [...(prev.btw ?? []), ...turn.btw];
  if (turn.delegations?.length) prev.delegations = [...(prev.delegations ?? []), ...turn.delegations];
}

/** A new turn starts: recorded now, run after the before:run interceptors (launch.ts). */
export function startTurn(e: Engine, s: Session, prompt: string, attachments: Attachment[] = [], opts: RunOpts = {}): void {
  if (s.sideOf) s.mode = sideMode(e, s.agent);
  const mode = isMode(opts.once) && !s.sideOf ? opts.once : s.mode;
  const turn = newTurn(e, s, prompt, attachments, mode);
  const { by } = opts;
  if (s.relay) turn.relay = { state: 'pending' }; // until the relay picks it up
  if (by === 'wisp' || by === 'compact' || by === 'later') turn.by = by;
  if (by === 'compact' && (s.state === 'done' || s.state === 'review')) turn.was = { state: s.state, unread: !!s.unread };
  if (opts.side) turn.side = opts.side;
  if (by === 'wisp' && opts.goal !== undefined) turn.goal = opts.goal;
  if (by === 'later' && opts.later !== undefined) turn.later = opts.later;
  if (opts.reports) turn.reports = true;
  const prev = s.turns.at(-1);
  carryOver(s, prev, turn, prompt);
  if (plainAnswer(e, s)) turn.plain = true;
  s.turns.push(turn);
  s.state = 'running';
  s.unread = false;
  if (by !== 'compact') delete s.archived;
  touch(e, s, { turn });
  if (prev) e.rt.db.save(s, { turns: [prev] });
  e.touchLead(s);
  e.rt.emit('turn.started', { sessionId: s.id, turnId: turn.id, by: by ?? null });
  // A member on another machine runs over there: the relay carries it.
  if (s.relay) {
    if (!s.relay.upstream) e.rt.emit('runtime.relay', { sessionId: s.id, turnId: turn.id });
    return;
  }
  launch(e, s, turn, attachments, opts, mode, prev);
}
