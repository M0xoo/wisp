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
  'runtime.stop': (a, ctx) => ({
    ops: sessionPatch(ctx, str(obj(a), 'id'), [
      { op: 'replace', path: '/state', value: 'review' },
      { op: 'replace', path: '/summary/live', value: '' },
    ]),
  }),
  'runtime.followUp': (a, ctx) => {
    const x = obj(a);
    const id = str(x, 'id');
    const text = str(x, 'text');
    const ops = sessionPatch(ctx, id, [touch(ctx)]);
    ctx.stream(id, { prompt: text, ...(typeof x['turnId'] === 'string' && { turnId: x['turnId'] }) });
    return { ops, result: { queued: false } };
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
  'runtime.agents': () => ({ ops: [], result: MOCK_AGENTS }),
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
  'budget.view': () => ({ ops: [], result: [] }), // no plan windows reported yet
  // the side panel's Preview: nothing runs yet, package.json's dev script to start from
  'terminal.run.info': () => ({ ops: [], result: { open: false, port: 41234, dir: '~/code/wisp-repo', guess: 'npm run dev' } }),
  'terminal.run.start': () => ({ ops: [], result: { ok: true, started: true, port: 41234, dir: '~/code/wisp-repo' } }),
  'terminal.close': () => ({ ops: [], result: { ok: true } }),
  'terminal.app.open': () => ({ ops: [], result: { ok: true } }),
  'terminal.shell.info': () => ({ ops: [], result: { supported: true, open: false, app: true, name: 'zsh' } }),
  'crew.stats': () => ({ ops: [], result: [] }),
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
  'resources.export': () => ({ ops: [], result: [] }),
  'stuff.launch': () => ({ ops: [], result: { port: 4593, url: `${globalThis.location?.origin ?? 'http://localhost:4593'}/__mock/app` } }),
  'stuff.grant': () => ({ ops: [], result: { allowed: ['tasks:read', 'tasks:write'], changed: false } }),
  'stuff.allow': (a) => ({ ops: [], result: { id: str(obj(a), 'id'), allowed: obj(a)['uses'] } }),
  'stuff.addStarter': (a) => ({ ops: [], result: { id: `st-${String(obj(a)['id'])}`, kind: 'app', title: String(obj(a)['id']) } }),
  // a member's fields (the editor, Org's links): patched on the crew topic, as the crew host does
  'crew.update': (a, ctx) => {
    const { id, ...patch } = obj(a);
    if (typeof id !== 'string' || ctx.row('crew', 'crew_member', id) === undefined) refuse('not_found', `no crew member ${String(id)}`);
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
  'automations.tasks': () => ({ ops: [], result: [] }),
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
