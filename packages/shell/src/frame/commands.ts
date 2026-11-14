// The commands the frame's controls send (design/feedback.md): each says what the screen shows before
// the peer answers. Optimistic where the result is known (a task's row and page, a state, a flag);
// otherwise none, and the control that sent it shows its pending state (Ship it, a restore).
// The ids and args are runtime's, goal's and ship's (plugins/*/api); the mock peer answers them too.

import type { AutoPreview } from './auto.ts';
import type { ColdOut } from './cold.ts';
import { defineCommand, entityKey, type EntityKey, type LocalOp, type PeerId } from '@wisp/client';

/** the bare id the peer knows a task by: nav and rows name it by its entity key (`<peer>:<id>`) */
const bare = (id: string): string => id.slice(id.indexOf(':') + 1);
import { SESSION, type SessionRow } from '../rows.ts';
import { capOf, lifts } from './cap.ts';

type Ops = ReturnType<Exclude<Parameters<typeof defineCommand>[0]['optimistic'], 'none'>>;

const patch = (id: string, path: string, value: unknown): Ops => [{ e: SESSION, id: id as EntityKey, op: 'patch', ops: [{ op: 'replace', path, value }] }];

/** A new task's row as the list shows it, before the peer has answered: running, Starting… */
export function startingRow(o: { id: string; title: string; agent: string; at: number; cwd?: string; projectId?: string; color?: string; mode: string; group?: string; dirs?: readonly string[] }): SessionRow {
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
      ...(o.group && { groupId: o.group }),
    },
    // the other folders it works in: its page's place chips show them at once (F-task-27)
    ...(o.dirs && o.dirs.length > 0 && { body: { dirs: [...o.dirs] } }),
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
  /** one of the harness's accounts (runtime's StartArgs.account); unset: your saved one */
  readonly account?: string;
  readonly at: number;
  readonly cwd?: string;
  readonly projectId?: string;
  readonly color?: string;
  readonly goal?: string;
  /** files that go with the prompt (uploaded first: stuff's /uploads) */
  readonly attachments?: readonly Attachment[];
  /** the delegates it starts with (runtime's StartArgs.team) */
  readonly team?: readonly { readonly name: string; readonly agent: string; readonly model?: string; readonly effort?: string; readonly use?: string }[];
  /** you picked your own harness after Auto's preview showed `key` (runtime tells the router) */
  readonly autoOverride?: { readonly key: string; readonly type?: string };
  /** the harness the new row shows until the server's arrives (Auto's previewed pick); not sent */
  readonly shows?: string;
  /** one of several runs of this ask (the launcher's vs): they share it, as `wisp --compare` does (runtime's slot) */
  readonly group?: string;
  /** a rerun (ADR-0027 lineage): the task it reran, and that task's extra folders and steps */
  readonly lineage?: { readonly rerunOf: string };
  readonly dirs?: readonly string[];
  readonly steps?: readonly string[];
  /** in a worktree of its own (New task's Worktree / In place toggle, `defaults.worktree`) */
  readonly worktree?: boolean;
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
  wire: ({ shows: _shows, group, ...a }) => ({ ...a, ...(group && { ext: { 'wisp.runtime': { group } } }) }),
  optimistic: (_base, a) => [
    { e: SESSION, id: a.id as EntityKey, op: 'upsert', v: startingRow({ ...a, agent: a.shows ?? a.agent, title: a.prompt.split('\n')[0]?.slice(0, 80) ?? a.prompt }) as never },
  ],
});

/**
 * Try it two ways (runtime.trial, F-comp-31, ADR-0056): one task twice on the lead's harness, run B with one setting
 * changed, each in a worktree of its own. Both rows show at once, Starting…, in one group (Compare runs).
 */
export const trial = defineCommand<
  { peer: string; ids: readonly [string, string]; group: string; task: Omit<CreateArgs, 'peer' | 'id' | 'shows' | 'group'>; vary: { subagentModel?: string; skills?: string } },
  { group: string; runs: { id: string }[] }
>({
  id: 'runtime.trial',
  owner: (a) => a.peer,
  // `ids`: the rows the client shows at once (as create's `id`; the mock peer keeps them)
  wire: (a) => ({ ids: [...a.ids], task: { ...a.task, worktree: true }, vary: a.vary }),
  optimistic: (_base, a) =>
    a.ids.map((id, run) => ({
      e: SESSION,
      id: id as EntityKey,
      op: 'upsert' as const,
      v: (() => {
        const row = startingRow({ ...a.task, id, group: a.group, title: a.task.prompt.split('\n')[0]?.slice(0, 80) ?? a.task.prompt });
        // run B's variant on its row at once, as the peer's row will say it
        return { ...row, summary: { ...row.summary, trial: { group: a.group, run }, ...(run === 1 && { variant: a.vary }) } } as never;
      })(),
    })),
});

