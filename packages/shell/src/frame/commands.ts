// The commands the frame's controls send (design/feedback.md): each says what the screen shows before
// the peer answers. Optimistic where the result is known (a task's row and page, a state, a flag);
// otherwise none, and the control that sent it shows its pending state (Ship it, a restore).
// The ids and args are runtime's, goal's and ship's (plugins/*/api); the mock peer answers them too.

import type { AutoPreview } from './auto.ts';
import type { ColdOut } from './cold.ts';
import { defineCommand, entityKey, type EntityKey, type PeerId } from '@wisp/client';

/** the bare id the peer knows a task by: nav and rows name it by its entity key (`<peer>:<id>`) */
const bare = (id: string): string => id.slice(id.indexOf(':') + 1);
import { SESSION, type SessionRow } from '../rows.ts';

type Ops = ReturnType<Exclude<Parameters<typeof defineCommand>[0]['optimistic'], 'none'>>;

const patch = (id: string, path: string, value: unknown): Ops => [{ e: SESSION, id: id as EntityKey, op: 'patch', ops: [{ op: 'replace', path, value }] }];

/** A new task's row as the list shows it, before the peer has answered: running, Starting… */
export function startingRow(o: { id: string; title: string; agent: string; at: number; cwd?: string; projectId?: string; color?: string; mode: string }): SessionRow {
  return {
    id: o.id,
    parent_id: null,
    title: o.title,
    state: 'running',
    agent: o.agent,
    archived: false,
    unread: false,
    created_at: o.at,
    updated_at: o.at,
    summary: {
      status: 'running',
      turnCount: 1,
      queued: 0,
      preview: '',
      live: 'Starting…',
      cwd: o.cwd ?? '',
      model: '',
      mode: o.mode,
      ...(o.projectId && { projectId: o.projectId }),
      ...(o.color && { color: o.color }),
    },
  };
}

export interface CreateArgs {
  readonly peer: string;
  readonly id: string;
  readonly prompt: string;
  readonly agent: string;
  readonly mode: string;
  readonly model?: string;
  readonly effort?: string;
  readonly at: number;
  readonly cwd?: string;
  readonly projectId?: string;
  readonly color?: string;
  readonly goal?: string;
  /** files that go with the prompt (uploaded first: stuff's /uploads) */
  readonly attachments?: readonly Attachment[];
  /** you picked your own harness after Auto's preview showed `key` (runtime tells the router) */
  readonly autoOverride?: { readonly key: string; readonly type?: string };
  /** the harness the new row shows until the server's arrives (Auto's previewed pick); not sent */
  readonly shows?: string;
}

/** A file sent with a prompt (runtime's Attachment): what stuff's upload answered. */
export interface Attachment {
  readonly id: string;
  readonly name: string;
  readonly mime: string;
  readonly size: number;
}

/** New task: its row and page show at once, Starting… */
export const create = defineCommand<CreateArgs, { id: string }>({
  id: 'runtime.create',
  owner: (a) => a.peer,
  wire: ({ shows: _shows, ...a }) => a,
  optimistic: (_base, a) => [{ e: SESSION, id: a.id as EntityKey, op: 'upsert', v: startingRow({ ...a, agent: a.shows ?? a.agent, title: a.prompt.split('\n')[0]?.slice(0, 80) ?? a.prompt }) as never }],
});

/** What Auto would run for the launcher's prompt (`router.preview`, read-only; the router plugin off: refused). */
export const autoPreview = defineCommand<{ peer: string; prompt: string; attachments?: number; goal?: string; team?: boolean }, AutoPreview>({
  id: 'router.preview',
  owner: (a) => a.peer,
  wire: ({ peer: _peer, ...a }) => a,
  optimistic: 'none',
  pending: 'Auto',
  dedupe: (a) => JSON.stringify([a.peer, a.prompt, a.attachments, a.goal, a.team]),
});

/** A follow-up: it shows in the transcript at once (its turn, under the id the client chose, Starting…),
 * and the task is working again. */
