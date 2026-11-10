// Every write the reply box and New task make (AGENTS.md: writes are commands). Each declares its
// optimistic patch, computed from what's on screen with the same rules the peer applies
// (model/queue.ts), so the box clears and the list moves at once; a reject drops the overlay and the
// shell's onError shows the toast. The ids are the runtime / later plugins' v1 routes, one each:
// POST /sessions/:id/reply → runtime.reply, PATCH /sessions/:id/queue → runtime.queue.*, ….

import { defineCommand, entityKey, ownerOf, type EntityKey, type EntityOps, type EntityReader, type PeerId } from '@wisp/client';
import { combine, edit, remove, reorder } from './model/queue.ts';
import { titleOf, type LaunchBody } from './model/launch.ts';
import { KIND, type Attachment, type Mode, type QueueItem, type Row, type Runner, type Session, type TeamMember } from './types.ts';

/** The words a pending card shows while it starts (server data, as the peer writes it). */
const STARTING = 'Starting up';

const session = (base: EntityReader, key: EntityKey): Row<Session> | undefined => base.peek<Session>(KIND.session, key);
const patch = (key: EntityKey, ops: { path: string; value: unknown }[]): EntityOps => [{ e: KIND.session, id: key, op: 'patch', ops: ops.map((o) => ({ op: 'add', ...o })) }];
/** The task's queue: the store keeps the task whole in its row's `body` (a flat row, a test's, has it on top). */
const queueOf = (base: EntityReader, key: EntityKey): readonly Row<QueueItem>[] => {
  const s = session(base, key) as (Row<Session> & { body?: { queue?: readonly Row<QueueItem>[] } }) | undefined;
  return s?.body?.queue ?? s?.queue ?? [];
};
const live = (s: Row<Session> | undefined): boolean => s?.state === 'running' || s?.state === 'waiting';

export interface ReplyArgs {
  session: EntityKey;
  /** the follow-up's id: the queue item's, or the new turn's (idempotent with the mid) */
  id: string;
  text: string;
  attachments: Attachment[];
  /** Queue on: wait for the run instead of interrupting it */
  queue: boolean;
  mode?: Mode;
  run?: Partial<Runner>;
  subagents?: TeamMember[];
  at: number;
}

/** A follow-up: answers what the task asks, queues behind the run, steers it, or starts a turn. */
export const reply = defineCommand<ReplyArgs, { queued?: boolean; interrupted?: boolean; answered?: boolean }>({
  id: 'runtime.followUp',
  owner: (a) => a.session,
  wire: (a) => ({ id: bare(a.session), text: a.text, queue: a.queue, attachments: a.attachments, ...(a.mode !== undefined && { mode: a.mode }) }),
  optimistic: (base, a) => {
    const s = session(base, a.session);
    if (!s) return [];
    if (s.ask || s.asks || s.approval) return patch(a.session, [{ path: '/ask', value: null }, { path: '/asks', value: false }, { path: '/state', value: 'running' }]);
    if (live(s) && a.queue) {
      const item: QueueItem = { id: a.id, text: a.text, attachments: a.attachments, at: a.at, ...(a.mode && { mode: a.mode }), ...(a.run && { run: a.run }) };
      return patch(a.session, [{ path: '/body/queue', value: [...queueOf(base, a.session), item] }]);
    }
    // steering shows nothing new until the interrupt lands (v1 startOptimistic returns null)
    if (live(s)) return [];
    return patch(a.session, [{ path: '/state', value: 'running' }, { path: '/live', value: STARTING }, ...(a.mode ? [{ path: '/mode', value: a.mode }] : [])]);
  },
});

type QueueArgs = { session: EntityKey; item: string };
/** the bare id the peer knows the task by */
const bare = (key: EntityKey): string => key.slice(key.indexOf(':') + 1);

export const queueEdit = defineCommand<QueueArgs & { text: string }>({
  id: 'runtime.queue.text',
  owner: (a) => a.session,
  wire: (a) => ({ id: bare(a.session), itemId: a.item, text: a.text }),
  optimistic: (base, a) => patch(a.session, [{ path: '/body/queue', value: edit(queueOf(base, a.session), a.item, a.text) }]),
});

/** Send now: interrupts the run with this one (or starts it); the rest of the queue carries on. */
export const queueNow = defineCommand<QueueArgs>({
  id: 'runtime.queue.sendNow',
  owner: (a) => a.session,
  wire: (a) => ({ id: bare(a.session), itemId: a.item }),
  optimistic: (base, a) => patch(a.session, [{ path: '/body/queue', value: remove(queueOf(base, a.session), a.item) }, { path: '/body/queueHeld', value: false }]),
});

export const queueMerge = defineCommand<{ session: EntityKey; items: string[] }>({
  id: 'runtime.queue.merge',
  owner: (a) => a.session,
  wire: (a) => ({ id: bare(a.session), ids: a.items }),
  optimistic: (base, a) => patch(a.session, [{ path: '/body/queue', value: combine(queueOf(base, a.session), a.items) }]),
});

export const queueOrder = defineCommand<{ session: EntityKey; order: string[] }>({
  id: 'runtime.queue.order',
  owner: (a) => a.session,
  wire: (a) => ({ id: bare(a.session), order: a.order }),
  optimistic: (base, a) => patch(a.session, [{ path: '/body/queue', value: reorder(queueOf(base, a.session), a.order) }]),
});

