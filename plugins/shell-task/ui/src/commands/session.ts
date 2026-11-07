// The task-level commands the task view sends (v1 POST /api/sessions/:id/…, one command each). Every
// one declares what shows at once; the peer's patches follow, and a refusal rolls it back with a
// toast. Ids mirror v1's routes so runtime's route adapters map 1:1. Args carry the entity key: its
// peer runs the command (origin routing).
import { defineCommand, type EntityKey, type EntityReader, type LocalOp } from '@wisp/client';
import { KIND, type Mode, type TaskRow } from '../types.ts';

const patch = (key: EntityKey, ops: { path: string; value: unknown }[]): LocalOp => ({ e: KIND.session, id: key, op: 'patch', ops: ops.map((o) => ({ op: 'replace', ...o })) });
const has = (base: EntityReader, key: EntityKey): boolean => base.peek<TaskRow>(KIND.session, key) !== undefined;
const owner = (a: { key: EntityKey }): string => a.key;

export const rename = defineCommand<{ key: EntityKey; title: string }>({
  id: 'session.rename',
  owner,
  optimistic: (base, a) => (has(base, a.key) ? [patch(a.key, [{ path: '/title', value: a.title }])] : []),
});

export const stop = defineCommand<{ key: EntityKey }>({
  id: 'session.stop',
  owner,
  // the run winds down on the peer; the live panel says Stopping… from its own machine
  optimistic: 'none',
});

export const setMode = defineCommand<{ key: EntityKey; mode: Mode }>({
  id: 'session.setMode',
  owner,
  optimistic: (base, a) => (has(base, a.key) ? [patch(a.key, [{ path: '/mode', value: a.mode }])] : []),
});

/** A follow-up: what `next`, `actions` replies and question answers send (the composer has its own). */
export const reply = defineCommand<{ key: EntityKey; text: string; by?: string }>({
  id: 'session.reply',
  owner,
  optimistic: (base, a) => (has(base, a.key) ? [patch(a.key, [{ path: '/state', value: 'running' }, { path: '/live', value: 'Starting up' }])] : []),
});

/** Answers the agent's live question (ask_user) or approval (Allow / Deny). */
export const answer = defineCommand<{ key: EntityKey; answer: string | string[]; allow?: boolean; always?: boolean }>({
  id: 'session.answer',
  owner,
  optimistic: (base, a) => {
    const s = base.peek<TaskRow>(KIND.session, a.key);
    if (!s?.ask) return [];
    return [{ e: KIND.session, id: a.key, op: 'patch', ops: [{ op: 'remove', path: '/ask' }, { op: 'replace', path: '/asks', value: false }] }];
  },
});

/** Allow & retry on a blocked call: widen the sandbox or the mode for it, and run the turn again. */
export const allowRetry = defineCommand<{ key: EntityKey; tool?: string; detail?: string }>({
  id: 'session.allowRetry',
  owner,
  optimistic: (base, a) => (has(base, a.key) ? [patch(a.key, [{ path: '/state', value: 'running' }])] : []),
});

/** A one-click command from an `actions` block, run in the task's folder (v1 /exec). */
export const exec = defineCommand<{ key: EntityKey; command: string }, { code: number; output: string }>({
  id: 'session.exec',
  owner,
  optimistic: 'none',
});

export const markDone = defineCommand<{ key: EntityKey }>({
  id: 'session.markDone',
  owner,
  optimistic: (base, a) => (has(base, a.key) ? [patch(a.key, [{ path: '/state', value: 'done' }])] : []),
});

export const reopen = defineCommand<{ key: EntityKey }>({
  id: 'session.reopen',
  owner,
  optimistic: (base, a) => (has(base, a.key) ? [patch(a.key, [{ path: '/state', value: 'review' }])] : []),
});

export const archive = defineCommand<{ key: EntityKey; archived: boolean }>({
  id: 'session.archive',
  owner,
  optimistic: (base, a) => (has(base, a.key) ? [patch(a.key, [{ path: '/archived', value: a.archived }])] : []),
});

export const fork = defineCommand<{ key: EntityKey; turnId?: string }, { id: string }>({
  id: 'session.fork',
  owner,
  optimistic: 'none',
});

export const rerun = defineCommand<{ key: EntityKey; turnId: string }>({
  id: 'session.rerun',
  owner,
  optimistic: (base, a) => (has(base, a.key) ? [patch(a.key, [{ path: '/state', value: 'running' }])] : []),
});

export const compact = defineCommand<{ key: EntityKey }>({
  id: 'session.compact',
  owner,
  optimistic: (base, a) => (has(base, a.key) ? [patch(a.key, [{ path: '/state', value: 'running' }, { path: '/live', value: 'Compacting' }])] : []),
});

/** Releases a held turn: Run now / Trust and run / Wait for the reset (v1 /held). */
export const releaseHeld = defineCommand<{ key: EntityKey; turnId: string; action: 'run' | 'trust' | 'wait' | 'cancel' | 'switch'; to?: string }>({
  id: 'session.held',
  owner,
  optimistic: 'none',
});

/** Saves an `app` block's state (v1 /app-state). */
export const appState = defineCommand<{ key: EntityKey; turnId: string; block: string; state: unknown }>({
  id: 'session.appState',
  owner,
  optimistic: 'none',
});
