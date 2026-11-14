// The mock peer's data: what a real wisp holds after a week of use, shaped like the Rust store's rows
// (plugins/runtime/host/src/rows.rs) and v1's JSON (server/runner.js summarize, server/crew.js,
// server/machines.js, server/stuff.js). Deterministic: the same `now` gives the same rows, so
// screenshots and tests don't drift. `extra` adds plain sessions for a long list (5k for perf).

import type { PeerInfo, Topic } from '@wisp/protocol';
import { accountRows } from './mock-reads.ts';

interface Row {
  e: string;
  id: string;
  v: unknown;
}

/** The harnesses Settings → Agents lists (wisp.accounts' topic), as v1's reference had them: Claude Code and Codex
 * with their own sign-in, opencode wanting a key, the others signed in. */
const HARNESS_ROWS: Row[] = [
  ...(
    [
      { id: 'claude', name: 'Claude Code', version: '9.9.9 (Fake Claude Code)', models: 4, signIn: 'cli', brand: 'Claude' },
      { id: 'codex', name: 'Codex', version: 'fake-codex 9.9.9', models: 2, signIn: 'cli', brand: 'Codex', provider: 'ChatGPT' },
      { id: 'opencode', name: 'opencode', version: '1.99.0', models: 2, signIn: 'key' },
      { id: 'cursor', name: 'Cursor', version: 'fake-cursor-agent 9.9.9', models: 2, signIn: 'none' },
      { id: 'antigravity', name: 'Antigravity', version: 'fake-agy 9.9.9', models: 2, signIn: 'cli' },
      { id: 'grok', name: 'Grok', version: 'fake-grok 9.9.9', models: 2, signIn: 'cli' },
      { id: 'copilot', name: 'Copilot', version: 'fake-copilot 9.9.9', models: 2, signIn: 'none' },
    ] as const
  ).map((h, ord) => ({
    e: 'accounts.harness',
    id: h.id,
    v: { ...h, ord, available: true, models: Array.from({ length: h.models }, (_, i) => ({ id: `${h.id}-m${i}`, label: `Model ${i + 1}` })) },
  })),
  // Antigravity and Grok signed in through their CLIs (v1's reference: "✓ Signed in · Sign out")
  ...(['antigravity', 'grok'] as const).map((agent) => ({ e: 'accounts.login', id: agent, v: { agent, account: '', state: 'done', signedIn: true } })),
  // what Ship it needs: git and the GitHub CLI, both installed
  { e: 'accounts.tool', id: 'git', v: { id: 'git', name: 'git', installed: true } },
  { e: 'accounts.tool', id: 'gh', v: { id: 'gh', name: 'GitHub CLI', installed: true } },
];

/** Settings → Connectors (wisp.connectors' topic), as v1's reference had it: none added, two found in OpenCode and
 * Cursor's own configs, and the harnesses that take connectors per turn. */
const CONNECTOR_ROWS: Row[] = [
  { e: 'connectors.found', id: 'posthog', v: { name: 'posthog', from: ['OpenCode'], transport: 'remote', url: 'https://mcp.posthog.com/mcp' } },
  { e: 'connectors.found', id: 'unstyle', v: { name: 'unstyle', from: ['Cursor'], transport: 'local', command: 'npx', args: ['-y', 'unstyle-mcp'] } },
  { e: 'connectors.reach', id: 'this', v: { harnesses: ['claude', 'codex', 'copilot', 'opencode', 'grok'] } },
];

/** Settings → Worktrees (wisp.worktrees' topic), as v1's reference had it: four tasks' folders, one uncommitted
 * file each, 8 KB apiece, 91.7 GB free. */
const WORKTREE_ROWS: Row[] = [
  ...(
    [
      ['wt-login', 'Fix the login bug', 'wisp/fix-the-login-bug-784f69c2'],
      ['wt-docs', 'Write docs for the API', 'wisp/write-docs-for-the-api-e5a1b7d0'],
      ['wt-store', 'Refactor the store', 'wisp/refactor-the-store-3c9e0a14'],
      ['wt-tests', 'Make the tests pass', 'wisp/make-the-tests-pass-b28d6f51'],
    ] as const
  ).map(([id, title, branch]) => ({ e: 'worktrees.item', id, v: { id, title, project: 'wisp-repo-ZaGhoN', branch, status: 'dirty', only: 1, size: 8192, used_at: 0, clean_at: null } })),
  { e: 'worktrees.status', id: 'status', v: { size: 32768, disk: { free: 91.7 * 1024 ** 3, total: 494 * 1024 ** 3 }, looking: false, cleaning: null, last: null } },
];

/** The terminals a Mac offers (Settings → General → Take over in), In wisp first as in v1's reference. */
const TERMINALS = [
  { e: 'terminal.app', id: 'wisp', v: { id: 'wisp', label: 'In wisp' } },
  { e: 'terminal.app', id: 'terminal', v: { id: 'terminal', label: 'Terminal' } },
  { e: 'terminal.app', id: 'iterm', v: { id: 'iterm', label: 'iTerm' } },
  { e: 'terminal.app', id: 'custom', v: { id: 'custom', label: 'Custom command…' } },
];

