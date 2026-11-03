// Review by another harness (defaults.review, off by default): when a task's own PR is open and
// its head is new, a harness other than the one that wrote it (or the one you picked) reads the
// diff against the base and lists what it would fix, and the project's tests run again on that
// head. The result sits on the task as `review` and shows on the PR row, in the PR panel and in
// Merge's confirmation; Merge stays possible either way. It runs on the reviewing harness's
// current account: wisp never switches accounts for it, and when that account is past
// Automations stop at, the review waits (held) instead.

import { execFileSync } from 'node:child_process';
import { askJson } from '../quick.js';
import { diffOf } from '../judge.js';
import { check as runCheck } from '../check.js';
import { gitBin } from '../git.js';

// What defaults.review may be: off, another harness than the author's, or one harness.
export const HARNESSES = ['claude', 'codex', 'antigravity', 'copilot', 'opencode', 'cursor', 'grok'];
export const REVIEW_VALUES = ['off', 'other', ...HARNESSES];
const MAX_DIFF = 60_000;
const MAX_FINDINGS = 20;
const REVIEW_MS = 6 * 60_000;
const SEVERITY = ['high', 'medium', 'low'];
const clip = (s, n) => {
  s = String(s ?? '').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

// Every harness that wrote part of the task: its turns', else the task's own.
export const authorsOf = (s) => [...new Set([...(s.turns || []).map((t) => t.agent), s.agent].filter((a) => a && a !== 'auto' && a !== 'wisp'))];

// { agent, model } to review with, or { why } when none can. Never picks an account: the harness
// runs on the one it's signed in with.
export function pickReviewer(setting, authors, agents) {
  const ready = (id) => agents.some((a) => a.id === id && a.available);
  if (!setting || setting === 'off') return { why: 'Review by another harness is off.' };
  if (setting === 'other') {
    const id = HARNESSES.find((h) => ready(h) && !authors.includes(h));
    return id ? { agent: id, model: '' } : { why: 'No other harness than the one that wrote it is installed here.' };
  }
  return ready(setting) ? { agent: setting, model: '' } : { why: `${agents.find((a) => a.id === setting)?.name || setting} isn't installed here.` };
}

export function reviewPrompt({ title, task, diff, tests }) {
  const t = tests && tests.verdict !== 'skip' ? `\n<tests command="${tests.command}" verdict="${tests.verdict}">${tests.verdict === 'pass' ? '' : `\n${String(tests.output || '').slice(-3000)}\n`}</tests>\n` : '';
  return `You review a pull request another coding agent wrote, before it's merged. Your working directory is its branch at the PR's head: open the files, read the code around the change, run read-only commands. Don't take the PR's word for anything you can check.

Look for what would make a careful reviewer ask for changes: bugs, missed cases, broken behaviour elsewhere, security problems, missing tests for what changed, and code that ignores the project's own rules (AGENTS.md, CONTRIBUTING, README). Skip style nits and anything the diff didn't touch. No findings is a fine answer.

<pr title="${String(title || '').replace(/"/g, "'").slice(0, 200)}">
${String(task || '').slice(0, 3000)}
</pr>
${t}
<diff>
${String(diff || '').slice(0, MAX_DIFF) || '(no changes)'}
</diff>

Reply with one JSON object: {"summary": "one sentence", "findings": [{"severity": "high" | "medium" | "low", "file": "path", "line": 12, "text": "what is wrong and what to do"}]}`;
}

// A reviewer's reply as { summary, findings }, or null when it said nothing usable.
export function readReview(j) {
  if (!j || typeof j !== 'object' || !Array.isArray(j.findings)) return null;
  const findings = j.findings
    .filter((f) => f && typeof f === 'object' && String(f.text || '').trim())
    .slice(0, MAX_FINDINGS)
    .map((f) => ({ severity: SEVERITY.includes(f.severity) ? f.severity : 'medium', ...(f.file && { file: clip(f.file, 200) }), ...(Number.isInteger(Number(f.line)) && Number(f.line) > 0 && { line: Number(f.line) }), text: clip(f.text, 600) }))
    .sort((a, b) => SEVERITY.indexOf(a.severity) - SEVERITY.indexOf(b.severity));
  return { summary: clip(j.summary || (findings.length ? `${findings.length} issue${findings.length > 1 ? 's' : ''} found.` : 'Nothing to fix.'), 300), findings };
}

// What the page sees (runner summarize): the last review, and whether it's of the PR's head.
export function reviewView(s) {
  const r = s.review;
  if (!r) return null;
  return { status: r.status, head: r.head, current: !!s.pr && r.head === s.pr.head, ...(r.by && { by: r.by }), ...(r.summary && { summary: r.summary }), findings: r.findings || [], ...(r.tests && { tests: r.tests }), ...(r.why && { why: r.why }), at: r.at };
}

const git = (dir, args) => {
  try {
    return execFileSync(gitBin(), args, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 }).toString().trim();
  } catch {
    return '';
  }
};

