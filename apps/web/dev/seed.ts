// The mock peer's data: what a real wisp holds after a week of use, shaped like the Rust store's rows
// (plugins/runtime/host/src/rows.rs) and v1's JSON (server/runner.js summarize, server/crew.js,
// server/machines.js, server/stuff.js). Deterministic: the same `now` gives the same rows, so
// screenshots and tests don't drift. `extra` adds plain sessions for a long list (5k for perf).

import type { PeerInfo, Topic } from '@wisp/protocol';

interface Row {
  e: string;
  id: string;
  v: unknown;
}

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
}

const TASKS: Task[] = [
  { title: 'Fix the flaky reconnect test in sync', agent: 'claude', state: 'running', ago: 1 * MIN, cwd: '~/code/wisp', prompt: 'The reconnect test in packages/sync fails one run in ten. Find out why and fix it at the root.', answer: 'Reading the test and the retry timer…', live: 'Running npm test -- sync', turns: 2, branch: 'fix/sync-reconnect', cost: 0.42 },
  { title: 'Add rate limiting to /login', agent: 'claude', state: 'review', ago: 12 * MIN, cwd: '~/code/api', prompt: 'Add a sliding-window rate limit to /login: 5 attempts per minute per IP.', answer: 'Added a sliding-window limiter to /login. Five attempts per minute per IP, then 429 with Retry-After. Tests cover the window edge and X-Forwarded-For.', unread: true, turns: 3, branch: 'feat/login-limit', cost: 1.18 },
  { title: 'Why is the list query slow on 5k sessions?', agent: 'codex', state: 'review', ago: 40 * MIN, cwd: '~/code/wisp', prompt: 'List query takes 40 ms on 5k sessions. Profile it and tell me what to change.', answer: 'The list query sorts in JS after reading every row. An index on (archived, updated_at) and a LIMIT bring it to 1.8 ms.', turns: 1, cost: 0.31 },
  { title: 'Ship the settings redesign', agent: 'claude', state: 'done', ago: 3 * HOUR, cwd: '~/code/wisp', prompt: 'Commit the settings redesign, open a PR and merge it once CI is green.', answer: 'Merged #812 into main. CI passed on Node 22 and 24.', turns: 4, branch: 'feat/settings-v2', cost: 2.05 },
  { title: 'Migrate the grid box image to Debian 13', agent: 'gemini', state: 'error', ago: 5 * HOUR, cwd: '~/code/grid', prompt: 'Move the box image from Debian 12 to 13 and keep gVisor working.', answer: 'The build failed: runsc 2025-10 does not start on the 6.12 kernel. Pinning runsc 2026-02 fixes it, but I need you to approve the kernel change.', turns: 2, cost: 0.88 },
  { title: 'Write the onboarding email copy', agent: 'claude', state: 'done', ago: 26 * HOUR, cwd: '~/notes', prompt: 'Three short onboarding emails for new grid users. Plain words, one action each.', answer: 'Three emails: Welcome (open your first task), Day 2 (add your laptop), Day 7 (invite a teammate). Each under 90 words.', turns: 1, cost: 0.12 },
  { title: 'Review PR #806: virtual list measuring', agent: 'codex', state: 'review', ago: 2 * HOUR, cwd: '~/code/wisp', prompt: 'Review PR #806 and leave comments where it reads layout after writing.', answer: 'Two places read offsetHeight after a write in the same frame (VirtualList.tsx:88 and :141). Suggested batching both into the ResizeObserver callback.', turns: 1, cost: 0.27 },
  { title: 'Bump the Android app to SDK 36', agent: 'claude', state: 'running', ago: 4 * MIN, cwd: '~/code/wisp/mobile', prompt: 'Update targetSdk to 36 and fix whatever breaks.', answer: 'Updating Gradle and the manifest…', live: 'Running ./gradlew assembleDebug', turns: 1, cost: 0.19 },
  { title: 'Archive: old Electron notes', agent: 'claude', state: 'done', ago: 9 * 24 * HOUR, cwd: '~/notes', prompt: 'Summarise why we dropped Electron.', answer: 'Tauri: 36 MB vs 180 MB, one Rust shell, no Node in the app.', archived: true, turns: 1, cost: 0.04 },
  { title: 'A very long task title that goes on and on to check that the row truncates with an ellipsis and never wraps onto a second line in the list', agent: 'claude', state: 'review', ago: 7 * HOUR, cwd: '~/code/wisp', prompt: 'Check long titles.', answer: 'They truncate.', turns: 1 },
];

const WORDS = 'I read the test and the retry timer. The flake comes from a timer that fires after the stream closes, so the second connect sees a stale cursor. The fix clears the timer in the scope that owns the stream, and the test now waits on the welcome instead of a fixed delay. I ran it 200 times with no failure.'.split(' ');

export const PRESENTATION = {
  v: 1,
  dropped: [],
  blocks: [
    { type: 'hero', title: 'Reconnect test fixed', topic: 'Flaky reconnect test', summary: 'A retry timer outlived its stream. It now belongs to the stream scope; 200 runs, no failure.', status: 'done' },
    { type: 'steps', title: 'What I did', items: [{ title: 'Reproduced', detail: '1 in 9 runs failed locally', status: 'done' }, { title: 'Found the timer', detail: 'peers.ts retry fired after dispose', status: 'done' }, { title: 'Moved it into the scope', status: 'done' }, { title: 'Ran it 200 times', status: 'done' }] },
    { type: 'diff', file: 'packages/client/src/peers.ts', before: 'setTimeout(() => feed(p, { kind: "open" }), delay);', after: 'p.scope.timeout(delay, () => feed(p, { kind: "open" }));' },
    { type: 'tests', command: 'npm test -- sync', passed: 48, failed: 0, skipped: 2, durationMs: 4100 },
    { type: 'files', items: [{ path: 'packages/client/src/peers.ts', change: 'modified', note: 'retry belongs to the scope' }, { path: 'packages/client/test/peers.test.ts', change: 'modified', note: 'waits on welcome' }] },
    { type: 'callout', tone: 'info', title: 'Assumption', text: 'The 15 s heartbeat stays; only the retry moved.' },
    { type: 'actions', items: [{ label: 'Commit and open a PR', reply: 'Commit this and open a PR' }] },
  ],
};