export interface Seeded {
  topics: Map<Topic, Row[]>;
  plugins: PeerInfo['plugins'];
  words: readonly string[];
  turn(session: string, id: string, idx: number, prompt: string, at: number): unknown;
  presentation(): unknown;
}

const MIN = 60_000;
const HOUR = 60 * MIN;

interface Task {
  title: string;
  agent: 'claude' | 'codex' | 'gemini';
  state: 'running' | 'review' | 'done' | 'error';
  ago: number;
  cwd: string;
  prompt: string;
  answer: string;
  live?: string;
  unread?: boolean;
  archived?: boolean;
  turns?: number;
  branch?: string;
  cost?: number;
  /** a crew member's job (body.ext["wisp.crew"]): a delegated one sits under its member in the phone's Crew section */
  crew?: { id: string; job: string; from?: { id: string; title: string } };
  /** a channel's mode cap (runtime's `capped` list field, F-chan-10) */
  capped?: 'plan' | 'edits';
}

const TASKS: Task[] = [
  {
    title: 'Review the reconnect fix against the sync spec',
    agent: 'claude',
    state: 'running',
    ago: 3 * MIN,
    cwd: '~/code/wisp',
    prompt: 'Ada, check the reconnect fix against docs/sync.md and say what it misses.',
    answer: 'Reading the spec next to the diff.',
    live: 'Reading docs/sync.md',
    // handed out by the flaky-test task (s0001): its Team tab lists it (F-crew-11)
    crew: { id: 'crew:ada', job: 'delegated', from: { id: 's0001', title: 'Fix the flaky reconnect test in sync' } },
  },
  {
    title: 'Fix the flaky reconnect test in sync',
    agent: 'claude',
    state: 'running',
    ago: 1 * MIN,
    cwd: '~/code/wisp',
    prompt: 'The reconnect test in packages/sync fails one run in ten. Find out why and fix it at the root.',
    answer: 'Reading the test and the retry timer…',
    live: 'Running npm test -- sync',
    turns: 2,
    branch: 'fix/sync-reconnect',
    cost: 0.42,
  },
  {
    title: 'Add rate limiting to /login',
    agent: 'claude',
    state: 'review',
    ago: 12 * MIN,
    cwd: '~/code/api',
    prompt: 'Add a sliding-window rate limit to /login: 5 attempts per minute per IP.',
    answer: 'Added a sliding-window limiter to /login. Five attempts per minute per IP, then 429 with Retry-After. Tests cover the window edge and X-Forwarded-For.',
    unread: true,
    turns: 3,
    branch: 'feat/login-limit',
    cost: 1.18,
  },
  {
    title: 'Why is the list query slow on 5k sessions?',
    agent: 'codex',
    state: 'review',
    ago: 40 * MIN,
    cwd: '~/code/wisp',
    prompt: 'List query takes 40 ms on 5k sessions. Profile it and tell me what to change.',
    answer: 'The list query sorts in JS after reading every row. An index on (archived, updated_at) and a LIMIT bring it to 1.8 ms.',
    turns: 1,
    cost: 0.31,
  },
  {
    title: 'Ship the settings redesign',
    agent: 'claude',
    state: 'done',
    ago: 3 * HOUR,
    cwd: '~/code/wisp',
    prompt: 'Commit the settings redesign, open a PR and merge it once CI is green.',
    answer: 'Merged #812 into main. CI passed on Node 22 and 24.',
    turns: 4,
    branch: 'feat/settings-v2',
    cost: 2.05,
  },
  {
    title: 'Migrate the grid box image to Debian 13',
    agent: 'gemini',
    state: 'error',
    ago: 5 * HOUR,
    cwd: '~/code/grid',
    prompt: 'Move the box image from Debian 12 to 13 and keep gVisor working.',
    answer: 'The build failed: runsc 2025-10 does not start on the 6.12 kernel. Pinning runsc 2026-02 fixes it, but I need you to approve the kernel change.',
    turns: 2,
    cost: 0.88,
  },
  {
    title: 'Write the onboarding email copy',
    agent: 'claude',
    state: 'done',
    ago: 26 * HOUR,
    cwd: '~/notes',
    prompt: 'Three short onboarding emails for new grid users. Plain words, one action each.',
    answer: 'Three emails: Welcome (open your first task), Day 2 (add your laptop), Day 7 (invite a teammate). Each under 90 words.',
    turns: 1,
    cost: 0.12,
  },
  {
    title: 'Review PR #806: virtual list measuring',
    agent: 'codex',
    state: 'review',
    ago: 2 * HOUR,
    cwd: '~/code/wisp',
    prompt: 'Review PR #806 and leave comments where it reads layout after writing.',
    answer: 'Two places read offsetHeight after a write in the same frame (VirtualList.tsx:88 and :141). Suggested batching both into the ResizeObserver callback.',
    turns: 1,
    cost: 0.27,
  },
  {
    title: 'Bump the Android app to SDK 36',
    agent: 'claude',
    state: 'running',
    ago: 4 * MIN,
    cwd: '~/code/wisp/mobile',
    prompt: 'Update targetSdk to 36 and fix whatever breaks.',
    answer: 'Updating Gradle and the manifest…',
    live: 'Running ./gradlew assembleDebug',
    turns: 1,
    cost: 0.19,
  },
  {
    title: 'Archive: old Electron notes',
    agent: 'claude',
    state: 'done',
    ago: 9 * 24 * HOUR,
    cwd: '~/notes',
    prompt: 'Summarise why we dropped Electron.',
    answer: 'Tauri: 36 MB vs 180 MB, one Rust shell, no Node in the app.',
    archived: true,
    turns: 1,
    cost: 0.04,
  },
  {
    title: 'A very long task title that goes on and on to check that the row truncates with an ellipsis and never wraps onto a second line in the list',
    agent: 'claude',
    state: 'review',
    ago: 7 * HOUR,
    cwd: '~/code/wisp',
    prompt: 'Check long titles.',
    answer: 'They truncate.',
    turns: 1,
  },
  {
    // started from a Slack thread: held at Edits until you lift it (F-chan-10)
    title: 'Bump the retry limit the #ops thread asked for',
    agent: 'claude',
    state: 'review',
    ago: 8 * HOUR,
    cwd: '~/code/api',
    prompt: 'From #ops: the webhook retry limit is too low, raise it to 8.',
    answer: 'Raised the webhook retry limit to 8 in config/retry.ts. The test for the backoff cap still passes.',
    turns: 1,
    cost: 0.09,
    capped: 'edits',
  },
];

