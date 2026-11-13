// The mock peer's commands, named and shaped as the Rust plugins declare them
// (plugins/runtime/api/src/commands, the settings plugin). A handler reads the current rows and
// returns the ops one commit makes; throwing `{ code, message }` refuses the command (the client
// rolls its optimistic patch back and toasts the message). UI agents: add the commands your screen
// sends here, with the args the plugin's api crate has.

import type { EntityOp, PatchOp, Topic } from '@wisp/protocol';
import { gitChanges, gitCommit, gitRevert, gitStage, type GitCtx } from './mock-git.ts';

const EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const MOCK_AGENTS = [
  {
    id: 'claude',
    name: 'Claude Code',
    available: true,
    efforts: EFFORTS,
    models: [
      { id: '', label: 'Default' },
      { id: 'claude-opus-5-5', label: 'Opus 5.5', efforts: EFFORTS },
      { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', efforts: EFFORTS },
      { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
    ],
  },
  {
    id: 'codex',
    name: 'Codex',
    available: true,
    efforts: ['low', 'medium', 'high'],
    models: [
      { id: '', label: 'Default' },
      { id: 'gpt-5.5-codex', label: 'GPT-5.5 Codex' },
      { id: 'gpt-5.5', label: 'GPT-5.5' },
    ],
  },
  {
    id: 'opencode',
    name: 'opencode',
    available: true,
    efforts: [],
    models: [
      { id: '', label: 'Default' },
      { id: 'anthropic/claude-sonnet-5-5', label: 'anthropic/claude-sonnet-5-5' },
    ],
  },
  ...[
    ['cursor', 'Cursor'],
    ['copilot', 'Copilot'],
    ['grok', 'Grok'],
    ['antigravity', 'Antigravity'],
  ].map(([id, name]) => ({ id, name, available: false, efforts: [], models: [] })),
];

// Opt-in states for looking at the composer (the default mock stays v1's reference, qa/parity.mjs):
// MOCK_COMPOSER=1: Codex signed out, Claude's plan windows, two recipes; MOCK_NO_AGENTS=1: no harness set up here.
const env = (k: string): boolean => typeof process !== 'undefined' && process.env[k] === '1';
const COMPOSER = env('MOCK_COMPOSER');
const NO_AGENTS = env('MOCK_NO_AGENTS');
const agentsNow = (): unknown[] =>
  NO_AGENTS ? MOCK_AGENTS.map((a) => ({ ...a, available: false })) : COMPOSER ? MOCK_AGENTS.map((a) => (a.id === 'codex' ? { ...a, available: false, signedIn: false } : a)) : MOCK_AGENTS;
const RECIPES = [
  { name: 'Prepare release', prompt: 'Prepare release {version}: bump, changelog, tag.' },
  { name: 'Fix lint', prompt: 'Run the linter and fix what it finds.' },
];

/** The task whose worktree (or folder) is `dir`, and its turns' bodies (their `changes`). */
function gitCtx(ctx: CommandCtx): GitCtx {
  const task = (dir: string): { id: string; v: Record<string, unknown> } | undefined =>
    ctx
      .rows('list')
      .map((r) => ({ id: r.id, v: (r.v ?? {}) as Record<string, unknown> }))
      .find((r) => {
        const sum = (r.v['summary'] ?? {}) as Record<string, unknown>;
        const wt = (sum['worktree'] ?? {}) as Record<string, unknown>;
        const body = (r.v['body'] ?? {}) as Record<string, unknown>;
        return [wt['cwd'], wt['path'], body['cwd'], sum['cwd']].includes(dir);
      });
  return {
    turnsOf: (dir) => {
      const t = task(dir);
      if (!t) return undefined;
      const bare = t.id.slice(t.id.indexOf(':') + 1);
      return ctx
        .rows(`session:${bare}` as never)
        .filter((r) => r.e === 'turn')
        .map((r) => (((r.v ?? {}) as Record<string, unknown>)['body'] ?? {}) as { changes?: never[] });
    },
    base: (dir) => {
      const sum = ((task(dir)?.v['summary'] ?? {}) as Record<string, unknown>)['worktree'] as Record<string, unknown> | undefined;
      return typeof sum?.['base'] === 'string' ? sum['base'] : 'main';
    },
  };
}

export interface CommandCtx {
  readonly peer: string;
  now(): number;
  row(topic: Topic, e: string, id: string): unknown;
  rows(topic: Topic): readonly { e: string; id: string; v: unknown }[];
  /** starts a streaming turn in the session */
  stream(id: string, o?: { turnId?: string; prompt?: string }): void;
  /** a commit `ms` from now (a delayed effect) */
  later(ms: number, ops: () => EntityOp[]): void;
}

export type CommandFn = (args: unknown, ctx: CommandCtx) => { ops: EntityOp[]; result?: unknown };

type Args = Record<string, unknown>;
/** A task's own topic: `session:<bare id>`, as the client subscribes (the Rust peer's name), whatever its rows' keys. */
const own = (id: string): Topic => `session:${id.slice(id.indexOf(':') + 1)}` as Topic;
const obj = (a: unknown): Args => (typeof a === 'object' && a !== null ? (a as Args) : {});
const refuse = (code: string, message: string): never => {
  throw { code, message };
};
const str = (a: Args, k: string): string => {
  const v = a[k];
  return typeof v === 'string' && v !== '' ? v : refuse('invalid', `${k} is required`);
};

/** The session's rows live on `list` and on its own topic: a change to it goes to both. */
function sessionPatch(ctx: CommandCtx, id: string, ops: PatchOp[]): EntityOp[] {
  if (ctx.row('list', 'session', id) === undefined) refuse('not_found', `no task ${id}`);
  const out: EntityOp[] = [{ topic: 'list', e: 'session', id, op: 'patch', ops }];
  if (ctx.row(own(id), 'session', id) !== undefined) out.push({ topic: own(id), e: 'session', id, op: 'patch', ops });
  return out;
}

interface QItem {
  readonly id: string;
  readonly text: string;
  readonly at: number;
}

/** A task's queued follow-ups (the row's `body.queue`). */
function queueOf(ctx: CommandCtx, id: string): QItem[] {
  const row = obj(ctx.row('list', 'session', id));
  const q = obj(row['body'])['queue'];
  return Array.isArray(q) ? (q as QItem[]) : [];
}

/** wisp.later's commands name the task by its bare id (the server's own): the mock's rows are keyed `<peer>:<id>`. */
const taskKey = (ctx: CommandCtx, id: string): string => (id.includes(':') ? id : `${ctx.peer}:${id}`);

/** The follow-ups set for later in a task (wisp.later's `later` on the row). */
function laterOf(ctx: CommandCtx, id: string): { id: string; at: number; text: string }[] {
  const l = obj(ctx.row('list', 'session', id))['later'];
  return Array.isArray(l) ? (l as { id: string; at: number; text: string }[]) : [];
}

/** The task's queue and its count on the row. */
const setQueue = (ctx: CommandCtx, id: string, q: readonly QItem[]): EntityOp[] =>
  sessionPatch(ctx, id, [{ op: 'add', path: '/body/queue', value: q }, { op: 'replace', path: '/summary/queued', value: q.length }, touch(ctx)]);

const touch = (ctx: CommandCtx): PatchOp => ({ op: 'replace', path: '/updated_at', value: ctx.now() });

/** Rerun and Fork: a copy of a task, running, under the id the client chose. */
function copyTask(x: Args, ctx: CommandCtx, kind: 'rerun' | 'fork'): { ops: EntityOp[]; result: unknown } {
  const from = str(x, 'id');
  const id = str(x, 'newId');
  const src = ctx.row('list', 'session', from) as Record<string, unknown> | undefined;
  if (!src) refuse('not_found', `no task ${from}`);
  const at = ctx.now();
  const summary = { ...(src?.['summary'] as Record<string, unknown>), status: 'running', live: 'Starting…', overlaps: [], ...(kind === 'fork' && { forkedFrom: from }) };
  const row = { ...src, id, state: 'running', unread: false, created_at: at, updated_at: at, agent: typeof x['agent'] === 'string' ? x['agent'] : src?.['agent'], summary };
  ctx.later(10, () => {
    ctx.stream(id);
    return [];
  });
  return {
    ops: [
      { topic: 'list', e: 'session', id, op: 'upsert', v: row },
      { topic: own(id), e: 'session', id, op: 'upsert', v: row },
    ],
    result: { id },
  };
}

/** the Org layout the mock keeps between calls */
const mockLayout: { value: Record<string, unknown> } = { value: {} };

export const COMMANDS: Record<string, CommandFn> = {
  'runtime.rename': (a, ctx) => {
    const x = obj(a);
    const title = str(x, 'title').trim();
    if (title.length > 200) refuse('invalid', 'A title is at most 200 characters');
    return { ops: sessionPatch(ctx, str(x, 'id'), [{ op: 'replace', path: '/title', value: title }]) };
  },
  'runtime.archive': (a, ctx) => {
    const x = obj(a);
    return { ops: sessionPatch(ctx, str(x, 'id'), [{ op: 'replace', path: '/archived', value: x['archived'] === true }, touch(ctx)]) };
  },
  'runtime.markRead': (a, ctx) => {
    const x = obj(a);
    return { ops: sessionPatch(ctx, str(x, 'id'), [{ op: 'replace', path: '/unread', value: x['unread'] === true }]) };
  },
  'runtime.setState': (a, ctx) => {
    const x = obj(a);
    const state = str(x, 'state');
    if (!['running', 'review', 'done', 'error'].includes(state)) refuse('invalid', `state is running, review, done or error`);
    return { ops: sessionPatch(ctx, str(x, 'id'), [{ op: 'replace', path: '/state', value: state }, touch(ctx)]) };
  },
  'runtime.delete': (a, ctx) => {
    const id = str(obj(a), 'id');
    if (ctx.row('list', 'session', id) === undefined) refuse('not_found', `no task ${id}`);
    const mine: Topic = own(id);
    return { ops: [{ topic: 'list', e: 'session', id, op: 'del' }, ...ctx.rows(mine).map((r): EntityOp => ({ topic: mine, e: r.e, id: r.id, op: 'del' }))] };
  },
  // a Stop keeps the queue, held: nothing goes by itself until you send something or Send now (v1 queued.js)
  'runtime.stop': (a, ctx) => {
    const id = str(obj(a), 'id');
    const held = queueOf(ctx, id).length > 0;
    return {
      ops: sessionPatch(ctx, id, [
        { op: 'replace', path: '/state', value: 'review' },
        { op: 'replace', path: '/summary/live', value: '' },
        ...(held ? [{ op: 'add' as const, path: '/body/queueHeld', value: true }] : []),
      ]),
    };
  },
  'runtime.followUp': (a, ctx) => {
    const x = obj(a);
    const id = str(x, 'id');
    const text = str(x, 'text');
    // Settings → Follow-ups: Queue (the client says so while the task works): it waits behind the run (v1 queued.js)
    if (x['queue'] === true) {
      const item = { id: typeof x['turnId'] === 'string' ? x['turnId'] : `q${ctx.now().toString(36)}`, text, at: ctx.now() };
      return { ops: setQueue(ctx, id, [...queueOf(ctx, id), item]), result: { queued: true } };
    }
    const ops = sessionPatch(ctx, id, [touch(ctx)]);
    ctx.stream(id, { prompt: text, ...(typeof x['turnId'] === 'string' && { turnId: x['turnId'] }) });
    return { ops, result: { queued: false } };
  },
  // the queue over the reply box (shell-composer's QueueFoot): edit, send now, combine, reorder, cancel
  'runtime.queue.text': (a, ctx) => {
    const x = obj(a);
    const id = str(x, 'id');
    return {
      ops: setQueue(
        ctx,
        id,
        queueOf(ctx, id).map((q) => (q.id === str(x, 'itemId') ? { ...q, text: str(x, 'text') } : q)),
      ),
    };
  },
  'runtime.queue.cancel': (a, ctx) => {
    const x = obj(a);
    const id = str(x, 'id');
    return {
      ops: setQueue(
        ctx,
        id,
        queueOf(ctx, id).filter((q) => q.id !== str(x, 'itemId')),
      ),
    };
  },
  'runtime.queue.order': (a, ctx) => {
    const x = obj(a);
    const id = str(x, 'id');
    const order = Array.isArray(x['order']) ? (x['order'] as string[]) : [];
    const q = queueOf(ctx, id);
    const moved = [...order.map((o) => q.find((i) => i.id === o)).filter((i): i is QItem => i !== undefined), ...q.filter((i) => !order.includes(i.id))];
    return { ops: setQueue(ctx, id, moved) };
  },
  'runtime.queue.sendNow': (a, ctx) => {
    const x = obj(a);
    const id = str(x, 'id');
    const it = queueOf(ctx, id).find((q) => q.id === str(x, 'itemId'));
    if (it) ctx.stream(id, { prompt: it.text });
    return {
      ops: setQueue(
        ctx,
        id,
        queueOf(ctx, id).filter((q) => q.id !== str(x, 'itemId')),
      ),
    };
  },
  'runtime.queue.merge': (a, ctx) => {
    const x = obj(a);
    const id = str(x, 'id');
    const ids = Array.isArray(x['ids']) ? (x['ids'] as string[]) : [];
    const q = queueOf(ctx, id);
    const taken = q.filter((i) => ids.includes(i.id));
    const first = taken[0];
    if (!first) return { ops: [] };
    const merged = { ...first, text: taken.map((i) => i.text).join('\n\n') };
    return {
      ops: setQueue(
        ctx,
        id,
        q.filter((i) => !ids.includes(i.id) || i.id === first.id).map((i) => (i.id === first.id ? merged : i)),
      ),
    };
  },
  // a follow-up set for later in a task (the reply box's "in 10 min …", F-auto-5): over the box until it goes
  'later.add': (a, ctx) => {
    const x = obj(a);
    const id = taskKey(ctx, str(x, 'sessionId'));
    const item = { id: `l${ctx.now().toString(36)}`, at: Number(x['at']), text: str(x, 'text'), by: 'user', setAt: ctx.now(), ...(x['remind'] === true && { remind: true }) };
    const later = [...laterOf(ctx, id), item].sort((p, q) => p.at - q.at);
    return { ops: sessionPatch(ctx, id, [{ op: 'add', path: '/later', value: later }, touch(ctx)]), result: item };
  },
  'later.cancel': (a, ctx) => {
    const x = obj(a);
    const id = taskKey(ctx, str(x, 'sessionId'));
    return { ops: sessionPatch(ctx, id, [{ op: 'add', path: '/later', value: laterOf(ctx, id).filter((l) => l.id !== str(x, 'item')) }, touch(ctx)]) };
  },
  'later.edit': (a, ctx) => {
    const x = obj(a);
    const id = taskKey(ctx, str(x, 'sessionId'));
    const it = laterOf(ctx, id).find((l) => l.id === str(x, 'item'));
    if (x['now'] === true && it) ctx.stream(id, { prompt: it.text });
    const later = laterOf(ctx, id)
      .filter((l) => !(x['now'] === true && l.id === it?.id))
      .map((l) => (l.id === it?.id ? { ...l, ...(typeof x['at'] === 'number' && { at: x['at'] }), ...(typeof x['text'] === 'string' && { text: x['text'] }) } : l));
    return { ops: sessionPatch(ctx, id, [{ op: 'add', path: '/later', value: later }, touch(ctx)]) };
  },
  // New task, later (wisp.later's plans): a timed task, a reminder, a /draft, an /after <task>; Scheduled or Drafts in the list
  'later.plan': (a, ctx) => {
    const x = obj(a);
    const id = str(x, 'tmp') || `p${ctx.now().toString(36)}`;
    const body = obj(x['body']);
    const v = {
      id,
      kind: str(x, 'kind') || 'task',
      setAt: ctx.now(),
      ...(typeof x['at'] === 'number' && { at: x['at'] }),
      ...(x['draft'] === true && { draft: true }),
      ...(x['after'] !== undefined && { after: x['after'] }),
      ...(x['body'] !== undefined && {
        body,
        title: String(body['prompt'] ?? '')
          .split('\n')[0]
          ?.slice(0, 80),
      }),
      ...(typeof x['text'] === 'string' && { text: x['text'] }),
    };
    return { ops: [{ topic: 'plugin:wisp.later:later' as Topic, e: 'later_plan', id: `${ctx.peer}:${id}`, op: 'upsert', v }], result: v };
  },
  // a task's spec (ADR-0027), what Rerun… starts from: its first prompt, the steps after, how and where it ran
  'runtime.spec': (a, ctx) => {
    const id = str(obj(a), 'id');
    const row = obj(ctx.row('list', 'session', id));
    const sum = obj(row['summary']);
    const turns = ctx
      .rows(own(id))
      .filter((r) => r.e === 'turn')
      .map((r) => obj(r.v))
      .sort((x, y) => Number(x['idx']) - Number(y['idx']));
    const prompts = turns.map((t) => String(t['prompt'] ?? '')).filter(Boolean);
    return {
      ops: [],
      result: {
        prompt: prompts[0] ?? String(row['title'] ?? ''),
        steps: prompts.slice(1),
        agent: String(row['agent'] ?? 'claude'),
        model: String(sum['model'] ?? ''),
        effort: '',
        mode: String(sum['mode'] ?? 'auto'),
        cwd: String(sum['cwd'] ?? ''),
      },
    };
  },
  // /btw (v1 btw.js): the question shows answering, the answer lands a moment later; × drops it
  'runtime.btw': (a, ctx) => {
    const x = obj(a);
    const id = str(x, 'id');
    const entry = { id: `b${ctx.now().toString(36)}`, question: str(x, 'question'), at: ctx.now(), pending: true };
    const list = (): Args[] => ((obj(obj(obj(ctx.row('list', 'session', id))['body'])['ext'])['wisp.runtime'] as Args | undefined)?.['btw'] as Args[] | undefined) ?? [];
    const put = (l: Args[]): EntityOp[] => {
      const ext = obj(obj(obj(ctx.row('list', 'session', id))['body'])['ext']);
      return sessionPatch(ctx, id, [{ op: 'add', path: '/body/ext', value: { ...ext, 'wisp.runtime': { ...obj(ext['wisp.runtime']), btw: l } } }]);
    };
    ctx.later(1500, () =>
      put(list().map((b) => (b['id'] === entry.id ? { ...b, pending: false, answer: 'Yes: **docs/sync.md** says the timer belongs to the stream now, and the README links it.' } : b))),
    );
    return { ops: put([...list(), entry]), result: entry };
  },
  // 👍 / 👎 on a turn (v1 feedback.js): kept on the turn; the line after 👎 only goes out
  'telemetry.feedback': (a, ctx) => {
    const x = obj(a);
    const sid = typeof x['sessionId'] === 'string' ? x['sessionId'] : '';
    const tid = typeof x['turnId'] === 'string' ? x['turnId'] : '';
    const ops: EntityOp[] = [];
    if (sid && tid && 'rating' in x && !x['text']) {
      const topic = `session:${sid}` as Topic;
      const row = ctx.rows(topic).find((r) => r.e === 'turn' && (r.id === tid || r.id.endsWith(`:${tid}`)));
      if (row) {
        const ext = obj(obj(obj(row.v)['body'])['ext']);
        const feedback = x['rating'] === 'up' || x['rating'] === 'down' ? { rating: x['rating'], at: ctx.now() } : null;
        ops.push({ topic, e: 'turn', id: row.id, op: 'patch', ops: [{ op: 'add', path: '/body/ext', value: { ...ext, 'wisp.telemetry': { feedback } } }] });
      }
    }
    return { ops, result: { ok: true, sent: true, available: true } };
  },
  // Show in folder: the mock has no file manager; it names the file it would open on
  'runtime.reveal': (a) => ({ ops: [], result: { ok: true, path: str(obj(a), 'path') } }),
  'runtime.btw.drop': (a, ctx) => {
    const x = obj(a);
    const id = str(x, 'id');
    const ext = obj(obj(obj(ctx.row('list', 'session', id))['body'])['ext']);
    const own = obj(ext['wisp.runtime']);
    const l = (Array.isArray(own['btw']) ? (own['btw'] as Args[]) : []).filter((b) => b['id'] !== str(x, 'btwId'));
    return { ops: sessionPatch(ctx, id, [{ op: 'add', path: '/body/ext', value: { ...ext, 'wisp.runtime': { ...own, btw: l } } }]) };
  },
  'runtime.create': (a, ctx) => {
    const x = obj(a);
    const prompt = typeof x['prompt'] === 'string' ? x['prompt'] : str(x, 'text');
    const at = ctx.now();
    // the client names it (its optimistic row and the page it opens use the id), else the peer does
    const id = typeof x['id'] === 'string' && x['id'] !== '' ? x['id'] : `${ctx.peer}:${at.toString(36)}`;
    const row = {
      id,
      parent_id: null,
      title: prompt.split('\n')[0]?.slice(0, 80) ?? 'New task',
      state: 'running',
      agent: typeof x['agent'] === 'string' ? x['agent'] : 'claude',
      archived: false,
      unread: false,
      created_at: at,
      updated_at: at,
      rev: 1,
      summary: {
        status: 'running',
        turnCount: 1,
        queued: 0,
        preview: prompt.slice(0, 80),
        live: 'Starting…',
        cwd: typeof x['cwd'] === 'string' ? x['cwd'] : '~/code/wisp',
        model: 'claude-opus-5-5',
        mode: typeof x['mode'] === 'string' ? x['mode'] : 'auto',
        // runtime's group.rs: the runs of one compare carry their group on the row
        ...((): Record<string, unknown> => {
          const g = ((x['ext'] as Record<string, Record<string, unknown>> | undefined)?.['wisp.runtime'] ?? {})['group'];
          return typeof g === 'string' && g ? { groupId: g } : {};
        })(),
        ...(typeof x['projectId'] === 'string' && { projectId: x['projectId'] }),
        ...(typeof x['color'] === 'string' && { color: x['color'] }),
        ...(typeof x['goal'] === 'string' && x['goal'] !== '' && { goal: { text: x['goal'], status: 'running', round: 0, checks: [] } }),
        ...(typeof x['at'] === 'number' && { startsAt: x['at'] }),
      },
      body: {},
    };
    ctx.later(10, () => {
      ctx.stream(id);
      return [];
    });
    return {
      ops: [
        { topic: 'list', e: 'session', id, op: 'upsert', v: row },
        { topic: own(id), e: 'session', id, op: 'upsert', v: row },
      ],
      result: { id },
    };
  },
  // Rerun and Fork: a new task from this one (the client names it, so its row and page show at once)
  'runtime.rerun': (a, ctx) => copyTask(obj(a), ctx, 'rerun'),
  // wisp-git, from the tasks' own changes (mock-git.ts)
  'git.changes': (a, ctx) => ({ ops: [], result: gitChanges(obj(a), gitCtx(ctx)) }),
  'git.stage': (a) => ({ ops: [], result: gitStage(obj(a)) }),
  'git.revert': (a) => ({ ops: [], result: gitRevert(obj(a)) }),
  'git.commit': (a) => ({ ops: [], result: gitCommit(obj(a)) }),
  // read-only answers the app asks for at start and on a task page: nothing to show in the mock
  // the harnesses the picker offers (runtime.agents' AgentOffer): three set up, the rest registered but not on this
  // machine, so the trigger form's runner picker and New task's show and can be measured
  'runtime.agents': () => ({ ops: [], result: agentsNow() }),
  // New task warms its project's remote while you type (nothing to fetch on the mock)
  'worktrees.warm': () => ({ ops: [], result: null }),
  'accounts.install': () => ({ ops: [], result: {} }),
  'accounts.recheck': () => ({ ops: [], result: {} }),
  // ⌘K past work: words in a task's prompts and answers (the peer's full-text index), a snippet around them
  'runtime.search': (a, ctx) => {
    const q = str(obj(a), 'q').toLowerCase().trim();
    if (q.length < 3) return { ops: [], result: [] };
    const hits: { id: string; title: string; snippet: string; updatedAt: number }[] = [];
    for (const r of ctx.rows('list')) {
      if (r.e !== 'session') continue;
      const s = r.v as { id: string; title: string; updated_at: number };
      const bare = s.id.slice(s.id.indexOf(':') + 1);
      const texts = ctx
        .rows(`session:${bare}` as Topic)
        .filter((x) => x.e === 'turn')
        .flatMap((x) => {
          const v = x.v as { prompt?: string; answer?: string };
          return [v.prompt ?? '', v.answer ?? ''];
        });
      const found = texts.find((t) => t.toLowerCase().includes(q));
      if (!found) continue;
      const at = found.toLowerCase().indexOf(q);
      hits.push({ id: bare, title: s.title, snippet: found.slice(Math.max(0, at - 30), at + q.length + 50), updatedAt: s.updated_at });
    }
    return { ops: [], result: hits.slice(0, Number(obj(a)['limit'] ?? 20)) };
  },
  // Settings → Usage as v1's reference had it: $0.09 over 9 turns, all worked, no questions; a week of days
  'runtime.usage': (a) => {
    const days = Number((obj(a) as { days?: number }).days ?? 7);
    const today = Date.UTC(2026, 10, 12);
    const daily = Array.from({ length: days + 1 }, (_, i) => ({ date: new Date(today - (days - i) * 86_400_000).toISOString().slice(0, 10), cost: i === days ? 0.09 : 0, turns: i === days ? 9 : 0 }));
    const row = { cost: 0.09, priced: 9, turns: 9, worked: 100, questions: 0, avgMs: 41_000 };
    return {
      ops: [],
      result: {
        from: today - days * 86_400_000,
        spend: 0.09,
        turns: 9,
        worked: 100,
        questions: 0,
        priced: 9,
        sessions: 5,
        daily,
        projects: [{ key: '~/code/wisp', name: 'wisp', ...row }],
        runners: [{ key: 'claude claude-opus-4', name: 'claude-opus-4', agent: 'claude', ...row }],
      },
    };
  },
  'budget.view': (a) =>
    // no plan windows reported yet (MOCK_COMPOSER: Claude's)
    ({ ops: [], result: COMPOSER && str(obj(a), 'agent') === 'claude' ? [{ account: 'default', at: null, windows: [{ id: 'five_hour', label: '5h', used: 0.42 }, { id: 'seven_day', label: 'Week', used: 0.18 }] }] : [] }),
  // the side panel's Preview: nothing runs yet, package.json's dev script to start from
  'terminal.run.info': () => ({ ops: [], result: { open: false, port: 41234, dir: '~/code/wisp-repo', guess: 'npm run dev' } }),
  'terminal.run.start': () => ({ ops: [], result: { ok: true, started: true, port: 41234, dir: '~/code/wisp-repo' } }),
  'terminal.close': () => ({ ops: [], result: { ok: true } }),
  'terminal.app.open': () => ({ ops: [], result: { ok: true } }),
  'terminal.shell.info': () => ({ ops: [], result: { supported: true, open: false, app: true, name: 'zsh' } }),
  // a member's track record (F-crew-13): Ada's jobs, the tokens they used, where they went
  'crew.stats': (a) => ({
    ops: [],
    result: [
      { id: 'crew:ada', jobs: 14, done: 12, failed: 1, quiet: 3, before: 9, cost: 4.2, tokens: 84_000, days: Number(obj(a)['days'] ?? 30), byKind: { checkin: { runs: 60, tokens: 60_000, quiet: 3 }, delegated: { runs: 4, tokens: 24_000, quiet: 0 } }, top: [{ id: 's0000', title: 'Review the reconnect fix against the sync spec', job: 'delegated', tokens: 21_000 }] },
      { id: 'crew:linus', jobs: 31, done: 30, failed: 0, quiet: 0, tokens: 120_000 },
      { id: 'crew:grace', jobs: 4, done: 4, failed: 0, quiet: 2 },
    ],
  }),
  // Skills and instructions on this computer (F-crew-10's From this computer…)
  'crew.kit': () => ({
    ops: [],
    result: [
      { name: 'release-notes', description: 'Writing release notes or a CHANGELOG entry.', path: '~/.claude/skills/release-notes', from: 'home', body: '1. Read the commits since the last tag.' },
      { name: 'review-sync', description: 'Reviewing a change to the sync protocol against docs/sync.md.', path: '~/.claude/skills/review-sync', from: 'home', body: '1. Read docs/sync.md.\n2. Diff the change.' },
      { name: 'AGENTS.md', description: "this project's instructions", path: '~/code/wisp/AGENTS.md', from: 'project', body: '# AGENTS.md\n\nRules.' },
    ],
  }),
  // Share… (F-crew-12): the bundle, with the host's note
  'crew.export': (a) => {
    const ids = (obj(a)['ids'] as string[] | undefined) ?? [];
    return { ops: [], result: { bundle: { wispCrew: 1, members: ids.map((id) => ({ key: id.replace(/^crew:/, ''), name: id })) }, notes: obj(a)['notebook'] ? ['Their notebook goes along: read it first.'] : [], file: `${(ids[0] ?? 'crew').replace(/^crew:/, '')}.crew.json` } };
  },
  // Settings → Machines → This computer over SSH, as v1's reference showed it (names the same length, not the same)
  'machines.reachable': () => ({
    ops: [],
    result: {
      user: 'dev1',
      hostname: 'studio-macbook-pro-1',
      ssh: { running: true, banner: 'SSH-2.0-OpenSSH_9.9', port: 22 },
      tailscale: { installed: true, running: true, name: 'studio-macbook-pro-1.tail24f2b2.ts.net' },
      keys: 3,
      target: 'dev1@studio-macbook-pro-1.tail24f2b2.ts.net',
      supported: true,
    },
  }),
  'runtime.cold': () => ({ ops: [], result: { cache: null, compact: null } }), // a small task: no cache hint, no Compact now
  'stuff.targets': () => ({ ops: [], result: [] }), // no grid to publish to
  // the panes wisp ships (v1 GET /stuff/starters); Add keeps one in My Stuff
  'stuff.starters': () => ({
    ops: [],
    result: {
      starters: [
        { id: 'prs', name: 'Open pull requests', description: 'Your open PRs by repo, with their checks' },
        { id: 'usage', name: 'Token budget', description: 'What each harness spent this week' },
      ],
    },
  }),
  // a pinned pane: the app served here (the mock's own page), what it may use, and Allow (answered as asked)
  // your saved launch defaults (agent profiles): none saved here, so New task's own defaults apply
  // a computer's projects (`resources.export`, kind project): what Run on checks for a checkout first
  'resources.export': (_a, ctx) => ({
    ops: [],
    result: {
      projects: ctx
        .rows('config')
        .filter((r) => r.e === 'project')
        .map((r) => ({ name: String(obj(r.v)['name'] ?? ''), path: String(obj(r.v)['path'] ?? '') })),
    },
  }),
  // a project added on this computer (`resources.apply`, kind project): a Run on checkout joins its projects
  'resources.apply': (a, ctx) => {
    const list = Array.isArray(obj(a)['resources']) ? (obj(a)['resources'] as Args[]) : [];
    const ops: EntityOp[] = list
      .filter((r) => r['kind'] === 'project')
      .map((r) => {
        const name = String(r['name'] ?? '');
        const path = String(obj(r['spec'])['path'] ?? '');
        return { topic: 'config' as Topic, e: 'project', id: `${ctx.peer}:${name}`, op: 'upsert', v: { id: `${ctx.peer}:${name}`, name, path, color: 'violet' } };
      });
    return { ops, result: { applied: ops.length } };
  },
  // a folder's repo (git.origin): the project's folder is a checkout of wisp's repo; anything else isn't a repo
  'git.origin': (a, ctx) => {
    const path = str(obj(a), 'path');
    const p = ctx
      .rows('config')
      .map((r) => obj(r.v))
      .find((v) => typeof v['path'] === 'string' && v['path'] !== '' && (path === v['path'] || path.startsWith(`${String(v['path'])}/`)));
    return { ops: [], result: p ? { origin: 'git@github.com:WispAgents/wisp.git', root: String(p['path']) } : { origin: '', root: '' } };
  },
  // this computer's checkout of a repo (git.checkout): a known folder with that repo, else a clone where clones go
  'git.checkout': (a, ctx) => {
    const x = obj(a);
    const known = Array.isArray(x['known']) ? (x['known'] as string[]) : [];
    const name = (str(x, 'url').split('/').pop() ?? 'repo').replace(/\.git$/, '');
    return { ops: [], result: known[0] ? { dir: known[0], existed: true } : { dir: `/Users/${ctx.peer}/code/${name}`, existed: false } };
  },
  'stuff.launch': () => ({ ops: [], result: { port: 4593, url: `${globalThis.location?.origin ?? 'http://localhost:4593'}/__mock/app` } }),
  'stuff.grant': () => ({ ops: [], result: { allowed: ['tasks:read', 'tasks:write'], changed: false } }),
  'stuff.allow': (a) => ({ ops: [], result: { id: str(obj(a), 'id'), allowed: obj(a)['uses'] } }),
  'stuff.addStarter': (a) => ({ ops: [], result: { id: `st-${String(obj(a)['id'])}`, kind: 'app', title: String(obj(a)['id']) } }),
  // a member's fields (the editor, Org's links): patched on the crew topic, as the crew host does
  'crew.update': (a, ctx) => {
    const { id, ...patch } = obj(a);
    if (typeof id !== 'string' || ctx.row('crew', 'crew_member', id) === undefined) refuse('not_found', `no crew member ${String(id)}`);
    // offers come as settles ({id, state, names}): kept on the offer they settle, as crew core offers::settle does
    const row = ctx.row('crew', 'crew_member', id as string) as { offers?: { id: string }[] } | undefined;
    if (Array.isArray(patch['offers'])) {
      const list = patch['offers'] as { id: string; state: string; names: string[] }[];
      patch['offers'] = (row?.offers ?? []).map((o) => {
        const s = list.find((x) => x.id === o.id);
        return s ? { ...o, state: s.state, names: s.names } : o;
      });
    }
    const ops: PatchOp[] = Object.entries(patch).map(([k, v]) => ({ op: 'add', path: `/${k}`, value: v }));
    return { ops: [{ topic: 'crew', e: 'crew_member', id: id as string, op: 'patch', ops }], result: { ...(ctx.row('crew', 'crew_member', id as string) as object), ...patch } };
  },
  'plugins.ui': () => ({ ops: [], result: [] }),
  // what Auto would run (router.preview, v1 POST /router/preview), as v1's reference shows it: Claude Code's default
  // model, Opus worth a try, three others; Never pick lists go in `blocked`
  'router.preview': (a) => {
    const alt = (agent: string, model: string, effort: string, label: string, chance: number, usd: number) => ({ agent, model, effort, key: `${agent}:${model}:${effort}`, label, chance, usd });
    return {
      ops: [],
      result: {
        pick: { agent: 'claude', model: '', effort: '', key: 'claude::', label: 'Claude Code' },
        why: `your usual pick (4 of yours) · Medium thinking for Balanced`,
        goal: 'balanced',
        type: 'feature',
        chance: 0.83,
        usd: 0.11,
        minutes: 1,
        suggest: { ...alt('claude', 'opus', 'high', 'Claude Code · Opus · High', 0.89, 0.28), trying: false, why: '89% expected from public benchmarks' },
        alternatives: [
          alt('claude', 'opus', 'high', 'Claude Code · Opus · High', 0.89, 0.28),
          alt('codex', 'gpt-5.5-codex', 'high', 'Codex · Codex · High', 0.88, 0.34),
          alt('codex', '', '', 'Codex', 0.85, 0.25),
          alt('claude', 'fable', '', 'Claude Code · Fable', 0.5, 0.3),
        ],
      },
    };
  },
  // a project's GitHub issues (issues.list): the mock's projects have no GitHub remote, so it answers as the peer
  // does then (plugins/issues/core no_remote); Linear and Jira aren't connected
  'issues.list': (a, ctx) => {
    const id = str(obj(a), 'project');
    const name = String((ctx.row('config', 'project', id) as { name?: string } | undefined)?.name ?? (id || 'This project'));
    return {
      ops: [],
      result: { source: str(obj(a), 'source') || 'github', issues: [], linear: false, jira: false, error: `${name} has no GitHub remote, so it has no issues to list.`, fix: 'remote' },
    };
  },
  // git repos found on this machine (runtime.discover, v1 GET /discover): what v1's reference shows under Projects
  'runtime.discover': () => ({
    ops: [],
    result: [
      { path: '/Users/me/code/kilocode', name: 'kilocode' },
      { path: '/Users/me/Code/kilocode', name: 'kilocode' },
      ...[30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20, 19, 18].map((n) => ({ path: `/Users/me/code/web-app-${n}`, name: `web-app-${n}` })),
      { path: '/Users/me/Code/web-app-18', name: 'web-app-18' },
      { path: '/Users/me/code/t3code-2', name: 't3code-2' },
      { path: '/Users/me/Code/t3code-2', name: 't3code-2' },
      ...[17, 16, 15].flatMap((n) => [
        { path: `/Users/me/code/web-app-${n}`, name: `web-app-${n}` },
        { path: `/Users/me/Code/web-app-${n}`, name: `web-app-${n}` },
      ]),
    ],
  }),
  // Automations: no recipes or triggers yet (v1's reference shows Recipes 0 · Triggers 0)
  'automations.tasks': () => ({ ops: [], result: COMPOSER ? RECIPES : [] }),
  'automations.task.run': () => ({ ops: [], result: {} }),
  'automations.trigger.ls': () => ({ ops: [], result: [] }),
  // Compare runs' Keep this: the other runs' folders (none on the mock)
  'worktrees.clean': () => ({ ops: [], result: { queued: 0 } }),
  'router.view': () => ({ ops: [], result: { settings: { blocked: [] } } }),
  'router.set': () => ({ ops: [], result: {} }),
  // a folder picker's suggestions (runtime.folders, v1 GET /fs?q=): a small home, answered in the form typed
  'runtime.folders': (a) => {
    const q = str(obj(a), 'q');
    const tree = ['~/code', '~/code/api', '~/code/web', '~/code/wisp', '~/Documents', '~/Downloads', '~/notes'];
    const dir = q.endsWith('/') ? q.slice(0, -1) : q.slice(0, q.lastIndexOf('/'));
    const start = q.slice(q.lastIndexOf('/') + 1).toLowerCase();
    return {
      ops: [],
      result: tree.filter(
        (p) =>
          p.slice(0, p.lastIndexOf('/')) === dir &&
          p
            .slice(p.lastIndexOf('/') + 1)
            .toLowerCase()
            .startsWith(start),
      ),
    };
  },
  // the Org chart's layout (v1 /crew-layout): none placed until you move a card; a save answers what it kept
  'crew.layout': () => ({ ops: [], result: mockLayout.value }),
  'crew.set_layout': (a) => ((mockLayout.value = (obj(a)['layout'] ?? {}) as Record<string, unknown>), { ops: [], result: mockLayout.value }),
  'plugins.list': () => ({ ops: [], result: [] }), // Settings → Plugins: nothing of your own, no built-ins listed by the mock
  'runtime.fork': (a, ctx) => copyTask(obj(a), ctx, 'fork'),
  'runtime.setMode': (a, ctx) => {
    const x = obj(a);
    const mode = str(x, 'mode');
    if (!['plan', 'edits', 'auto'].includes(mode)) refuse('invalid', 'mode is plan, edits or auto');
    return { ops: sessionPatch(ctx, str(x, 'id'), [{ op: 'replace', path: '/summary/mode', value: mode }]) };
  },
  'runtime.setAgent': (a, ctx) => {
    const x = obj(a);
    return { ops: sessionPatch(ctx, str(x, 'id'), [{ op: 'replace', path: '/agent', value: str(x, 'agent') }]) };
  },
  'runtime.forLater': (a, ctx) => {
    const x = obj(a);
    return { ops: sessionPatch(ctx, str(x, 'id'), [{ op: 'replace', path: '/summary/forLater', value: x['forLater'] === true }]) };
  },
  'goal.set': (a, ctx) => {
    const x = obj(a);
    const text = str(x, 'text');
    return { ops: sessionPatch(ctx, str(x, 'id'), [{ op: 'replace', path: '/summary/goal', value: { text, status: 'running', round: 0, checks: [] } }]) };
  },
  // Ship it: a pull request, after the push (the pending state shows meanwhile)
  'ship.open': (a, ctx) => {
    const id = str(obj(a), 'id');
    const n = 800 + (Math.floor(ctx.now() / 1000) % 100);
    return { ops: sessionPatch(ctx, id, [{ op: 'add', path: '/summary/pr', value: { number: n, state: 'OPEN', url: `https://github.com/example/repo/pull/${n}` } }]), result: { number: n } };
  },
  // wisp.terminal's list for this computer, as a Mac answers it (v1's reference: In wisp first)
  'terminal.apps': () => ({
    ops: [],
    result: {
      terminals: [
        { id: 'wisp', label: 'In wisp' },
        { id: 'terminal', label: 'Terminal' },
        { id: 'iterm', label: 'iTerm' },
        { id: 'custom', label: 'Custom command…' },
      ],
      defaultTerminal: 'wisp',
    },
  }),
  'checkpoint.restore': (a, ctx) => ({ ops: sessionPatch(ctx, str(obj(a), 'id'), [touch(ctx)]), result: { restored: true } }),
  'settings.set': (a, ctx) => {
    const x = obj(a);
    const key = str(x, 'key');
    const prev = obj(ctx.row('config', 'setting', key));
    if (typeof prev['locked_by'] === 'string') refuse('forbidden', `${key} is set by ${prev['locked_by']}`);
    return { ops: [{ topic: 'config', e: 'setting', id: key, op: 'upsert', v: { key, value: x['value'] ?? null, locked_by: null } }] };
  },
  'stuff.delete': (a, ctx) => {
    const id = str(obj(a), 'id');
    if (ctx.row('stuff', 'stuff', id) === undefined) refuse('not_found', `nothing saved as ${id}`);
    return { ops: [{ topic: 'stuff', e: 'stuff', id, op: 'del' }] };
  },
};