const PLUGINS: PeerInfo['plugins'] = [
  { id: 'wisp.runtime', version: '2.0.0', commands: ['runtime.create', 'runtime.followUp', 'runtime.stop', 'runtime.rename', 'runtime.archive', 'runtime.markRead', 'runtime.setState', 'runtime.delete'], topics: ['list', 'session:*'], blocks: ['hero', 'steps', 'diff', 'tests', 'files', 'callout', 'actions'] },
  { id: 'wisp.settings', version: '2.0.0', commands: ['settings.set'], topics: ['config'], blocks: [] },
  { id: 'wisp.crew', version: '2.0.0', commands: [], topics: ['crew'], blocks: [] },
  { id: 'wisp.machines', version: '2.0.0', commands: [], topics: ['machines'], blocks: [] },
  { id: 'wisp.stuff', version: '2.0.0', commands: ['stuff.delete'], topics: ['stuff'], blocks: [] },
];

const MODEL: Record<Task['agent'], string> = { claude: 'claude-opus-5-5', codex: 'gpt-5.5-codex', gemini: 'gemini-3-pro' };

function turnRow(session: string, id: string, idx: number, prompt: string, at: number, answer = '', status = 'running', agent: Task['agent'] = 'claude'): unknown {
  const done = status === 'done';
  const body = {
    id, session_id: session, idx, prompt, agent, model: MODEL[agent], effort: 'high', mode: 'auto', attachments: [], status, started_at: at, n_events: 4, is_error: status === 'error', ext: {},
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
      id, parent_id: null, title: t.title, state: t.state, agent: t.agent, archived: t.archived === true, unread: t.unread === true, created_at: at - (t.turns ?? 1) * 20 * MIN, updated_at: at, rev: 1,
      summary: { status, turnCount: t.turns ?? 1, queued: 0, preview: t.answer.slice(0, 90), live: t.live ?? '', cwd: t.cwd, model: MODEL[t.agent], mode: 'auto', forLater: false, ...(t.cost !== undefined && { costUsd: t.cost }), ...(t.branch && { branch: t.branch }) },
      body: { cwd: t.cwd, dirs: [], queue_held: false, tags: [], ext: {} },
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
];

const MACHINES = [
  { id: 'studio', peer: 'studio', name: 'studio-mac', transport: 'ssh', address: 'studio.local', port: 22, kind: 'ssh', target: 'studio.local', state: 'online', steps: [], error: '', stale: false, attempt: 0, projects: 3, working: 1, remote: { version: '2.0.0', platform: 'darwin', agents: [] }, outdated: null, log: [] },
  { id: 'box', peer: 'box', name: 'mokh.grid', transport: 'grid', address: 'mokh.grid.trywisp.dev', port: 443, kind: 'grid', target: 'mokh.grid.trywisp.dev', state: 'asleep', steps: [], error: '', stale: false, attempt: 0, projects: 1, working: 0, remote: null, outdated: null, log: [] },
  { id: 'pi', peer: 'pi', name: 'raspberry', transport: 'ssh', address: '192.168.1.40', port: 22, kind: 'ssh', target: 'pi@192.168.1.40', state: 'error', steps: [], error: 'Connection refused', hint: { text: 'Is sshd running on the Pi?' }, stale: false, attempt: 3, projects: 0, working: 0, remote: null, outdated: '2.0.0', log: [] },
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

export function seed(o: { peer: string; now: number; extra: number }): Seeded {
  const topics = new Map<Topic, Row[]>();
  const list: Row[] = [];
  TASKS.forEach((t, i) => {
    const s = sessionTopic(o.peer, i, t, o.now);
    list.push(s.list);
    topics.set(`session:${s.list.id}`, s.own);
  });
  for (let i = 0; i < o.extra; i++) {
    const t: Task = { title: `Background task ${i + 1}: tidy module ${i % 97}`, agent: i % 3 === 0 ? 'codex' : 'claude', state: i % 11 === 0 ? 'running' : 'done', ago: (i + 30) * 7 * MIN, cwd: '~/code/wisp', prompt: 'Tidy it.', answer: 'Tidied.' };
    const s = sessionTopic(o.peer, TASKS.length + i, t, o.now);
    list.push(s.list);
    topics.set(`session:${s.list.id}`, s.own);
  }
  topics.set('list', list);
  topics.set('config', [
    { e: 'setting', id: 'shell.theme', v: { key: 'shell.theme', value: 'system', locked_by: null } },
    { e: 'setting', id: 'defaults.agent', v: { key: 'defaults.agent', value: 'claude', locked_by: null } },
  ]);
  topics.set('crew', CREW.map((c) => ({ e: 'crew.member', id: c.id, v: c })));
  topics.set('machines', MACHINES.map((m) => ({ e: 'machine', id: m.id, v: { ...m, addedAt: o.now - 30 * 24 * HOUR } })));
  topics.set('stuff', STUFF.map((s, i) => ({ e: 'stuff', id: s.id, v: { ...s, savedAt: o.now - (i + 1) * 5 * HOUR } })));
  return {
    topics,
    plugins: PLUGINS,
    words: WORDS,
    turn: (session, id, idx, prompt, at) => turnRow(session, id, idx, prompt, at),
    presentation: () => PRESENTATION,
  };
}