const WORDS =
  'I read the test and the retry timer. The flake comes from a timer that fires after the stream closes, so the second connect sees a stale cursor. The fix clears the timer in the scope that owns the stream, and the test now waits on the welcome instead of a fixed delay. I ran it 200 times with no failure.'.split(
    ' ',
  );

export const PRESENTATION = {
  v: 1,
  dropped: [],
  blocks: [
    {
      type: 'hero',
      title: 'Reconnect test fixed',
      topic: 'Flaky reconnect test',
      summary: 'A retry timer outlived its stream. It now belongs to the stream scope; 200 runs, no failure.',
      status: 'done',
    },
    {
      type: 'steps',
      title: 'What I did',
      items: [
        { title: 'Reproduced', detail: '1 in 9 runs failed locally', status: 'done' },
        { title: 'Found the timer', detail: 'peers.ts retry fired after dispose', status: 'done' },
        { title: 'Moved it into the scope', status: 'done' },
        { title: 'Ran it 200 times', status: 'done' },
      ],
    },
    { type: 'diff', file: 'packages/client/src/peers.ts', before: 'setTimeout(() => feed(p, { kind: "open" }), delay);', after: 'p.scope.timeout(delay, () => feed(p, { kind: "open" }));' },
    { type: 'tests', command: 'npm test -- sync', passed: 48, failed: 0, skipped: 2, durationMs: 4100 },
    {
      type: 'files',
      items: [
        { path: 'packages/client/src/peers.ts', change: 'modified', note: 'retry belongs to the scope' },
        { path: 'packages/client/test/peers.test.ts', change: 'modified', note: 'waits on welcome' },
      ],
    },
    { type: 'callout', tone: 'info', title: 'Assumption', text: 'The 15 s heartbeat stays; only the retry moved.' },
    { type: 'actions', items: [{ label: 'Commit and open a PR', reply: 'Commit this and open a PR' }] },
  ],
};

const PLUGINS: PeerInfo['plugins'] = [
  {
    id: 'wisp.runtime',
    version: '2.0.0',
    commands: [
      'runtime.create',
      'runtime.followUp',
      'runtime.stop',
      'runtime.rename',
      'runtime.archive',
      'runtime.markRead',
      'runtime.setState',
      'runtime.delete',
      'runtime.rerun',
      'runtime.fork',
      'runtime.setMode',
      'runtime.setAgent',
      'runtime.forLater',
      'goal.set',
      'ship.open',
      'checkpoint.restore',
    ],
    topics: ['list', 'session:*'],
    blocks: ['hero', 'steps', 'diff', 'tests', 'files', 'callout', 'actions'],
  },
  { id: 'wisp.settings', version: '2.0.0', commands: ['settings.set'], topics: ['config'], blocks: [] },
  { id: 'wisp.crew', version: '2.0.0', commands: [], topics: ['crew'], blocks: [] },
  { id: 'wisp.machines', version: '2.0.0', commands: [], topics: ['machines'], blocks: [] },
  { id: 'wisp.stuff', version: '2.0.0', commands: ['stuff.delete'], topics: ['stuff'], blocks: [] },
];

const MODEL: Record<Task['agent'], string> = { claude: 'claude-opus-5-5', codex: 'gpt-5.5-codex', gemini: 'gemini-3-pro' };

function turnRow(session: string, id: string, idx: number, prompt: string, at: number, answer = '', status = 'running', agent: Task['agent'] = 'claude'): unknown {
  const done = status === 'done';
  const body = {
    id,
    session_id: session,
    idx,
    prompt,
    agent,
    model: MODEL[agent],
    effort: 'high',
    mode: 'auto',
    attachments: [],
    status,
    started_at: at,
    n_events: 4,
    is_error: status === 'error',
    ext: {},
    ...(answer && { text: answer }),
    ...(done && { presentation: PRESENTATION, ended_at: at + 2 * MIN, stats: { cost_usd: 0.42, input_tokens: 18200, output_tokens: 2100, ms: 96000 } }),
  };
  return { id, session_id: session, idx, status, started_at: at, ended_at: status === 'running' ? null : at + 2 * MIN, prompt, answer, body };
}