export const followUp = defineCommand<{ id: string; text: string; turnId: string; idx: number; at: number; attachments?: readonly Attachment[] }>({
  id: 'runtime.followUp',
  owner: (a) => a.id, wire: (a) => ({ ...a, id: bare(a.id) }),
  optimistic: (_base, a) => [
    { e: SESSION, id: a.id as EntityKey, op: 'patch', ops: [{ op: 'replace', path: '/state', value: 'running' }, { op: 'replace', path: '/summary/live', value: 'Starting…' }] },
    { e: 'turn', id: a.turnId as EntityKey, op: 'upsert', v: { id: a.turnId, session_id: a.id, idx: a.idx, status: 'running', started_at: a.at, ended_at: null, prompt: a.text, answer: '', body: { prompt: a.text, status: 'running' } } as never },
  ],
});

/** Opening a task reads it (v1 feed.js): the row loses its bold at once. */
export const markRead = defineCommand<{ id: string; unread: boolean }>({ id: 'runtime.markRead', owner: (a) => a.id, wire: (a) => ({ ...a, id: bare(a.id) }), optimistic: (_b, a) => patch(a.id, '/unread', a.unread) });

/** Mark done: the row moves to Done at once. */
/** Rename in place (the head's title): the title changes everywhere at once. */
export const rename = defineCommand<{ id: string; title: string }>({ id: 'runtime.rename', owner: (a) => a.id, wire: (a) => ({ id: bare(a.id), title: a.title }), optimistic: (_b, a) => patch(a.id, '/title', a.title) });
export const setState = defineCommand<{ id: string; state: 'running' | 'review' | 'done' | 'error' }>({ id: 'runtime.setState', owner: (a) => a.id, wire: (a) => ({ ...a, id: bare(a.id) }), optimistic: (_b, a) => patch(a.id, '/state', a.state) });

/** Save for later: the bookmark fills at once. */
export const forLater = defineCommand<{ id: string; forLater: boolean }>({ id: 'runtime.forLater', owner: (a) => a.id, wire: (a) => ({ ...a, id: bare(a.id) }), optimistic: (_b, a) => patch(a.id, '/summary/forLater', a.forLater) });

export const archive = defineCommand<{ id: string; archived: boolean }>({ id: 'runtime.archive', owner: (a) => a.id, wire: (a) => ({ ...a, id: bare(a.id) }), optimistic: (_b, a) => patch(a.id, '/archived', a.archived) });

export const remove = defineCommand<{ id: string }>({ id: 'runtime.delete', owner: (a) => a.id, wire: (a) => ({ ...a, id: bare(a.id) }), optimistic: (_b, a) => [{ e: SESSION, id: a.id as EntityKey, op: 'del' }] });

export const setMode = defineCommand<{ id: string; mode: string }>({ id: 'runtime.setMode', owner: (a) => a.id, wire: (a) => ({ ...a, id: bare(a.id) }), optimistic: (_b, a) => patch(a.id, '/summary/mode', a.mode) });

export const setAgent = defineCommand<{ id: string; agent: string }>({ id: 'runtime.setAgent', owner: (a) => a.id, wire: (a) => ({ ...a, id: bare(a.id) }), optimistic: (_b, a) => patch(a.id, '/agent', a.agent) });

export const setGoal = defineCommand<{ id: string; text: string }>({ id: 'goal.set', owner: (a) => a.id, wire: (a) => ({ ...a, id: bare(a.id) }), optimistic: (_b, a) => patch(a.id, '/summary/goal', a.text.trim() ? { text: a.text, status: 'working', round: 0, checks: [] } : null) });