/** Keep this on a run of Try it two ways (runtime.trial.keep): it stays, the other runs leave the list now. */
export const trialKeep = defineCommand<{ id: string; others: readonly string[] }>({
  id: 'runtime.trial.keep',
  owner: (a) => a.id,
  wire: (a) => ({ id: bare(a.id) }),
  optimistic: (_b, a) => [...patch(a.id, '/archived', false), ...a.others.flatMap((o) => patch(o, '/archived', true))],
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

/** More → Copy resume command (v1 GET /sessions/:id/takeover): the line that resumes the task's conversation. */
export const resumeCommand = defineCommand<{ id: string }, { command: string }>({
  id: 'runtime.resumeCommand',
  owner: (a) => a.id,
  wire: (a) => ({ id: bare(a.id) }),
  optimistic: 'none',
  pending: 'Copy resume command',
});

/** Auto's rules as they are (`router.view`): Never pick reads the list it adds to. */
export const autoRules = defineCommand<{ peer: string }, { settings?: { blocked?: string[] } }>({
  id: 'router.view',
  owner: (a) => a.peer,
  wire: () => ({}),
  optimistic: 'none',
  pending: 'Auto',
});

/** Never pick a model for a kind of task (v1 auto-preview.js never: PATCH /router { blocked }), the whole list. */
export const autoBlocked = defineCommand<{ peer: string; blocked: readonly string[] }, unknown>({
  id: 'router.set',
  owner: (a) => a.peer,
  wire: (a) => ({ blocked: a.blocked }),
  optimistic: 'none',
  pending: 'Never pick',
});

/** A follow-up: it shows in the transcript at once (its turn, under the id the client chose, Starting…),
 * and the task is working again. */
export const followUp = defineCommand<{
  id: string;
  text: string;
  turnId: string;
  idx: number;
  at: number;
  attachments?: readonly Attachment[];
  run?: { agent?: string; model?: string; effort?: string };
  /** while the task works and Settings → Follow-ups says Queue (v1 queued.js): it waits behind the run */
  queue?: boolean;
}>({
  id: 'runtime.followUp',
  owner: (a) => a.id,
  wire: (a) => ({ ...a, id: bare(a.id) }),
  optimistic: (base, a) => (a.queue ? queuedOps(base.peek<SessionRow>(SESSION, a.id as EntityKey), a) : startedOps(a)),
});

/** A queued follow-up shows in the queue over the reply box at once, under its turn id (the peer's item id). */
export function queuedOps(s: SessionRow | undefined, a: { id: string; text: string; turnId: string; at: number; attachments?: readonly Attachment[] }): LocalOp[] {
  const queue = ((s?.body as { queue?: readonly unknown[] } | undefined)?.queue ?? []) as readonly unknown[];
  const item = { id: a.turnId, text: a.text, at: a.at, ...(a.attachments?.length && { attachments: a.attachments }) };
  return [
    {
      e: SESSION,
      id: a.id as EntityKey,
      op: 'patch',
      ops: [
        { op: 'add', path: '/body/queue', value: [...queue, item] },
        { op: 'replace', path: '/summary/queued', value: queue.length + 1 },
      ],
    },
  ];
}

function startedOps(a: { id: string; text: string; turnId: string; idx: number; at: number }): LocalOp[] {
  return [
    {
      e: SESSION,
      id: a.id as EntityKey,
      op: 'patch',
      ops: [
        { op: 'replace', path: '/state', value: 'running' },
        { op: 'replace', path: '/summary/live', value: 'Starting…' },
        // a new question brings an archived task back (v1 F-task-8; the server does the same when the run starts)
        { op: 'replace', path: '/archived', value: false },
      ],
    },
    {
      e: 'turn',
      id: a.turnId as EntityKey,
      op: 'upsert',
      v: { id: a.turnId, session_id: a.id, idx: a.idx, status: 'running', started_at: a.at, ended_at: null, prompt: a.text, answer: '', body: { prompt: a.text, status: 'running' } } as never,
    },
  ];
}

/** Opening a task reads it (v1 feed.js): the row loses its bold at once. */
export const markRead = defineCommand<{ id: string; unread: boolean }>({
  id: 'runtime.markRead',
  owner: (a) => a.id,
  wire: (a) => ({ ...a, id: bare(a.id) }),
  optimistic: (_b, a) => patch(a.id, '/unread', a.unread),
});

/** Mark done: the row moves to Done at once. */
/** Rename in place (the head's title): the title changes everywhere at once. */
export const rename = defineCommand<{ id: string; title: string }>({
  id: 'runtime.rename',
  owner: (a) => a.id,
  wire: (a) => ({ id: bare(a.id), title: a.title }),
  optimistic: (_b, a) => patch(a.id, '/title', a.title),
});
export const setState = defineCommand<{ id: string; state: 'running' | 'review' | 'done' | 'error' }>({
  id: 'runtime.setState',
  owner: (a) => a.id,
  wire: (a) => ({ ...a, id: bare(a.id) }),
  optimistic: (_b, a) => patch(a.id, '/state', a.state),
});

/** Save for later: the bookmark fills at once. */
export const forLater = defineCommand<{ id: string; forLater: boolean }>({
  id: 'runtime.forLater',
  owner: (a) => a.id,
  wire: (a) => ({ ...a, id: bare(a.id) }),
  optimistic: (_b, a) => patch(a.id, '/summary/forLater', a.forLater),
});

/** Stop: the run ends where it is; queued follow-ups stay, held (v1 /stop). It answers once the run has wound down. */
export const stopRun = defineCommand<{ id: string }>({ id: 'runtime.stop', owner: (a) => a.id, wire: (a) => ({ id: bare(a.id) }), optimistic: 'none', pending: 'Stopping…' });

export const archive = defineCommand<{ id: string; archived: boolean }>({
  id: 'runtime.archive',
  owner: (a) => a.id,
  wire: (a) => ({ ...a, id: bare(a.id) }),
  optimistic: (_b, a) => patch(a.id, '/archived', a.archived),
});

export const remove = defineCommand<{ id: string }>({
  id: 'runtime.delete',
  owner: (a) => a.id,
  wire: (a) => ({ ...a, id: bare(a.id) }),
  optimistic: (_b, a) => [{ e: SESSION, id: a.id as EntityKey, op: 'del' }],
});

export const setMode = defineCommand<{ id: string; mode: string }>({
  id: 'runtime.setMode',
  owner: (a) => a.id,
  wire: (a) => ({ ...a, id: bare(a.id) }),
  // above the task's cap, the user's switch lifts it (F-chan-10): the pill goes with the same frame
  optimistic: (base, a) => {
    const row = base.peek<SessionRow>(SESSION, a.id as EntityKey);
    const lift = lifts(a.mode, capOf(row?.summary));
    return [{ e: SESSION, id: a.id as EntityKey, op: 'patch', ops: [{ op: 'replace', path: '/summary/mode', value: a.mode }, ...(lift ? [{ op: 'remove' as const, path: '/summary/capped' }] : [])] }];
  },
});

export const setAgent = defineCommand<{ id: string; agent: string }>({
  id: 'runtime.setAgent',
  owner: (a) => a.id,
  wire: (a) => ({ ...a, id: bare(a.id) }),
  optimistic: (_b, a) => patch(a.id, '/agent', a.agent),
});

export const setGoal = defineCommand<{ id: string; text: string }>({
  id: 'goal.set',
  owner: (a) => a.id,
  wire: (a) => ({ ...a, id: bare(a.id) }),
  optimistic: (_b, a) => patch(a.id, '/summary/goal', a.text.trim() ? { text: a.text, status: 'working', round: 0, checks: [] } : null),
});

/** Rerun and Fork: the new task's row and page show at once (the client names it). */
function copyOf(id: 'runtime.rerun' | 'runtime.fork') {
  return defineCommand<{ id: string; newId: string; agent?: string; at: number }, { id: string }>({
    id,
    owner: (a) => a.id,
    wire: (a) => ({ ...a, id: bare(a.id) }),
    optimistic: (base, a) => {
      const src = base.peek<SessionRow>(SESSION, a.id as EntityKey) as SessionRow | undefined;
      if (!src) return [];
      const row: SessionRow = {
        ...src,
        id: a.newId,
        state: 'running',
        unread: false,
        created_at: a.at,
        updated_at: a.at,
        ...(a.agent && { agent: a.agent }),
        summary: { ...src.summary, status: 'running', live: 'Starting…', overlaps: [] },
      };
      return [{ e: SESSION, id: a.newId as EntityKey, op: 'upsert', v: row as never }];
    },
  });
}
export const rerun = copyOf('runtime.rerun');
export const fork = copyOf('runtime.fork');

/** Ship it: no result to show before the push, so the button shows it's working. */

/** Restore the worktree to before a turn (git keeps a checkpoint as each turn starts): the rollback button shows it's working. */
export const restore = defineCommand<{ id: string; turn: string }, { restored: boolean }>({
  id: 'git.restoreTurn',
  owner: (a) => a.id,
  wire: (a) => ({ id: bare(a.id), turn: a.turn }),
  optimistic: 'none',
  pending: 'the turn’s restore button (tb-btn rollback)',
});

/** A setting on this wisp (the new-task defaults): it reads its new value at once. */
export const setSetting = defineCommand<{ peer: string; key: string; value: unknown }>({
  id: 'settings.set',
  owner: (a) => a.peer,
  optimistic: (_b, a) => [{ e: 'setting', id: entityKey(a.peer as PeerId, a.key), op: 'upsert', v: { key: a.key, value: a.value, locked_by: null } as never }],
});

/** An answer's one-click command (actions, terminal, tests), run in the task's folder; the user's click only. */
export const exec = defineCommand<{ id: string; command: string }, { code: number; output: string }>({
  id: 'runtime.exec',
  owner: (a) => a.id,
  wire: (a) => ({ id: bare(a.id), command: a.command }),
  optimistic: 'none',
  pending: 'the block’s Run button',
});
/** 👍 / 👎 on a turn, or the line after 👎 (v1 feedback.js rateTurn, whyForm): to the wisp team through the task's
 *  own wisp, which keeps the rating on the turn (`ext["wisp.telemetry"].feedback`). The thumb lights at once; a
 *  refusal puts it back. `turnKey` is the turn row's key. */
export const rateTurn = defineCommand<{ id: string; turnKey: string; rating: 'up' | 'down' | null; text?: string; at: number }, unknown>({
  id: 'telemetry.feedback',
  owner: (a) => a.id,
  wire: (a) => ({ rating: a.rating, sessionId: bare(a.id), turnId: bare(a.turnKey), source: 'turn', ...(a.text && { text: a.text }) }),
  optimistic: (base, a) => {
    if (a.text) return [];
    const row = base.peek<{ body?: { ext?: Record<string, unknown> } }>('turn', a.turnKey as EntityKey);
    const ext = row?.body?.ext ?? {};
    const own = (ext['wisp.telemetry'] ?? {}) as Record<string, unknown>;
    const feedback = a.rating ? { rating: a.rating, at: a.at } : null;
    return [{ e: 'turn', id: a.turnKey as EntityKey, op: 'patch', ops: [{ op: 'add', path: '/body/ext', value: { ...ext, 'wisp.telemetry': { ...own, feedback } } }] }];
  },
});
/** A turn's rating, as its wisp keeps it. */
export function ratingOf(body: unknown): 'up' | 'down' | undefined {
  const f = ((body as { ext?: Record<string, unknown> } | undefined)?.ext?.['wisp.telemetry'] as { feedback?: { rating?: unknown } | null } | undefined)?.feedback;
  return f?.rating === 'up' || f?.rating === 'down' ? f.rating : undefined;
}
/** Show in folder for an answer's picture, video or doc (v1 POST /sessions/:id/reveal): the file manager opens on the
 *  task's computer; the answer names the file it opened on. */
export const reveal = defineCommand<{ id: string; path: string }, { ok: boolean; path: string }>({
  id: 'runtime.reveal',
  owner: (a) => a.id,
  wire: (a) => ({ id: bare(a.id), path: a.path }),
  optimistic: 'none',
  pending: 'the Show in folder button',
});
/** Reveal one masked .env item (ADR-0050, v1 GET /sessions/:id/unmasked): the server sends every .env value as
 *  KEY=••••, and this asks for one step's output, one answer block or one file's captured change as it is. */
export const unmasked = defineCommand<{ id: string; turnId: string; step?: number; block?: number; file?: string }, Readonly<Record<string, unknown>>>({
  id: 'runtime.unmasked',
  owner: (a) => a.id,
  wire: (a) => ({ id: bare(a.id), turnId: bare(a.turnId), ...(a.step !== undefined && { step: a.step }), ...(a.block !== undefined && { block: a.block }), ...(a.file !== undefined && { file: a.file }) }),
  optimistic: 'none',
  pending: 'the Reveal button, pressed at once; the masked text stays until the value arrives',
});
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
export const setLean = defineCommand<{ id: string; lean?: 'on' | 'off' }>({
  id: 'runtime.setLean',
  owner: (a) => a.id,
  wire: (a) => ({ id: bare(a.id), ...(a.lean && { lean: a.lean }) }),
  optimistic: (_b, a) => patch(a.id, '/body/lean', a.lean ?? null),
});

/** A large idle task's prompt cache and Compact now's estimate (`runtime.cold`, read-only). */
export const coldOf = defineCommand<{ id: string }, ColdOut>({ id: 'runtime.cold', owner: (a) => a.id, wire: (a) => ({ id: bare(a.id) }), optimistic: 'none', pending: 'the cache' });

/** Compact now: the task shrinks to a summary in a turn of its own, working at once. */
export const compactNow = defineCommand<{ id: string }>({ id: 'runtime.compact', owner: (a) => a.id, wire: (a) => ({ id: bare(a.id) }), optimistic: (_b, a) => patch(a.id, '/state', 'running') });

/** ⌘K's past work (v1 F-task-20): words inside prompts and answers (`runtime.search`, the store's full-text index). */
export const searchTasks = defineCommand<{ peer: string; q: string; limit?: number }, readonly { id: string; title: string; snippet: string; updatedAt: number }[]>({
  id: 'runtime.search',
  owner: (a) => a.peer,
  wire: ({ peer: _peer, ...a }) => a,
  optimistic: 'none',
  pending: 'Search',
});

/** A task's spec (ADR-0027): what Rerun… starts from. */
export const specOf = defineCommand<{ id: string }, { prompt: string; steps?: string[]; agent?: string; model?: string; effort?: string; mode?: string; cwd?: string; dirs?: string[] }>({
  id: 'runtime.spec',
  owner: (a) => a.id,
  wire: (a) => ({ id: bare(a.id) }),
  optimistic: 'none',
  pending: 'Rerun',
});

/** "/btw did you …": the side question, or undefined (v1 btw.js btwQuestion; runtime's prompt/btw.rs). */
export const btwQuestion = (text: string): string | undefined => (/^\/btw(?:\s+|$)/i.test(text.trim()) ? text.trim().replace(/^\/btw\s*/i, '') : undefined);

/** A task's /btw entries (`ext["wisp.runtime"].btw`, BtwEntry). */
export interface BtwRow {
  readonly id: string;
  readonly question: string;
  readonly answer?: string;
  readonly at: number;
  readonly pending?: boolean;
  readonly error?: string;
}
export const btwOf = (row: SessionRow | undefined): readonly BtwRow[] => {
  const ext = (row?.body as { ext?: { 'wisp.runtime'?: { btw?: unknown } } } | undefined)?.ext?.['wisp.runtime']?.btw;
  return Array.isArray(ext) ? (ext as BtwRow[]) : [];
};
const withBtw = (row: SessionRow | undefined, list: readonly BtwRow[]): LocalOp[] => {
  if (!row?.body) return [];
  const ext = ((row.body as { ext?: Record<string, unknown> }).ext ?? {}) as Record<string, unknown>;
  const own = (ext['wisp.runtime'] ?? {}) as Record<string, unknown>;
  return [{ e: SESSION, id: row.id as EntityKey, op: 'patch', ops: [{ op: 'add', path: '/body/ext', value: { ...ext, 'wisp.runtime': { ...own, btw: list } } as never }] }];
};

/** /btw: answered on the side, the run carries on (v1 btw.js); it shows at once, answering. */
export const btw = defineCommand<{ id: string; question: string; tmp: string; at: number }, BtwRow>({
  id: 'runtime.btw',
  owner: (a) => a.id,
  wire: (a) => ({ id: bare(a.id), question: a.question }),
  optimistic: (base, a) => {
    const row = base.peek<SessionRow>(SESSION, a.id as EntityKey) as SessionRow | undefined;
    return withBtw(row, [...btwOf(row), { id: a.tmp, question: a.question, at: a.at, pending: true }]);
  },
});

/** × on a /btw: gone at once (one still answering is cancelled). */
export const btwDrop = defineCommand<{ id: string; btwId: string }>({
  id: 'runtime.btw.drop',
  owner: (a) => a.id,
  wire: (a) => ({ id: bare(a.id), btwId: a.btwId }),
  optimistic: (base, a) => {
    const row = base.peek<SessionRow>(SESSION, a.id as EntityKey) as SessionRow | undefined;
    return withBtw(
      row,
      btwOf(row).filter((b) => b.id !== a.btwId),
    );
  },
});
