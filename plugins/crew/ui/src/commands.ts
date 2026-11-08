// Every write the crew's screens make: a command with its optimistic patch (the UI shows it at once
// and rolls back with a toast on reject), ids from the crew's contract (v2-ts-server-reference
// plugins/crew/api COMMANDS). `key` routes the command to the peer that owns the row (origin
// routing); the peer reads `id`.

import { defineCommand, type EntityKey, type EntityOps, type PeerId } from '@wisp/client';
import { KIND, type Member, type SessionRow } from './types.ts';

/** The member fields the editor and the page change. */
export type MemberPatch = Partial<Pick<Member, 'name' | 'role' | 'avatar' | 'color' | 'brief' | 'cron' | 'on' | 'parallel' | 'team' | 'cwd' | 'machine' | 'sandbox' | 'agent' | 'model' | 'effort' | 'mode' | 'paused' | 'kit' | 'notebook'>>;

const replace = (key: EntityKey, patch: Record<string, unknown>): EntityOps => [
  { e: KIND.member, id: key, op: 'patch', ops: Object.entries(patch).map(([k, value]) => ({ op: 'add' as const, path: `/${k}`, value })) },
];

/** Change a member (Pause, Resume, Edit… Save, the kit's switches): crew.update. */
export const updateMember = defineCommand<{ key: EntityKey; id: string } & MemberPatch, Member>({
  id: 'crew.update',
  owner: (a) => a.key,
  optimistic: (_base, { key, id: _id, ...patch }) => replace(key, patch),
});

/** Add a member. The id is made here so the row shows at once and the peer keeps it. */
export const createMember = defineCommand<{ peer: PeerId; id: string; member: Member; checkin?: boolean }, Member>({
  id: 'crew.create',
  owner: (a) => a.peer,
  optimistic: (_base, a) => [{ e: KIND.member, id: `${a.peer}:${a.id}` as EntityKey, op: 'upsert', v: a.member }],
});

/** Remove from crew: its jobs stay as tasks; what it remembers goes. */
export const removeMember = defineCommand<{ key: EntityKey; id: string }>({
  id: 'crew.remove',
  owner: (a) => a.key,
  optimistic: (_base, a) => [{ e: KIND.member, id: a.key, op: 'del' }],
});

/** Make it mine: the spell lets go of them. */
export const detachMember = defineCommand<{ key: EntityKey; id: string }, Member>({
  id: 'crew.detach',
  owner: (a) => a.key,
  optimistic: (_base, a) => [{ e: KIND.member, id: a.key, op: 'patch', ops: [{ op: 'remove', path: '/spell' }] }],
});

/** Check in now. Nothing to show before the peer answers: the job arrives as a task. */
export const checkIn = defineCommand<{ key: EntityKey; crewId: string }, { session?: SessionRow; queued?: boolean; already?: boolean }>({
  id: 'crew.checkin',
  owner: (a) => a.key,
  optimistic: 'none', pending: 'the crew.checkin control',
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
  optimistic: (_base, a) => {
    const now = Date.now();
    const row: SessionRow = { id: a.job, title: a.title, agent: '', cwd: '', state: 'running', pending: true, createdAt: now, updatedAt: now, crew: { id: a.crewId, job: 'task', prompt: a.prompt, ...(a.kit && { kit: true }) } };
    return [{ e: KIND.session, id: `${a.key.slice(0, a.key.indexOf(':'))}:${a.job}` as EntityKey, op: 'upsert', v: row }];
  },
  dedupe: (a) => `assign:${a.job}`,
});

// ---------- a job's own task (runtime's commands, used from the thread) ----------

const sessionPatch = (key: EntityKey, ops: Record<string, unknown>): EntityOps => [
  { e: KIND.session, id: key, op: 'patch', ops: Object.entries(ops).map(([k, value]) => ({ op: 'add' as const, path: `/${k}`, value })) },
];

/** Answer a job that asks you: it carries on at once and goes back to asking if refused. */
export const answerJob = defineCommand<{ key: EntityKey; sessionId: string; text: string }>({
  id: 'session.answer',
  owner: (a) => a.key,
  optimistic: (_base, a) => sessionPatch(a.key, { state: 'running', asks: false, question: '', live: '' }),
});

/** Follow up on a job: that job carries on (the member remembers it). */
export const followJob = defineCommand<{ key: EntityKey; sessionId: string; text: string; confirmLimit?: boolean }>({
  id: 'session.followUp',
  owner: (a) => a.key,
  optimistic: (_base, a) => sessionPatch(a.key, { state: 'running', live: '' }),
});

/** Seen in the thread: its report is read. */
export const markRead = defineCommand<{ key: EntityKey; id: string; unread: false }>({
  id: 'session.update',
  owner: (a) => a.key,
  optimistic: (_base, a) => sessionPatch(a.key, { unread: false }),
  dedupe: (a) => `read:${a.id}`,
});

export const COMMANDS = [updateMember, createMember, removeMember, detachMember, checkIn, assignJob, answerJob, followJob, markRead];