/** Rerun and Fork: the new task's row and page show at once (the client names it). */
function copyOf(id: 'runtime.rerun' | 'runtime.fork') {
  return defineCommand<{ id: string; newId: string; agent?: string; at: number }, { id: string }>({
    id,
    owner: (a) => a.id, wire: (a) => ({ ...a, id: bare(a.id) }),
    optimistic: (base, a) => {
      const src = base.peek<SessionRow>(SESSION, a.id as EntityKey) as SessionRow | undefined;
      if (!src) return [];
      const row: SessionRow = { ...src, id: a.newId, state: 'running', unread: false, created_at: a.at, updated_at: a.at, ...(a.agent && { agent: a.agent }), summary: { ...src.summary, status: 'running', live: 'Starting…', overlaps: [] } };
      return [{ e: SESSION, id: a.newId as EntityKey, op: 'upsert', v: row as never }];
    },
  });
}
export const rerun = copyOf('runtime.rerun');
export const fork = copyOf('runtime.fork');

/** Ship it: no result to show before the push, so the button shows it's working. */

/** Restore the worktree to before a turn (git keeps a checkpoint as each turn starts): the rollback button shows it's working. */
export const restore = defineCommand<{ id: string; turn: string }, { restored: boolean }>({ id: 'git.restoreTurn', owner: (a) => a.id, wire: (a) => ({ id: bare(a.id), turn: a.turn }), optimistic: 'none', pending: 'the turn’s restore button (tb-btn rollback)' });

/** A setting on this wisp (the new-task defaults): it reads its new value at once. */
export const setSetting = defineCommand<{ peer: string; key: string; value: unknown }>({
  id: 'settings.set',
  owner: (a) => a.peer,
  optimistic: (_b, a) => [{ e: 'setting', id: entityKey(a.peer as PeerId, a.key), op: 'upsert', v: { key: a.key, value: a.value, locked_by: null } as never }],
});

/** An answer's one-click command (actions, terminal, tests), run in the task's folder; the user's click only. */
export const exec = defineCommand<{ id: string; command: string }, { code: number; output: string }>({ id: 'runtime.exec', owner: (a) => a.id, wire: (a) => ({ id: bare(a.id), command: a.command }), optimistic: 'none', pending: 'the block’s Run button' });
/** A `blocked` block's Allow & retry / Deny. */
export const approveBlocked = defineCommand<{ id: string; turnId: string; allow: boolean }, unknown>({
  id: 'runtime.approveBlocked',
  owner: (a) => a.id,
  wire: (a) => ({ id: bare(a.id), turnId: bare(a.turnId), allow: a.allow }),
  optimistic: 'none',
  pending: 'the blocked card, settled at once',
});
/** An `app` block's saved state, kept on its turn (`ext["wisp.apps"][block]`). */
export const appState = defineCommand<{ id: string; turnId: string; block: string; state: unknown }, unknown>({
  id: 'runtime.appState',
  owner: (a) => a.id,
  wire: (a) => ({ id: bare(a.id), turnId: bare(a.turnId), block: a.block, state: a.state }),
  optimistic: 'none',
  pending: 'none: the app keeps its own state while it runs',
});

/** This task's own lean runs ('on' | 'off'), or none to follow Settings (runtime.leanRuns). */
export const setLean = defineCommand<{ id: string; lean?: 'on' | 'off' }>({ id: 'runtime.setLean', owner: (a) => a.id, wire: (a) => ({ id: bare(a.id), ...(a.lean && { lean: a.lean }) }), optimistic: (_b, a) => patch(a.id, '/body/lean', a.lean ?? null) });

/** A large idle task's prompt cache and Compact now's estimate (`runtime.cold`, read-only). */
export const coldOf = defineCommand<{ id: string }, ColdOut>({ id: 'runtime.cold', owner: (a) => a.id, wire: (a) => ({ id: bare(a.id) }), optimistic: 'none', pending: 'the cache' });

/** Compact now: the task shrinks to a summary in a turn of its own, working at once. */
export const compactNow = defineCommand<{ id: string }>({ id: 'runtime.compact', owner: (a) => a.id, wire: (a) => ({ id: bare(a.id) }), optimistic: (_b, a) => patch(a.id, '/state', 'running') });