function sessionRow(peer: string, i: number, t: Task, now: number): { id: string; v: Record<string, unknown> } {
  const id = `${peer}:s${String(i).padStart(4, '0')}`;
  const at = now - t.ago;
  const status = t.state === 'running' ? 'running' : t.state === 'error' ? 'blocked' : 'done';
  return {
    id,
    v: {
      id,
      parent_id: null,
      title: t.title,
      state: t.state,
      agent: t.agent,
      archived: t.archived === true,
      unread: t.unread === true,
      created_at: at - (t.turns ?? 1) * 20 * MIN,
      updated_at: at,
      rev: 1,
      summary: {
        status,
        turnCount: t.turns ?? 1,
        queued: 0,
        preview: t.answer.slice(0, 90),
        live: t.live ?? '',
        cwd: t.cwd,
        model: MODEL[t.agent],
        mode: t.capped ?? 'auto',
        ...(t.capped && { capped: t.capped }),
        forLater: false,
        ...(t.cost !== undefined && { costUsd: t.cost }),
        ...(t.branch && { branch: t.branch }),
      },
      body: { cwd: t.cwd, dirs: [], queue_held: false, tags: [], ext: t.crew ? { 'wisp.crew': t.crew } : {} },
    },
  };
}

function events(sid: string, turnId: string, t: Task, at: number): unknown[] {
  const list = [
    { kind: 'thinking', body: { kind: 'thinking', text: 'Looking at where this starts.' } },
    { kind: 'tool', body: { kind: 'tool', tool: 'read', label: `Read ${t.cwd}/README.md`, file: 'README.md' } },
    { kind: 'tool', body: { kind: 'tool', tool: 'bash', label: 'npm test', detail: '48 passed' } },
    { kind: 'text', body: { kind: 'text', text: t.answer } },
  ];
  return list.map((e, i) => ({ session_id: sid, seq: i + 1, turn_id: turnId, t: at + i * 1000, ...e }));
}

const CREW = [
  { id: 'crew:ada', name: 'Ada', role: 'Reviewer', agent: 'claude', color: 'violet', skills: ['review', 'tests'], status: 'idle', jobs: 12 },
  { id: 'crew:linus', name: 'Linus', role: 'Release manager', agent: 'codex', color: 'teal', skills: ['ship', 'changelog'], status: 'working', jobs: 31 },
  { id: 'crew:grace', name: 'Grace', role: 'On call', agent: 'claude', color: 'amber', skills: ['logs', 'grid'], status: 'idle', jobs: 4 },
  // two more, so the phone's Crew section folds the quiet ones into a row of faces (F-crew-16)
  { id: 'crew:hopper', name: 'Hopper', role: 'Docs writer', agent: 'claude', color: 'rose', skills: ['docs'], status: 'idle', jobs: 2 },
  { id: 'crew:turing', name: 'Turing', role: 'Bench watcher', agent: 'codex', color: 'sky', skills: ['bench'], status: 'idle', jobs: 1, paused: true },
];

// Ada's kit and what her delegated job proposed for it (F-crew-10, F-crew-19): the member page's Skills and
// instructions, and the offer under that job in her thread
const ADA_KIT = {
  kit: [
    { id: 'k0agents01', kind: 'rules', name: 'AGENTS.md', body: '- Run the tests before you report.\n- Never push to main.', on: true },
    { id: 'k0review01', kind: 'skill', name: 'review-sync', description: 'Reviewing a change to the sync protocol against docs/sync.md.', body: '1. Read docs/sync.md.\n2. Diff the change.', on: true },
    { id: 'k0flaky001', kind: 'skill', name: 'flaky-tests', description: 'A test that fails only some of the time.', body: '1. Run it 50 times.', on: false },
  ],
  notebook: 'The reconnect test is flaky on macOS.',
  offers: [
    {
      id: 'o0ada0001',
      state: 'open',
      files: [
        { kind: 'skill', name: 'reconnect-check', description: 'Checking a reconnect fix: cursors, resume, the outbox.', body: '1. Kill the socket mid-patch.\n2. Check the cursor resumes.' },
        { kind: 'rules', name: 'AGENTS.md', body: '- Run the tests before you report.\n- Read docs/sync.md before any sync change.' },
      ],
    },
  ],
};

const MACHINES = [
  {
    id: 'studio',
    peer: 'studio',
    name: 'studio-mac',
    transport: 'ssh',
    address: 'studio.local',
    port: 22,
    kind: 'ssh',
    target: 'studio.local',
    state: 'online',
    steps: [],
    error: '',
    stale: false,
    attempt: 0,
    projects: 3,
    working: 1,
    remote: { version: '2.0.0', platform: 'darwin', agents: [] },
    outdated: null,
    log: [],
  },
  {
    id: 'box',
    peer: 'box',
    name: 'mokh.grid',
    transport: 'grid',
    address: 'mokh.grid.trywisp.dev',
    port: 443,
    kind: 'grid',
    target: 'mokh.grid.trywisp.dev',
    state: 'asleep',
    steps: [],
    error: '',
    stale: false,
    attempt: 0,
    projects: 1,
    working: 0,
    remote: null,
    outdated: null,
    log: [],
  },
  {
    id: 'pi',
    peer: 'pi',
    name: 'raspberry',
    transport: 'ssh',
    address: '192.168.1.40',
    port: 22,
    kind: 'ssh',
    target: 'pi@192.168.1.40',
    state: 'error',
    steps: [],
    error: 'Connection refused',
    hint: { text: 'Is sshd running on the Pi?' },
    stale: false,
    attempt: 3,
    projects: 0,
    working: 0,
    remote: null,
    outdated: '2.0.0',
    log: [],
  },
];

