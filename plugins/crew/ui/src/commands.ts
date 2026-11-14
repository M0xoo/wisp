// Every write the crew's screens make: a command with its optimistic patch (the UI shows it at once
// and rolls back with a toast on reject), ids from the crew's contract (v2-ts-server-reference
// plugins/crew/api COMMANDS). `key` routes the command to the peer that owns the row (origin
// routing); the peer reads `id`.

import { defineCommand, type EntityKey, type EntityOps, type PeerId } from '@wisp/client';
import { KIND, type KitFile, type Member, type Offer, type SessionRow } from './types.ts';

/** The member fields the editor and the page change. */
export type MemberPatch = Partial<
  Pick<
    Member,
    | 'name'
    | 'role'
    | 'avatar'
    | 'color'
    | 'bg'
    | 'brief'
    | 'cron'
    | 'on'
    | 'parallel'
    | 'team'
    | 'cwd'
    | 'machine'
    | 'sandbox'
    | 'agent'
    | 'model'
    | 'effort'
    | 'mode'
    | 'paused'
    | 'kit'
    | 'notebook'
    | 'wakes'
  >
>;

const replace = (key: EntityKey, patch: Record<string, unknown>): EntityOps => [
  { e: KIND.member, id: key, op: 'patch', ops: Object.entries(patch).map(([k, value]) => ({ op: 'add' as const, path: `/${k}`, value })) },
];

/** Change a member (Pause, Resume, Edit… Save, the kit's switches): crew.update. */
export const updateMember = defineCommand<{ key: EntityKey; id: string } & MemberPatch, Member>({
  id: 'crew.update',
  owner: (a) => a.key,
  wire: ({ key: _key, ...a }) => a,
  optimistic: (_base, { key, id: _id, ...patch }) => replace(key, patch),
});

/** An offer you added from or dismissed (the peer's OfferSettle). */
export interface OfferSettle {
  id: string;
  state: 'taken' | 'dismissed';
  names: string[];
}

/** The member's offers with these settled, as the peer will keep them (crew core offers::settle). */
export const settled = (offers: readonly Offer[], list: readonly OfferSettle[], now: number): Offer[] =>
  offers.map((o) => {
    const s = list.find((x) => x.id === o.id);
    return s ? { ...o, state: s.state, names: s.names.slice(0, 12), settledAt: now } : o;
  });

/** crew.update with offers: the kit the offer added to (if any) and the offer settled, both at once. */
export const settleOffer = defineCommand<{ key: EntityKey; id: string; kit?: KitFile[]; offers: OfferSettle[] }, Member>({
  id: 'crew.update',
  owner: (a) => a.key,
  wire: ({ key: _key, ...a }) => a,
  optimistic: (base, { key, kit, offers }) => {
    const row = base.peek<Record<string, unknown>>(KIND.member, key) as Record<string, unknown> | undefined;
    if (!row) return [];
    const now = Date.now();
    const had = ((row['offers'] ?? (row['body'] as Record<string, unknown> | undefined)?.['offers']) ?? []) as Offer[];
    return replace(key, { ...(kit && { kit }), offers: settled(had, offers, now) });
  },
});

/** Add a member. The id is made here so the row shows at once and the peer keeps it. */
export const createMember = defineCommand<{ peer: PeerId; id: string; member: Member; checkin?: boolean }, Member>({
  id: 'crew.create',
  owner: (a) => a.peer,
  wire: (a) => ({ ...a.member, id: a.id, ...(a.checkin && { checkin: true }) }),
  optimistic: (_base, a) => [{ e: KIND.member, id: `${a.peer}:${a.id}` as EntityKey, op: 'upsert', v: a.member }],
});

/** Add to crew… on a task (v1 POST /sessions/:id/crew): a new member whose first job is that task. */
export const adoptTask = defineCommand<{ peer: PeerId; sessionId: string; member: Member }, Member>({
  id: 'crew.adopt',
  owner: (a) => a.peer,
  wire: (a) => ({ ...a.member, sessionId: a.sessionId }),
  optimistic: 'none',
  pending: 'Add to crew',
});

/** Remove from crew: its jobs stay as tasks; what it remembers goes. */
export const removeMember = defineCommand<{ key: EntityKey; id: string }>({
  id: 'crew.remove',
  owner: (a) => a.key,
  wire: (a) => ({ id: a.id }),
  optimistic: (_base, a) => [{ e: KIND.member, id: a.key, op: 'del' }],
});

/** Make it mine: the spell lets go of them. */
export const detachMember = defineCommand<{ key: EntityKey; id: string }, Member>({
  id: 'crew.detach',
  owner: (a) => a.key,
  wire: (a) => ({ id: a.id }),
  optimistic: (_base, a) => [{ e: KIND.member, id: a.key, op: 'patch', ops: [{ op: 'remove', path: '/spell' }] }],
});

