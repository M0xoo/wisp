// The task-level commands the task view sends (v1 POST /api/sessions/:id/…, one command each). Every
// one declares what shows at once; the peer's patches follow, and a refusal rolls it back with a
// toast. Ids mirror v1's routes so runtime's route adapters map 1:1. Args carry the entity key: its
// peer runs the command (origin routing).
import { defineCommand, type EntityKey, type EntityReader, type LocalOp } from '@wisp/client';
import { KIND, type Mode, type TaskRow } from '../types.ts';

const patch = (key: EntityKey, ops: { path: string; value: unknown }[]): LocalOp => ({ e: KIND.session, id: key, op: 'patch', ops: ops.map((o) => ({ op: 'replace', ...o })) });
const has = (base: EntityReader, key: EntityKey): boolean => base.peek<TaskRow>(KIND.session, key) !== undefined;
const owner = (a: { key: EntityKey }): string => a.key;
/** the bare id the peer knows the task by */
const bare = (key: EntityKey): string => key.slice(key.indexOf(':') + 1);

export const rename = defineCommand<{ key: EntityKey; title: string }>({
  id: 'runtime.rename',
  wire: (a) => ({ id: bare(a.key), title: a.title }),
  owner,
  optimistic: (base, a) => (has(base, a.key) ? [patch(a.key, [{ path: '/title', value: a.title }])] : []),
});

export const stop = defineCommand<{ key: EntityKey }>({
  id: 'runtime.stop',
  wire: (a) => ({ id: bare(a.key) }),
  owner,
  // the run winds down on the peer; the live panel says Stopping… from its own machine
  optimistic: 'none', pending: 'the session.stop control',
});

export const setMode = defineCommand<{ key: EntityKey; mode: Mode }>({
  id: 'session.setMode',
  owner,
  optimistic: (base, a) => (has(base, a.key) ? [patch(a.key, [{ path: '/mode', value: a.mode }])] : []),
});

/** A follow-up: what `next`, `actions` replies and question answers send (the composer has its own). */
export const reply = defineCommand<{ key: EntityKey; text: string; by?: string }>({
  id: 'runtime.followUp',
  wire: (a) => ({ id: bare(a.key), text: a.text, ...(a.by !== undefined && { by: a.by }) }),
  owner,
  optimistic: (base, a) => (has(base, a.key) ? [patch(a.key, [{ path: '/state', value: 'running' }, { path: '/live', value: 'Starting up' }])] : []),
});

/** Answers the agent's live question (ask_user) or approval (Allow / Deny). */
export const answer = defineCommand<{ key: EntityKey; answer: string | string[]; allow?: boolean; always?: boolean }>({
  id: 'runtime.answer',
  wire: (a) => ({ id: bare(a.key), text: a.allow === false ? 'deny' : a.always ? 'always' : a.allow ? 'allow' : Array.isArray(a.answer) ? a.answer.join(', ') : a.answer }),
  owner,
  optimistic: (base, a) => {
    const s = base.peek<TaskRow>(KIND.session, a.key);
    if (!s?.ask) return [];
    return [{ e: KIND.session, id: a.key, op: 'patch', ops: [{ op: 'remove', path: '/ask' }, { op: 'replace', path: '/asks', value: false }] }];
  },
});

/** Allow & retry on a blocked call: widen the sandbox or the mode for it, and run the turn again. */
export const allowRetry = defineCommand<{ key: EntityKey; tool?: string; detail?: string }>({
  id: 'runtime.approveBlocked',
  wire: (a) => ({ id: bare(a.key), ...(a.tool !== undefined && { tool: a.tool }), ...(a.detail !== undefined && { detail: a.detail }) }),
  owner,
  optimistic: (base, a) => (has(base, a.key) ? [patch(a.key, [{ path: '/state', value: 'running' }])] : []),
});

/** A one-click command from an `actions` block, run in the task's folder (v1 /exec). */
export const exec = defineCommand<{ key: EntityKey; command: string }, { code: number; output: string }>({
  id: 'session.exec',
  owner,
  optimistic: 'none', pending: 'the session.exec control',
});

export const markDone = defineCommand<{ key: EntityKey }>({
  id: 'runtime.setState',
  wire: (a) => ({ id: bare(a.key), state: 'done' }),
  owner,
  optimistic: (base, a) => (has(base, a.key) ? [patch(a.key, [{ path: '/state', value: 'done' }])] : []),
});

export const reopen = defineCommand<{ key: EntityKey }>({
  id: 'runtime.setState',
  wire: (a) => ({ id: bare(a.key), state: 'review' }),
  owner,
  optimistic: (base, a) => (has(base, a.key) ? [patch(a.key, [{ path: '/state', value: 'review' }])] : []),
});

export const archive = defineCommand<{ key: EntityKey; archived: boolean }>({
  id: 'runtime.archive',
  wire: (a) => ({ id: bare(a.key), archived: a.archived }),
  owner,
  optimistic: (base, a) => (has(base, a.key) ? [patch(a.key, [{ path: '/archived', value: a.archived }])] : []),
});

export const fork = defineCommand<{ key: EntityKey; turnId?: string }, { id: string }>({
  id: 'runtime.fork',
  wire: (a) => ({ id: bare(a.key), ...(a.turnId !== undefined && { turnId: a.turnId }) }),
  owner,
  optimistic: 'none', pending: 'the session.fork control',
});

export const rerun = defineCommand<{ key: EntityKey; turnId: string }>({
  id: 'runtime.rerun',
  wire: (a) => ({ id: bare(a.key), turnId: a.turnId }),
  owner,
  optimistic: (base, a) => (has(base, a.key) ? [patch(a.key, [{ path: '/state', value: 'running' }])] : []),
});

export const compact = defineCommand<{ key: EntityKey }>({
  id: 'runtime.compact',
  wire: (a) => ({ id: bare(a.key) }),
  owner,
  optimistic: (base, a) => (has(base, a.key) ? [patch(a.key, [{ path: '/state', value: 'running' }, { path: '/live', value: 'Compacting' }])] : []),
});

/** Releases a held turn: Run now / Trust and run / Wait for the reset (v1 /held). */
export const releaseHeld = defineCommand<{ key: EntityKey; turnId: string; action: 'run' | 'trust' | 'wait' | 'cancel' | 'switch'; to?: string }>({
  id: 'runtime.release',
  // runtime.release runs or skips a held turn; waiting is the default (nothing to send), switching runs it
  wire: (a) => ({ id: bare(a.key), turnId: a.turnId, action: a.action === 'cancel' ? 'skip' : 'start' }),
  owner,
  optimistic: 'none', pending: 'the session.held control',
});

/** Saves an `app` block's state (v1 /app-state). */
export const appState = defineCommand<{ key: EntityKey; turnId: string; block: string; state: unknown }>({
  id: 'session.appState',
  owner,
  optimistic: 'none', pending: 'the session.appState control',
});