const STUFF = [
  { id: 'st1', kind: 'doc', title: 'wisp v2 rewrite plan', path: '~/.wisp/stuff/r9-wisp-rewrite-plan.md', size: 98_000 },
  { id: 'st2', kind: 'app', title: 'Token budget dashboard', path: '~/.wisp/stuff/budget/index.html', size: 14_000 },
  { id: 'st3', kind: 'image', title: 'Settings, phone, dark', path: '~/.wisp/stuff/settings-390-dark.png', size: 220_000 },
];

function sessionTopic(peer: string, i: number, t: Task, now: number): { list: Row; own: Row[] } {
  const s = sessionRow(peer, i, t, now);
  const own: Row[] = [{ e: 'session', id: s.id, v: s.v }];
  const n = t.turns ?? 1;
  for (let k = 0; k < n; k++) {
    const tid = `${s.id}:t${k + 1}`;
    const last = k === n - 1;
    const status = last && t.state === 'running' ? 'running' : last && t.state === 'error' ? 'error' : 'done';
    own.push({ e: 'turn', id: tid, v: turnRow(s.id, tid, k, k === 0 ? t.prompt : 'Keep going.', now - t.ago - (n - k) * 10 * MIN, last ? t.answer : 'Done that.', status, t.agent) });
  }
  own.push({ e: 'event', id: s.id, v: events(s.id, `${s.id}:t${n}`, t, now - t.ago - 2 * MIN) });
  return { list: { e: 'session', id: s.id, v: s.v }, own };
}

function withMedia(topics: Map<Topic, Row[]>): void {
  for (const rows of topics.values()) {
    const turn = rows.find((r) => r.e === 'turn' && (r.v as { body?: { presentation?: unknown } }).body?.presentation);
    if (!turn) continue;
    const v = turn.v as { body: Record<string, unknown> };
    v.body = { ...v.body, presentation: { ...PRESENTATION, blocks: [PRESENTATION.blocks[0], ...MEDIA_BLOCKS, ...PRESENTATION.blocks.slice(1)] } };
    return;
  }
}

/** `firstRun`: no tasks yet (New task's first-run launcher, F-comp-35); the rest of the seed as it is. */
/**
 * `computers`: a second computer, Studio (its own mock peer at /api/peer/studio), listed on this one's machines, and one
 * project here (`wisp`, a repo with an origin), to run a task over there (v1 places.js; New task's Run on, Rerun…).
 */
export const STUDIO = 'studio';
export const COMPUTERS_PROJECT = { id: 'local:wisp', name: 'wisp', path: '/Users/me/code/wisp', color: 'violet' };

/** `media`: the first finished task's answer shows two pictures and a video (the viewer, Copy, Show in folder; the
 *  mock serves each at /api/sessions/<id>/file as a drawn SVG, the video as a missing file). */
export const MEDIA_BLOCKS = [
  { type: 'image', path: 'shots/before.png', caption: 'Before: the retry fires after dispose' },
  { type: 'image', path: '/tmp/after.png', caption: 'After: 200 runs, no failure' },
  { type: 'video', path: 'shots/run.mp4', caption: 'The run' },
];

/** `env`: the first task's first turn changed `.env.local` and `src/config.ts` (F-page-41: Changes masks the .env). The
 *  mock's git reads a folder's first task, so every task in ~/code/wisp shows them. */
export const ENV_CHANGES = [
  { file: '.env.local', op: 'modify', beforeFile: 'API_URL=https://api.dev.example\nSTRIPE_KEY=sk_test_51Hb0rk\n# local only\nDEBUG=\n', edits: [{ before: 'sk_test_51Hb0rk', after: 'sk_test_77Qx2m' }] },
  { file: 'src/config.ts', op: 'modify', beforeFile: "export const retries = 2;\nexport const timeout = 5000;\n", edits: [{ before: 'retries = 2', after: 'retries = 3' }] },
];

function withEnv(topics: Map<Topic, Row[]>): void {
  for (const rows of topics.values()) {
    const turn = rows.find((r) => r.e === 'turn');
    if (!turn) continue;
    const v = turn.v as { body: Record<string, unknown> };
    v.body = { ...v.body, changes: ENV_CHANGES };
    return;
  }
}

/** A lead's usage (v1 #785): its own numbers, two subagents (one on Codex: another plan), the server's sum and how
 * full its context is, as wisp.runtime puts them on the row (usage_row.rs). */
