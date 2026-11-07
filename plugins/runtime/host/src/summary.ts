// The list row (v1 runner.js summarize): what the runtime knows of a task, plus what each plugin
// adds from its ext slot through `runtime.summary`. Made once per task per flush (persist.ts), and
// read back from rt_summary by the list: no work over the whole list per event (ADR-0011).

import path from 'node:path';
import type { Session as ApiSession, Turn as ApiTurn } from '@wisp-plugin/runtime-api';
import { heroOf } from './blocks/parse.ts';
import { plainMentions } from './mentions.ts';
import type { Member, Session, Turn } from './model.ts';
import type { Rt } from './rt.ts';
import { compactOffer, compactUntil, haltOf } from './shared.ts';

/** The sessions a member runs as: itself, or one per copy (`#` can't appear in a name). */
export const copies = (m: Member): string[] => ((m.count ?? 1) > 1 ? Array.from({ length: m.count ?? 1 }, (_, i) => `${m.name}#${i + 1}`) : [m.name]);

/** Whether the task is in the scratch folder (a folder-less task). */
export const isScratch = (rt: Pick<Rt, 'home'>, dir = ''): boolean => String(dir).startsWith(path.join(rt.home, 'scratch') + path.sep);

type Obj = Record<string, unknown>;

/** The held card's fields the row shows (v1: kind, label, used, to, line, resetsAt, until, waiting, harness, project). */
function heldView(t: Turn): Obj | undefined {
  const h = t.held;
  if (t.status !== 'held' || !h) return undefined;
  if (h.project) return { kind: h.kind, project: { count: h.project.items.length, ...(h.project.changed && { changed: true }), ...(h.project.setup !== undefined && { setup: h.project.setup }) } };
  if (h.harness) return { kind: h.kind, harness: h.harness };
  const { kind, label, used, to, line, resetsAt, until, waiting } = h;
  return { kind, label, used, to, line, resetsAt, until, ...(waiting ? { waiting: true } : {}) };
}

/** What an after-turn step (Auto's check, a goal round) is doing with the task, if anything. */
function busyWith(rt: Rt, s: Session): string | null {
  for (const a of rt.points.after()) {
    try {
      const b = a.busy?.(s as unknown as ApiSession);
      if (b) return b;
    } catch {
      // a contribution's bug never breaks the list
    }
  }
  return null;
}

function waitingOnOf(rt: Rt, s: Session, last: Turn | undefined, busy: string | null): string {
  // A lead blocked on its subagents says who it's waiting for: in its turn, or after it ended with
  // them still at work, when it stays in Working until their report is read.
  const owes = !s.parentId && s.state === 'running' && last?.status !== 'running' && !busy;
  if (!(last?.status === 'running' || owes)) return '';
  const working = (last?.delegations ?? []).filter((d) => rt.db.get(d.sessionId)?.turns.find((t) => t.id === d.turnId)?.status === 'running');
  return working.length ? `Waiting on ${[...new Set(working.map((d) => d.name))].join(', ')}` : '';
}

function teamOf(rt: Rt, s: Session): Obj[] {
  return (s.subagents ?? []).flatMap((m) =>
    copies(m).map((name) => {
      // A crew member's jobs are its own tasks: the latest one this lead handed it.
      const id = m.crew ? s.turns.flatMap((t) => t.delegations ?? []).findLast((d) => d.member === m.name)?.sessionId : s.children?.[name];
      const child = id ? rt.db.get(id) : undefined;
      return { name, agent: child?.agent ?? m.agent, model: m.model, effort: m.effort, used: !!child, busy: child?.state === 'running', ...(m.crew && { crew: m.crew }) };
    }),
  );
}

function relaysOf(rt: Rt, s: Session): Obj {
  const relays = Object.values(s.children ?? {})
    .map((cid) => rt.db.get(cid))
    .filter((c): c is Session => !!c?.relay?.upstream && c.turns.at(-1)?.relay?.state === 'pending')
    .map((c) => ({ child: c.id, turn: c.turns.at(-1)?.id, machine: c.relay?.machine }));
  return relays.length ? { relays } : {};
}

function liveLine(s: Session, last: Turn | undefined, waitingOn: string, busy: string | null): string {
  if (s.ask) return `Asks: ${s.ask.question}`;
  if (last?.status === 'running') {
    if (waitingOn) return waitingOn;
    // Only a running turn's last step is shown.
    const act = last.activity.findLast((a) => a.kind !== 'text');
    return act?.label ?? (last.by === 'compact' ? 'Compacting' : 'Starting up');
  }
  return waitingOn || busy || '';
}