export function createReview(app) {
  const { store, runner } = app;
  const running = new Map(); // session id → the head being reviewed
  const setting = () => store.config.defaults.review || 'off';

  // Start a review of the task's PR head when one is due. force: Review again (or the first, by hand).
  // Returns why it didn't start, or '' when it did.
  const maybe = (s, { force = false } = {}) => {
    const pr = s?.pr;
    if (!s?.worktree || s.parentId || pr?.state !== 'OPEN' || !pr.head) return 'No open pull request of the task’s own branch.';
    if (!force && setting() === 'off') return 'Review by another harness is off.';
    if (running.get(s.id) === pr.head) return '';
    if (runner.live.has(s.id) || s.shipping) return 'Still working: it’s reviewed once the run ends.';
    if (!force && s.review?.head === pr.head && s.review.status !== 'running') return '';
    const pick = pickReviewer(setting() === 'off' ? 'other' : setting(), authorsOf(s), app.auto.here());
    if (!pick.agent) {
      s.review = { status: 'failed', head: pr.head, why: pick.why, findings: [], at: Date.now() };
      app.sessionChanged(s);
      return pick.why;
    }
    // The reviewer's own account, at Automations stop at: it waits (held), it never moves to another.
    const h = force ? null : app.reserve?.check?.(pick.agent);
    if (h) {
      s.review = { status: 'held', head: pr.head, by: pick, why: h.why, findings: [], at: Date.now() };
      app.sessionChanged(s);
      return h.why;
    }
    run(s, pr.head, pick).catch((err) => console.warn(`wisp: review: ${err.stack || err.message}`));
    return '';
  };

  const run = async (s, head, pick) => {
    running.set(s.id, head);
    s.review = { status: 'running', head, by: pick, findings: [], at: Date.now() };
    app.sessionChanged(s, { now: true });
    const live = () => running.get(s.id) === head && store.get(s.id) === s && s.pr?.head === head;
    const dir = s.worktree.path;
    try {
      // The PR's head, as pushed: a tree that moved on is reviewed once that's pushed.
      if (git(dir, ['rev-parse', 'HEAD']) !== head) throw Object.assign(new Error('The branch has commits the PR doesn’t have yet: push them (Ship it) to review.'), { quiet: true });
      const tests = await runCheck({ dir, project: store.projectFor?.(s.cwd), worktree: s.worktree }).catch(() => null);
      if (!live()) return;
      const base = git(dir, ['merge-base', 'HEAD', s.worktree.baseRef || 'HEAD']) || s.worktree.head || 'HEAD';
      const ask = reviewPrompt({ title: s.title, task: s.turns?.[0]?.prompt, diff: diffOf(dir, base), tests });
      const j = await askJson({ agents: app.auto.here(), prompt: ask, cwd: dir, timeoutMs: REVIEW_MS, pick }).catch(() => null);
      if (!live()) return;
      const r = readReview(j);
      const t = tests && tests.verdict !== 'skip' ? { verdict: tests.verdict, command: tests.command, passed: tests.passed || 0, failed: tests.failed || 0 } : null;
      s.review = r
        ? { status: 'done', head, by: pick, summary: r.summary, findings: r.findings, ...(t && { tests: t }), at: Date.now() }
        : { status: 'failed', head, by: pick, why: `${app.auto.here().find((a) => a.id === pick.agent)?.name || pick.agent} didn’t answer.`, findings: [], ...(t && { tests: t }), at: Date.now() };
      app.telemetry?.track?.('pr_review', { agent: s.agent, reviewer: pick.agent, status: s.review.status, findings: s.review.findings.length, tests: t?.verdict || 'skip' });
    } catch (err) {
      if (live()) s.review = { status: 'failed', head, by: pick, why: clip(err.message, 300), findings: [], at: Date.now() };
    } finally {
      if (running.get(s.id) === head) running.delete(s.id);
      if (store.get(s.id) === s) {
        if (s.review?.status === 'done' || s.review?.status === 'failed') (s.unread = true), delete s.forLater;
        app.sessionChanged(s, { now: true });
      }
    }
  };

  // A review cut short by a restart starts over on the next poll.
  for (const s of store.all()) if (s.review?.status === 'running') delete s.review;
  // A run that ends on a task with an open PR: its head may be new (the agent pushed).
  runner.on('ended', ({ session }) => {
    const s = store.get(session.id);
    if (s?.pr?.state === 'OPEN') setImmediate(() => maybe(s));
  });

  return { maybe, running: (id) => running.has(id) };
}
