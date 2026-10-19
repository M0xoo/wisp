// The first thing a new user sees: a pre-rendered "session" that explains wisp
// using the same blocks an agent would. Doubles as a living block gallery.

import os from 'node:os';
import { newId } from './util.js';

export function welcomeSession() {
  const now = Date.now();
  return {
    id: newId(),
    title: 'Welcome to wisp',
    titleAuto: false,
    agent: 'wisp',
    cwd: os.homedir(),
    mode: 'plan',
    model: '',
    state: 'review',
    unread: true,
    createdAt: now,
    updatedAt: now,
    agentSessionId: null,
    queue: [],
    turns: [
      {
        id: newId(),
        prompt: 'What is wisp and how do I use it?',
        startedAt: now - 94_000,
        endedAt: now,
        status: 'done',
        stats: { costUsd: 0, durationMs: 94_000, turns: 1 },
        activity: [
          { t: now - 90_000, kind: 'read', label: 'Reading server/protocol.js', file: 'server/protocol.js' },
          { t: now - 80_000, kind: 'search', label: 'Searching for “blocks”' },
          { t: now - 60_000, kind: 'edit', label: 'Editing web/js/app.js', file: 'web/js/app.js' },
          { t: now - 30_000, kind: 'run', label: 'Run the test suite', detail: 'npm test' },
        ],
        changes: [
          {
            file: 'src/session.ts',
            op: 'edit',
            edits: [
              {
                before: 'export async function run(agent, task) {\n  const log = await agent.exec(task);\n  return log; // 4,000 lines nobody reads\n}',
                after: 'export async function run(agent, task) {\n  const log = await agent.exec(task);\n  return present(log); // what changed, why, what\'s next\n}',
              },
            ],
          },
        ],
        presentation: {
          blocks: [
            {
              type: 'hero',
              title: 'Send agents off. Read the highlights.',
              summary: 'wisp launches coding agents in the background and hands you a short visual brief when they finish — not a transcript. Follow up right here.',
              status: 'info',
            },
            {
              type: 'flow',
              title: 'How a wisp travels',
              nodes: [
                { id: 'a', label: 'You launch', note: 'task + project' },
                { id: 'b', label: 'Agent works', note: 'Claude Code, headless' },
                { id: 'c', label: 'Presentation', note: 'blocks, not logs' },
                { id: 'd', label: 'You follow up', note: 'or mark done' },
              ],
              edges: [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'b', 'resumes']],
            },
            {
              type: 'stats',
              items: [
                { label: 'lines of transcript you skipped', value: 4182, tone: 'good' },
                { label: 'agents running at once', value: 6, unit: '×' },
                { label: 'block types', value: 20 },
              ],
            },
            {
              type: 'steps',
              title: 'Using it',
              items: [
                { title: 'Launch', detail: 'Press N, describe the task, pick the project folder. Launch several — they run in parallel.' },
                { title: 'Forget about it', detail: 'The queue on the left shows what each agent is doing in one line.' },
                { title: 'Review', detail: 'Finished work lands in “Needs you” with a dot. Open it to see the brief.' },
                { title: 'Follow up or close', detail: 'Reply to resume the same agent session, or press E to mark it done.' },
              ],
            },
            { type: 'diff', file: 'src/session.ts', caption: 'Real diffs come from the agent’s own edits — no copy-paste.' },
            {
              type: 'tests',
              command: 'npm test',
              passed: 128,
              failed: 1,
              skipped: 3,
              durationMs: 6400,
              failures: [{ name: 'session › resumes after restart', message: 'expected state "review", received "running"', file: 'test/session.test.ts:88' }],
            },
            {
              type: 'files',
              items: [
                { path: 'src/session.ts', change: 'modified', note: 'Returns a presentation instead of the raw log.' },
                { path: 'src/present/blocks.ts', change: 'added', note: 'Block schema + validation.' },
                { path: 'src/legacy/transcript.ts', change: 'deleted' },
              ],
            },
            {
              type: 'commits',
              branch: 'feat/presentations',
              items: [
                { hash: 'a1f9c03', message: 'feat(session): return presentations', files: 3, additions: 142, deletions: 37 },
                { hash: '7be21d4', message: 'test: cover resume after restart', files: 1, additions: 48, deletions: 0 },
              ],
            },
            {
              type: 'compare',
              before: { label: 'Without wisp', items: ['Babysit a terminal per agent', 'Scroll 40 screens to find what changed', 'Lose track of which tab finished'] },
              after: { label: 'With wisp', items: ['Fire and forget, many at once', 'One page: what, why, proof', 'A queue that tells you what needs you'] },
            },
            {
              type: 'chart',
              title: 'Time spent per finished task',
              unit: 'min',
              items: [
                { label: 'reading transcripts', value: 11 },
                { label: 'reading a wisp', value: 1.5 },
              ],
            },
            { type: 'terminal', command: 'npx wisp "add dark mode to the settings page"', output: '  ◌ wisp is floating at http://localhost:4477\n\n  launched: add dark mode to the settings page', exitCode: 0 },
            {
              type: 'checklist',
              title: 'Permission modes (pick per launch)',
              items: [
                { text: 'Plan — read-only, the agent proposes', done: true },
                { text: 'Edits — the agent may change files, no shell prompts', done: true },
                { text: 'Full auto — no permission prompts at all; the default, each task in its own worktree', done: true },
              ],
            },
            {
              type: 'code',
              language: 'json',
              caption: 'Agents answer with blocks like these — you can ask for any of them.',
              code: '{"type":"stats","items":[{"label":"tests","value":48,"delta":"+4","tone":"good"}]}',
            },
            {
              type: 'tree',
              title: 'Agents can sketch structure too',
              items: [
                { path: 'src/present/blocks.ts', change: 'added' },
                { path: 'src/present/render.ts', change: 'added', note: 'pure, no DOM' },
                { path: 'src/session.ts', change: 'modified' },
                { path: 'test/session.test.ts', change: 'modified' },
              ],
            },
            { type: 'callout', tone: 'info', title: 'Agents can ask you mid-run', text: 'When a decision matters, the agent pauses with a question. The session jumps to **Needs you**; your answer goes straight back to the still-running agent.' },
            { type: 'callout', tone: 'warn', title: 'Heads up', text: 'This tour is static. Launch a real wisp with **N** — or take any real session over in your terminal with **T**.' },
            {
              type: 'actions',
              title: 'One-click actions',
              items: [
                { label: 'Run test suite', command: 'npm test', detail: 'Executes in your project folder' },
                { label: 'Check git status', command: 'git status -sb' },
              ],
            },
            {
              type: 'question',
              question: 'Which agent harness should wisp support next?',
              options: [
                { label: 'Codex', reply: 'Codex next' },
                { label: 'opencode', reply: 'opencode next' },
              ],
            },
            { type: 'next', items: ['Summarize what changed on this branch', 'Find and fix the flakiest test', 'Write a README for this repo'] },
          ],
        },
      },
    ],
  };
}