/** Runtime's own fields of the row (v1 names). */
export function ownSummary(rt: Rt, s: Session): Obj {
  const last = s.turns.at(-1);
  // A compact turn reports nothing of its own: the row goes on saying what the last answer said.
  const report = last?.by === 'compact' && last.status === 'done' ? s.turns.findLast((t) => t.by !== 'compact') : last;
  const hero = heroOf(report?.presentation);
  const busy = busyWith(rt, s);
  const waitingOn = waitingOnOf(rt, s, last, busy);
  const now = rt.clock.now();
  const offer = compactOffer(s, now);
  const halt = haltOf(last);
  const held = last ? heldView(last) : undefined;
  const scratch = isScratch(rt, s.cwd);
  return {
    id: s.id,
    title: s.title,
    agent: s.agent,
    cwd: s.cwd,
    ...(scratch && { scratch: true }),
    project: s.agent === 'wisp' ? 'tour' : scratch ? 'General' : path.basename(s.cwd || ''),
    mode: s.mode,
    model: s.model,
    effort: s.effort || '',
    ...(s.account && { account: s.account }),
    ...(s.subagentModel !== undefined && { subagentModel: s.subagentModel }),
    ...(s.skills && { skills: s.skills }),
    state: s.state,
    unread: s.unread,
    archived: !!s.archived,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    turnCount: s.turns.length,
    queued: s.queue.length,
    ...(s.queueHeld && s.queue.length && { queueHeld: true }),
    status: last?.status === 'running' || waitingOn || busy ? 'running' : last?.status === 'held' ? 'held' : (typeof hero?.['status'] === 'string' && hero['status']) || (last?.status === 'error' ? 'blocked' : 'info'),
    ...(halt && { halt }),
    preview: typeof hero?.['summary'] === 'string' ? hero['summary'] : '',
    ...(held && { held }),
    ...(s.tags?.length && { tags: s.tags }),
    live: liveLine(s, last, waitingOn, busy),
    ...(s.tui && { tui: true }),
    asks: !!s.ask || !!last?.presentation?.blocks?.some((b) => b.type === 'question'),
    question: s.ask?.question ?? '',
    ...(s.ask?.options?.length && !s.ask.clash && { options: s.ask.options }),
    approval: !!s.ask?.permission,
    groupId: s.groupId ?? null,
    origin: s.origin ?? null,
    ...(s.kind && { kind: s.kind }),
    ...(s.lean && { lean: s.lean }),
    moved: s.moved ?? null,
    movedTo: s.movedTo ?? null,
    ...(s.forkedFrom && { forkedFrom: s.forkedFrom }),
    ...(s.sideOf && { sideOf: { id: s.sideOf.id, title: s.sideOf.title, edits: s.mode !== 'plan' } }),
    ...(s.sides?.length && { sides: s.sides.filter((x) => rt.db.has(x)) }),
    ...(s.forks?.length && { forks: s.forks.filter((x) => rt.db.has(x)) }),
    ...(s.sharedFrom !== undefined && { sharedFrom: s.sharedFrom }),
    team: teamOf(rt, s),
    ...(s.parentId && { parentId: s.parentId, member: s.member }),
    ...(s.delegated && { delegated: true }),
    ...relaysOf(rt, s),
    followups: s.turns.slice(1).filter((t) => t.by !== 'wisp' && t.by !== 'compact').length,
    ...(offer && { compactOffer: { ...offer, until: compactUntil(s, now) } }),
    ...(s.trial !== undefined && { trial: s.trial }),
  };
}

/** The whole row: runtime's fields, then each plugin's (a plugin never overrides runtime's id). */
export function summarize(rt: Rt, s: Session): Record<string, unknown> {
  const own = ownSummary(rt, s);
  const last = s.turns.at(-1);
  for (const c of rt.points.summary()) {
    try {
      const add = c.fields(s as unknown as ApiSession, last as unknown as ApiTurn | undefined);
      for (const [k, v] of Object.entries(add)) if (k !== 'id' && v !== undefined) own[k] = v;
    } catch (err) {
      rt.log.warn(`summary field of ${c.plugin} threw`, { error: (err as Error).message });
    }
  }
  return own;
}

export { plainMentions };
