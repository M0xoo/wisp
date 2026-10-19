// Ship it: whether a worktree session has something to ship, the draft commit message and PR
// text, and following open PRs (checks, reviews, merges) so their cards stay current. A PR that
// starts conflicting with its base gets fixed on its own: the task is sent a follow-up to merge the
// base in, and the result is pushed to the PR when it's done (defaults.fixConflicts: 'off' to stop).

import fs from 'node:fs';
import { worktreeStatus, prView, ship, baseMerged, conflictsWithBase } from '../git.js';
import { blocksToMarkdown } from '../render.js';
import { summarize } from '../runner.js';

const PR_POLL_MS = 60_000;
const SHIP_RECHECK_MS = 5_000;
const MAX_CONFLICT_FIXES = 3; // per task, so a base that keeps moving can't run up the bill

export const conflictPrompt = (s) => {
  const { remote, base } = s.worktree;
  return [
    `PR #${s.pr.number} (${s.pr.url}) can no longer merge into \`${base}\`: changes that landed there since conflict with this branch. Bring the branch up to date:`,
    '',
    `1. \`git fetch ${remote}\`, then \`git merge ${remote}/${base}\`. Don't rebase: the branch is already pushed.`,
    `2. Resolve every conflict, keeping the intent of both sides: what landed on \`${base}\` and what this task changed. Don't drop either side's changes to make a conflict go away.`,
    '3. Run the checks that are cheap here (tests, type-check, build) on the merged result and fix what the merge broke.',
    "4. Finish with `git commit --no-edit`. Don't push: wisp pushes to the PR when you're done.",
    '',
    'If a conflict needs a decision only the user can make, ask them.',
  ].join('\n');
};