function withUsage(list: Row[]): void {
  const done = list.filter((r) => (r.v as { summary: { status: string } }).summary.status === 'done');
  const [lead, sub] = done;
  if (!lead || !sub) return;
  const v = lead.v as { summary: Record<string, unknown> };
  const bare = (id: string): string => id.slice(id.indexOf(':') + 1);
  v.summary = {
    ...v.summary,
    tokens: 912_000,
    plan: { seven_day: 0.04, five_hour: 0.18 },
    planOn: ['claude default'],
    context: { tokens: 170_000, window: 200_000 },
    subUsage: [
      { id: bare(sub.id), name: 'tester', title: String((sub.v as { title: string }).title), agent: 'claude', tokens: 288_000, plan: { seven_day: 0.02, five_hour: 0.03 } },
      { id: 'gone', name: 'reviewer', title: 'Review the diff', agent: 'codex', tokens: 41_000, plan: { seven_day: 0.1 }, samePlan: false },
    ],
    usage: { tokens: 1_241_000, plan: { seven_day: 0.06, five_hour: 0.21 } },
  };
}

/** Try it two ways (F-comp-31, ADR-0056): one task run twice on Claude Code, run B with Skills off, both done; the
 * rows carry runtime's trial link (group.rs) as the peer sends it, so Compare runs says what differed. */
function withTrial(peer: string, now: number, list: Row[], topics: Map<Topic, Row[]>, at: number): void {
  const base: Task = {
    title: 'Speed up the session list query',
    agent: 'claude',
    state: 'review',
    ago: 40 * MIN,
    cwd: '~/code/wisp',
    prompt: 'The session list query takes 30 ms on 5k sessions. Get it under 5 ms.',
    answer: 'Added a covering index on (archived, updated_at); the query runs in 2.1 ms on 5k sessions.',
    turns: 1,
    cost: 0.61,
  };
  const runs = [
    sessionTopic(peer, at, base, now),
    sessionTopic(peer, at + 1, { ...base, ago: 38 * MIN, cost: 0.44, answer: 'Rewrote the query to read the summary column only and added an index; 3.4 ms on 5k sessions.' }, now),
  ];
  const ids = runs.map((r) => r.list.id.slice(r.list.id.indexOf(':') + 1));
  const differs = [{ key: 'skills', values: ['on', 'off'] }];
  runs.forEach((r, run) => {
    for (const row of [r.list, ...r.own.filter((x) => x.e === 'session')]) {
      const v = row.v as { summary: Record<string, unknown> };
      v.summary = { ...v.summary, groupId: 'g-trial', trial: { group: 'g-trial', run, runs: ids, differs, kept: null }, ...(run === 1 && { variant: { skills: 'off' } }) };
    }
    list.push(r.list);
    topics.set(`session:${ids[run] ?? ''}`, r.own);
  });
}

export function seed(o: { peer: string; now: number; extra: number; firstRun?: boolean; computers?: boolean; media?: boolean; env?: boolean; usage?: boolean; trial?: boolean }): Seeded {
  const topics = new Map<Topic, Row[]>();
  const list: Row[] = [];
  (o.firstRun ? [] : TASKS).forEach((t, i) => {
    const s = sessionTopic(o.peer, i, t, o.now);
    list.push(s.list);
    topics.set(`session:${s.list.id.slice(s.list.id.indexOf(':') + 1)}`, s.own); // the bare id, as the client subscribes
  });
  for (let i = 0; i < o.extra; i++) {
    const t: Task = {
      title: `Background task ${i + 1}: tidy module ${i % 97}`,
      agent: i % 3 === 0 ? 'codex' : 'claude',
      state: i % 11 === 0 ? 'running' : 'done',
      ago: (i + 30) * 7 * MIN,
      cwd: '~/code/wisp',
      prompt: 'Tidy it.',
      answer: 'Tidied.',
    };
    const s = sessionTopic(o.peer, TASKS.length + i, t, o.now);
    list.push(s.list);
    topics.set(`session:${s.list.id.slice(s.list.id.indexOf(':') + 1)}`, s.own); // the bare id, as the client subscribes
  }
  if (o.media) withMedia(topics);
  if (o.env) withEnv(topics);
  if (o.usage) withUsage(list);
  if (o.trial) withTrial(o.peer, o.now, list, topics, TASKS.length + o.extra);
  topics.set('list', list);
  topics.set('config', [
    { e: 'setting', id: 'shell.theme', v: { key: 'shell.theme', value: 'system', locked_by: null } },
    { e: 'setting', id: 'defaults.agent', v: { key: 'defaults.agent', value: 'claude', locked_by: null } },
    // the token dashboard pinned on Home (wisp.stuff's panes setting)
    { e: 'setting', id: 'stuff.panes', v: { key: 'stuff.panes', value: 'st2@home,st2@task', locked_by: null } },
    ...TERMINALS,
    ...(o.computers ? [{ e: 'project', id: COMPUTERS_PROJECT.id, v: COMPUTERS_PROJECT }] : []),
  ]);
  // two accounts on Claude Code, Codex's own one (fromV1 adds none, so qa/parity.mjs's shots don't change)
  topics.set('plugin:wisp.accounts:harnesses', [...HARNESS_ROWS, ...accountRows(o.now)]);
  topics.set('plugin:wisp.connectors:list', CONNECTOR_ROWS);
  topics.set('plugin:wisp.worktrees:worktrees', WORKTREE_ROWS);
  // usage stats off by the environment, as on v1's QA box (DO_NOT_TRACK)
  // the machine guard's reading, as v1's QA box showed it (Settings → Usage → Machine load: Now)
  topics.set('plugin:wisp.machine:load', LOAD_ROWS);
  topics.set('plugin:wisp.router:view', ROUTER_ROWS);
  topics.set('plugin:wisp.telemetry:state', [{ e: 'telemetry.state', id: 'this', v: { on: false, setting: true, blocked: true } }]);
  // MOCK_UPDATE=2.1.0: a newer wisp is out (the top bar's Update pill, Settings → Updates); no release feed is read
  const latest = typeof process === 'undefined' ? undefined : process.env['MOCK_UPDATE'];
  if (latest) topics.set('plugin:wisp.update:state', [{ e: 'update.state', id: 'update', v: { current: '2.0.0', latest, available: true, method: 'global', channel: 'stable', status: 'idle', error: null, enabled: true, command: 'npm install -g wisp-agents@latest', checked_at: o.now, checking: false, running: 1 } }]);
  topics.set(
    'crew',
    CREW.map((c) => ({ e: 'crew_member', id: c.id, v: c.id === 'crew:ada' ? { ...c, ...ADA_KIT, offers: ADA_KIT.offers.map((x) => ({ ...x, job: `${o.peer}:s0000`, at: o.now - 2 * MIN })) } : c })),
  );
  topics.set('machines', [
    ...MACHINES.map((m) => ({ e: 'machine', id: m.id, v: { ...m, addedAt: o.now - 30 * 24 * HOUR } })),
    // Studio as wisp.machines keeps a peer (`machines_peer`): the app adds it as a peer of its own
    ...(o.computers ? [{ e: 'machines_peer', id: `${o.peer}:${STUDIO}`, v: { id: `${o.peer}:${STUDIO}`, body: { peer: STUDIO, name: 'Studio' } } }] : []),
  ]);
  topics.set(
    'stuff',
    // wisp.stuff's rows (its UI reads `stuff.item`): name, when, who kept it; the dashboard may read and start tasks
    STUFF.map((s, i) => ({
      e: 'stuff.item',
      id: s.id,
      v: {
        ...s,
        name: s.path.slice(s.path.lastIndexOf('/') + 1),
        at: o.now - (i + 1) * 5 * HOUR,
        by: 'you',
        ...(s.kind === 'app' && { uses: ['tasks:read', 'tasks:write'], allowed: ['tasks:read', 'tasks:write'], rev: 1 }),
      },
    })),
  );
  return {
    topics,
    plugins: PLUGINS,
    words: WORDS,
    turn: (session, id, idx, prompt, at) => turnRow(session, id, idx, prompt, at),
    presentation: () => PRESENTATION,
  };
}