/** Cancel one follow-up. Removing the last one also lifts a Stop's hold (runner.js:748). */
export const queueCancel = defineCommand<QueueArgs>({
  id: 'runtime.queue.cancel',
  owner: (a) => a.session,
  wire: (a) => ({ id: bare(a.session), itemId: a.item }),
  optimistic: (base, a) => {
    const rest = remove(queueOf(base, a.session), a.item);
    return patch(a.session, [{ path: '/body/queue', value: rest }, ...(rest.length === 0 ? [{ path: '/body/queueHeld', value: false }] : [])]);
  },
});

/** Stop: the run ends, the queue stays and holds (nothing goes out by itself). */
export const stop = defineCommand<{ session: EntityKey }>({
  id: 'runtime.stop',
  owner: (a) => a.session,
  wire: (a) => ({ id: bare(a.session) }),
  optimistic: (base, a) => patch(a.session, [{ path: '/state', value: 'review' }, ...(queueOf(base, a.session).length ? [{ path: '/body/queueHeld', value: true }] : [])]),
});

/** /btw: a side question on a copy of the conversation; the run carries on. */
export const btw = defineCommand<{ session: EntityKey; id: string; question: string; attachments: Attachment[]; at: number }>({
  id: 'runtime.btw',
  owner: (a) => a.session,
  optimistic: (base, a) => {
    const entry = { id: a.id, question: a.question, status: 'running', askedAt: a.at, attachments: a.attachments };
    return patch(a.session, [{ path: '/btw', value: [...(session(base, a.session)?.btw ?? []), entry] }]);
  },
});

/** /side: a side discussion of its own, beside the task; it shows at once as a pending task. */
export const side = defineCommand<{ session: EntityKey; id: string; text: string; attachments: Attachment[]; run?: Partial<Runner>; at: number }>({
  // a side discussion is a task of its own under this one (runtime.create with its parent)
  id: 'runtime.create',
  owner: (a) => a.session,
  wire: (a) => ({ prompt: a.text, parentId: bare(a.session), attachments: a.attachments, ...(a.run?.agent !== undefined && { agent: a.run.agent }) }),
  optimistic: (base, a) => {
    const main = session(base, a.session);
    const key = entityKey(ownerOf(a.session), a.id);
    const row: Session = {
      id: a.id,
      title: titleOf(a.text),
      agent: main?.agent ?? '',
      state: 'running',
      live: STARTING,
      pending: true,
      sideOf: { id: main?.id ?? '', title: main?.title ?? '' },
      createdAt: a.at,
      updatedAt: a.at,
    };
    return [{ e: KIND.session, id: key, op: 'upsert', v: row }];
  },
});

export interface CreateArgs extends LaunchBody {
  peer: PeerId;
  /** the new task's id, made here so the card and the peer agree (and a resend runs once) */
  id: string;
  at: number;
}

/** New task: the card shows at once, running, with its title. */
export const create = defineCommand<CreateArgs>({
  id: 'runtime.create',
  owner: (a) => a.peer,
  optimistic: (_base, a) => {
    const row: Session = {
      id: a.id,
      title: titleOf(a.prompt) || a.prompt.slice(0, 64),
      agent: a.agent,
      model: a.model,
      effort: a.effort,
      mode: a.mode,
      ...(a.cwd !== undefined && { cwd: a.cwd }),
      ...(a.projectId !== undefined && { projectId: a.projectId }),
      ...(a.scratch && { scratch: true }),
      state: 'running',
      live: STARTING,
      pending: true,
      createdAt: a.at,
      updatedAt: a.at,
    };
    return [{ e: KIND.session, id: entityKey(a.peer, a.id), op: 'upsert', v: row }];
  },
});

export interface LaterArgs {
  peer: PeerId;
  id: string;
  /** a task to start, a follow-up on a task, a draft (no time), or one that waits for a task */
  kind: 'task' | 'followup' | 'draft' | 'after';
  at?: number;
  prompt: string;
  session?: EntityKey;
  after?: string;
  launch?: LaunchBody;
  attachments: string[];
}

/** Start later, Send later, /draft and /after: the plan row (Scheduled, Drafts) shows at once. */
export const later = defineCommand<LaterArgs>({
  id: 'later.add',
  owner: (a) => a.session ?? a.peer,
  optimistic: (base, a) => {
    if (a.kind === 'followup' && a.session) {
      const s = session(base, a.session) as (Row<Session> & { later?: readonly unknown[] }) | undefined;
      const item = { id: a.id, at: a.at ?? 0, text: a.prompt, by: 'user' };
      return s ? patch(a.session, [{ path: '/later', value: [...(s.later ?? []), item] }]) : [];
    }
    const row = {
      id: a.id,
      kind: a.kind === 'draft' ? 'draft' : 'task',
      title: titleOf(a.prompt),
      at: a.at ?? 0,
      ...(a.launch && { agent: a.launch.agent, projectId: a.launch.projectId ?? null }),
    };
    return [{ e: KIND.plan, id: entityKey(a.peer, a.id), op: 'upsert', v: row }];
  },
});

export const COMMANDS = [reply, queueEdit, queueNow, queueMerge, queueOrder, queueCancel, stop, btw, side, create, later] as const;