/** Check in now. Nothing to show before the peer answers: the job arrives as a task. */
export const checkIn = defineCommand<{ key: EntityKey; crewId: string }, { session?: SessionRow; queued?: boolean; already?: boolean }>({
  id: 'crew.checkin',
  owner: (a) => a.key,
  wire: (a) => ({ id: a.crewId }),
  optimistic: 'none',
  pending: 'the crew.checkin control',
});

/**
 * Hand a member a job. Its Starting up card shows at once: a pending task row under the job's own
 * id (`job`), which the peer uses for the task, so the real row replaces it in place.
 */
export const assignJob = defineCommand<
  { key: EntityKey; crewId: string; job: string; prompt: string; title: string; confirmLimit?: boolean; kit?: boolean },
  { session?: SessionRow; queued?: boolean }
>({
  id: 'crew.assign',
  owner: (a) => a.key,
  // the crew's AssignArgs: the member's id and what to do (the peer picks the task's id)
  wire: (a) => ({ id: a.crewId, prompt: a.prompt, ...(a.kit && { kit: true }), ...(a.confirmLimit && { confirmLimit: true }) }),
  // a task row in the peer's own shape (runtime's session row), pending until the real one arrives
  optimistic: (_base, a) => {
    const now = Date.now();
    const row = {
      id: a.job,
      parent_id: null,
      title: a.title,
      state: 'running',
      agent: '',
      archived: false,
      unread: false,
      created_at: now,
      updated_at: now,
      summary: { status: 'running', live: 'Starting…', preview: '', pending: true, turnCount: 0, queued: 0, cwd: '', model: '' },
      body: { ext: { 'wisp.crew': { id: a.crewId, job: 'task', prompt: a.prompt, ...(a.kit && { kit: true }) } } },
    };
    return [{ e: KIND.session, id: `${a.key.slice(0, a.key.indexOf(':'))}:${a.job}` as EntityKey, op: 'upsert', v: row as never }];
  },
  dedupe: (a) => `assign:${a.job}`,
});

// ---------- a job's own task (runtime's commands, used from the thread) ----------

const sessionPatch = (key: EntityKey, ops: Record<string, unknown>): EntityOps => [
  { e: KIND.session, id: key, op: 'patch', ops: Object.entries(ops).map(([k, value]) => ({ op: 'add' as const, path: `/${k}`, value })) },
];

/** Answer a job that asks you: it carries on at once and goes back to asking if refused. */
export const answerJob = defineCommand<{ key: EntityKey; sessionId: string; text: string }>({
  id: 'runtime.answer',
  owner: (a) => a.key,
  wire: (a) => ({ id: a.sessionId, text: a.text }),
  optimistic: (_base, a) => sessionPatch(a.key, { state: 'running', asks: false, question: '', live: '' }),
});

/** Follow up on a job: that job carries on (the member remembers it). */
export const followJob = defineCommand<{ key: EntityKey; sessionId: string; text: string; confirmLimit?: boolean }>({
  id: 'runtime.followUp',
  owner: (a) => a.key,
  wire: (a) => ({ id: a.sessionId, text: a.text }),
  optimistic: (_base, a) => sessionPatch(a.key, { state: 'running', live: '' }),
});

/** Seen in the thread: its report is read. */
export const markRead = defineCommand<{ key: EntityKey; id: string; unread: false }>({
  id: 'runtime.markRead',
  owner: (a) => a.key,
  wire: (a) => ({ id: a.id, unread: false }),
  optimistic: (_base, a) => sessionPatch(a.key, { unread: false }),
  dedupe: (a) => `read:${a.id}`,
});

export const COMMANDS = [updateMember, settleOffer, createMember, removeMember, detachMember, checkIn, assignJob, answerJob, followJob, markRead];

/** A reply in a task that starts with @a member: their job, their answer under the task's latest turn (crew.ask). */
export const askCrew = defineCommand<{ task: EntityKey; id: string; question: string }>({
  id: 'crew.ask',
  owner: (a) => a.task,
  wire: (a) => ({ sessionId: a.task.slice(a.task.indexOf(':') + 1), id: a.id, text: a.question }),
  optimistic: 'none',
  pending: 'the reply box, cleared at once; the answer card shows under the turn',
});

/** The Org chart's layout (v1 GET /crew-layout): where you put each member, x from the chart's middle. */
export type OrgLayout = Record<string, { x: number; y: number }>;
export const getLayout = defineCommand<{ peer: PeerId }, OrgLayout>({ id: 'crew.layout', owner: (a) => a.peer, wire: () => ({}), optimistic: 'none', pending: 'the Org layout' });
/** Save it (v1 PUT /crew-layout); {} puts everyone back in tiers. The page shows it at once and puts it back if refused. */
export const setLayout = defineCommand<{ peer: PeerId; layout: OrgLayout }, OrgLayout>({
  id: 'crew.set_layout',
  owner: (a) => a.peer,
  wire: (a) => ({ layout: a.layout }),
  optimistic: 'none',
  pending: 'the Org layout',
});