// ---------- Replaying v1's reference data (design/v1-reference/seed.json) ----------
// qa/parity.mjs starts the mock with MOCK_SEED=<seed.json>: vite-mock.ts reads the file and hands its
// JSON here, and the mock's clock starts at `captured`. The rows carry v1's exact strings (titles,
// the temp repo's name and paths, branches) and times, so a screen renders what v1 rendered.

interface V1Turn {
  id: string;
  prompt: string;
  agent: string;
  model: string;
  mode: string;
  startedAt: number;
  endedAt?: number | null;
  status: string;
  presentation?: unknown;
  stats?: unknown;
  checkpoint?: unknown;
  changes?: unknown;
  activity?: { t: number; kind: string; label?: string; detail?: string; file?: string }[];
  [k: string]: unknown;
}

interface V1Summary {
  id: string;
  title: string;
  agent: string;
  cwd: string;
  model: string;
  state: string;
  unread: boolean;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  status: string;
  preview: string;
  live: string;
  [k: string]: unknown;
}

export interface V1Seed {
  captured: string;
  list: V1Summary[];
  sessions: Record<string, { turns?: V1Turn[]; worktree?: unknown; [k: string]: unknown }>;
  crew: { id: string; [k: string]: unknown }[];
  config: { projects?: { id: string; [k: string]: unknown }[]; [k: string]: unknown };
}

const V1_STATE: Record<string, Task['state']> = { running: 'running', review: 'review', done: 'done', error: 'error', waiting: 'review' };

/** The capture time of a v1 seed: the mock's clock starts there. */
export const v1Captured = (v1: V1Seed): number => Date.parse(v1.captured);

/** The files each task changed (its turns' changes): v1 lists two open tasks of one project that
 * change the same file as overlapping (web/js/features/overlaps.js), oldest first. */
function overlaps(v1: V1Seed, peer: string): Map<string, { id: string; files: string[]; conflicts: string[] }[]> {
  const files = new Map<string, Set<string>>();
  for (const s of v1.list) files.set(s.id, new Set((v1.sessions[s.id]?.turns ?? []).flatMap((t) => ((t.changes as { file: string }[] | undefined) ?? []).map((c) => c.file))));
  const byAge = [...v1.list].filter((s) => !s.archived).sort((a, b) => a.createdAt - b.createdAt);
  const out = new Map<string, { id: string; files: string[]; conflicts: string[] }[]>();
  for (const s of byAge) {
    const mine = files.get(s.id) ?? new Set<string>();
    const with_ = byAge
      .filter((o) => o.id !== s.id && o['projectId'] === s['projectId'])
      .map((o) => ({ id: `${peer}:${o.id}`, files: [...(files.get(o.id) ?? [])].filter((f) => mine.has(f)), conflicts: [] as string[] }));
    out.set(
      s.id,
      with_.filter((o) => o.files.length > 0),
    );
  }
  return out;
}