export function createShip(app) {
  const { store, runner } = app;

  // Ship it shows only when the worktree has something to ship: uncommitted changes, or commits
  // not yet pushed. Rechecked whenever wisp might have changed the worktree.
  const check = async (s) => {
    if (!s?.worktree || s.parentId) return;
    const { dirty, ahead, unpushed } = await worktreeStatus(s.worktree);
    const next = { dirty, ahead, unpushed };
    if (JSON.stringify(next) === JSON.stringify(s.toShip)) return;
    s.toShip = next;
    app.sessionChanged(s);
  };
  // One check at a time per session (one asked for meanwhile runs right after); `lazy` (a card
  // fetching its session) skips running sessions and runs at most every few seconds.
  const checks = new Map(); // id → true while checking, 'again' if another check is due
  const checkedAt = new Map();
  const recheck = (s, { lazy = false } = {}) => {
    if (!s?.worktree || s.parentId) return;
    if (lazy && (runner.live.has(s.id) || checks.has(s.id) || Date.now() - (checkedAt.get(s.id) || 0) < SHIP_RECHECK_MS)) return;
    if (checks.has(s.id)) return void checks.set(s.id, 'again');
    checks.set(s.id, true);
    checkedAt.set(s.id, Date.now());
    check(s)
      .catch(() => {})
      .finally(() => {
        const again = checks.get(s.id) === 'again';
        checks.delete(s.id);
        if (again) recheck(s);
      });
  };

  const refreshPr = async (s) => {
    if (!s.pr || !s.worktree) return s.pr;
    const prev = s.pr;
    const dir = fs.existsSync(s.worktree.path) ? s.worktree.path : s.worktree.root;
    const pr = await prView(dir, prev.number);
    const changed = (k) => JSON.stringify(k(pr)) !== JSON.stringify(k(prev));
    s.pr = pr;
    if (s.conflictFix && !pr.conflict && !['fixing', 'pushing'].includes(s.conflictFix.step)) delete s.conflictFix;
    if (pr.state !== prev.state) app.auto.signals(summarize(s, store));
    // Things worth coming back for: CI finished either way, a review landed, it merged or closed.
    const settledChecks = (x) => (x.checks.pending ? 'pending' : x.checks.fail ? 'fail' : 'pass');
    if (changed((x) => x.state) || changed((x) => x.review) || (changed(settledChecks) && settledChecks(pr) !== 'pending')) s.unread = true;
    app.sessionChanged(s);
    await fixConflicts(s).catch(() => {});
    return pr;
  };

  // The PR conflicts with its base: send the task a follow-up to merge the base in. Once per PR
  // head, so a fix that didn't take isn't retried until something changes the branch. force: the
  // user asked for it (the PR row's Fix conflicts), so the setting and those limits don't apply.
  const starting = new Set(); // a poll and a refresh at once must not both send it
  const fixConflicts = async (s, { force = false } = {}) => {
    const pr = s.pr;
    if ((!force && store.config.defaults.fixConflicts === 'off') || pr?.state !== 'OPEN' || !pr.conflict || !s.worktree?.remote) return;
    if (runner.live.has(s.id) || s.shipping || s.ask || s.archived || starting.has(s.id)) return;
    const tries = s.conflictFix?.tries || 0;
    if (!force && (s.conflictFix?.head === pr.head || tries >= MAX_CONFLICT_FIXES)) return;
    starting.add(s.id);
    try {
      if ((await conflictsWithBase(s.worktree)) === false || runner.live.has(s.id)) return;
    } finally {
      starting.delete(s.id);
    }
    s.conflictFix = { step: 'fixing', head: pr.head, tries: tries + 1, startedAt: Date.now() };
    await app.launcher.replyTo(s, conflictPrompt(s), [], true);
    app.telemetry?.track?.('conflict_fix', { agent: s.agent });
    app.sessionChanged(s, { now: true });
  };

  // The fix-up turn ended: push it to the PR if the base really is merged in, else leave the task
  // for the user with why.
  const finishFix = async (s, { interrupted, errorText }) => {
    const fix = s.conflictFix;
    if (fix?.step !== 'fixing') return;
    const fail = (why) => {
      Object.assign(fix, { step: 'failed', why });
      s.unread = true;
      app.sessionChanged(s, { now: true });
    };
    if (interrupted || s.queue?.length) return fail('Stopped: the task moved on before the conflicts were fixed.');
    if (errorText) return fail(`The agent run failed: ${errorText}`.slice(0, 300));
    const check = await baseMerged(s.worktree).catch((err) => ({ ok: false, why: err.message }));
    if (!check.ok) return fail(check.why);
    fix.step = 'pushing';
    s.shipping = { step: 'start', update: true, startedAt: Date.now() };
    app.sessionChanged(s);
    const onStep = (step) => ((s.shipping = { ...s.shipping, step }), app.sessionChanged(s));
    try {
      s.pr = await ship(s.worktree, { title: `Merge ${s.worktree.remote}/${s.worktree.base} into ${s.worktree.branch}`, pr: s.pr, onStep });
      fix.step = 'done';
    } catch (err) {
      Object.assign(fix, { step: 'failed', why: `Push failed: ${err.message}` });
      s.unread = true;
    } finally {
      delete s.shipping;
      app.sessionChanged(s, { now: true });
    }
    recheck(s);
  };

  // Default commit message and PR text, from the session's latest presentation.
  const draft = (s) => {
    const turn = s.turns.findLast((t) => t.status === 'done') || s.turns.at(-1);
    const blocks = turn?.presentation?.blocks || [];
    const hero = blocks.find((b) => b?.type === 'hero');
    const text = `${hero?.title || s.title}`.trim();
    const conventional = /^[a-z]+(\([\w./-]+\))?!?: /.test(text);
    const type = /\b(fix|bug|broken|crash|flaky|regression)/i.test(`${text} ${s.turns[0]?.prompt || ''}`) ? 'fix' : /\b(docs?|readme|changelog)\b/i.test(text) ? 'docs' : /\b(refactor|clean ?up|simplif)/i.test(text) ? 'refactor' : /\btests?\b/i.test(text) ? 'test' : 'feat';
    const title = conventional ? text : `${type}: ${text.charAt(0).toLowerCase()}${text.slice(1)}`;
    const keep = blocks.filter((b) => !['hero', 'next', 'question', 'diff', 'code', 'image', 'terminal'].includes(b?.type));
    const body = [hero?.summary, blocksToMarkdown(keep, turn)].filter(Boolean).join('\n\n').trim();
    return { title: title.slice(0, 100), body: `${body}\n\n_Shipped from [wisp](https://github.com/M0xoo/wisp)._`.trim() };
  };

  runner.on('ended', ({ session, interrupted, errorText }) => {
    const s = store.get(session.id);
    recheck(s);
    if (s?.conflictFix?.step === 'fixing') finishFix(s, { interrupted, errorText }).catch(() => {});
  });
  for (const s of store.all()) {
    delete s.shipping; // a ship cut short by a restart isn't running anymore
    if (s.conflictFix?.step === 'pushing') Object.assign(s.conflictFix, { step: 'failed', why: 'wisp restarted while pushing the fix.' });
  }
  for (const s of store.all()) if (s.worktree && !s.archived && s.pr?.state !== 'MERGED') recheck(s);

  const timer = setInterval(async () => {
    for (const s of store.all()) if (s.pr?.state === 'OPEN') await refreshPr(s).catch(() => {});
  }, PR_POLL_MS);
  timer.unref();

  return { recheck, refreshPr, fixConflicts, draft, stop: () => clearInterval(timer) };
}