const LOAD_ROWS: Row[] = [
  { e: 'machine.load', id: 'this', v: { at: 0, platform: 'darwin', mem_free_pct: 71, cpu: 50, runs: 0, held: null, limits: { floor: 15, maxRuns: 8 }, paused_until: 0, left_behind: 0 } },
];

/** Settings → Auto (wisp.router's view), as v1's QA box showed it: its defaults (learn from picks, try new models,
 * hand over on error; scout bigger tasks), every harness installed, 4 picks of yours and 3 runs learned from. */
const ROUTER_ROWS: Row[] = [
  {
    e: 'router_view',
    id: 'view',
    v: {
      priors: {},
      learned: 3,
      routed: 3,
      picks: 4,
      corrections: 0,
      arms: (
        [
          ['claude', 'Claude Code'],
          ['codex', 'Codex'],
          ['opencode', 'opencode'],
          ['cursor', 'Cursor'],
          ['antigravity', 'Antigravity'],
          ['grok', 'Grok'],
          ['copilot', 'Copilot'],
        ] as const
      ).map(([agent, name], tier) => ({ key: agent, agent, model: '', effort: '', label: name, tier, state: 'ready', chance: 0, n: 0, usd: 0, minutes: 0, prior: true })),
      recent: [],
      goal: 'balanced',
      settings: { explore: true, allowed: null, blocked: [], prefer: [], habits: true, escalate: true, best2: false, scout: 'big' },
      projects: [],
    },
  },
];

export function fromV1(v1: V1Seed, peer: string): Seeded {
  const topics = new Map<Topic, Row[]>();
  const list: Row[] = [];
  const shared = overlaps(v1, peer);
  for (const s of v1.list) {
    const id = `${peer}:${s.id}`;
    const full = v1.sessions[s.id] ?? {};
    const { id: _id, title, agent, state, unread, archived, createdAt, updatedAt, ...summary } = s;
    const v = {
      id,
      parent_id: null,
      title,
      state: V1_STATE[state] ?? 'review',
      agent,
      archived,
      unread,
      created_at: createdAt,
      updated_at: updatedAt,
      rev: 1,
      summary: { ...summary, forLater: false, worktree: full.worktree ?? null, overlaps: shared.get(s.id) ?? [] },
      body: { cwd: s.cwd, dirs: [], queue_held: false, tags: [], ext: {}, ...(full.turns?.length && { resumeId: `fake-${s.id}` }) }, // the fake claude named a conversation (v1's agentSessionId)
    };
    list.push({ e: 'session', id, v });
    const own: Row[] = [{ e: 'session', id, v }];
    const turns = full.turns ?? [];
    turns.forEach((t, idx) => {
      const tid = `${id}:${t.id}`;
      const text = typeof t['raw'] === 'string' ? t['raw'] : '';
      own.push({
        e: 'turn',
        id: tid,
        v: {
          id: tid,
          session_id: id,
          idx,
          status: t.status,
          started_at: t.startedAt,
          ended_at: t.endedAt ?? null,
          prompt: t.prompt,
          answer: text,
          body: { ...t, id: tid, session_id: id, idx, started_at: t.startedAt },
        },
      });
    });
    const last = turns[turns.length - 1];
    if (last) own.push({ e: 'event', id, v: (last.activity ?? []).map((a, i) => ({ session_id: id, seq: i + 1, turn_id: `${id}:${last.id}`, t: a.t, kind: a.kind, body: { ...a } })) });
    // the server names a task's topic by its bare id (as the client subscribes: `session:<id>`), whatever its rows' keys
    topics.set(`session:${s.id}`, own);
  }
  topics.set('list', list);
  topics.set('config', [
    { e: 'setting', id: 'shell.theme', v: { key: 'shell.theme', value: 'system', locked_by: null } },
    ...(v1.config.projects ?? []).map((p) => ({ e: 'project', id: p.id, v: p })),
    ...TERMINALS,
  ]);
  topics.set('plugin:wisp.accounts:harnesses', HARNESS_ROWS);
  topics.set('plugin:wisp.connectors:list', CONNECTOR_ROWS);
  topics.set('plugin:wisp.worktrees:worktrees', WORKTREE_ROWS);
  // usage stats off by the environment, as on v1's QA box (DO_NOT_TRACK)
  // the machine guard's reading, as v1's QA box showed it (Settings → Usage → Machine load: Now)
  topics.set('plugin:wisp.machine:load', LOAD_ROWS);
  topics.set('plugin:wisp.router:view', ROUTER_ROWS);
  topics.set('plugin:wisp.telemetry:state', [{ e: 'telemetry.state', id: 'this', v: { on: false, setting: true, blocked: true } }]);
  topics.set(
    'crew',
    v1.crew.map((c) => ({ e: 'crew_member', id: c.id, v: c })),
  );
  topics.set('machines', []);
  topics.set('stuff', []);
  return {
    topics,
    plugins: PLUGINS,
    words: WORDS,
    turn: (session, id, idx, prompt, at) => turnRow(session, id, idx, prompt, at),
    presentation: () => PRESENTATION,
  };
}
