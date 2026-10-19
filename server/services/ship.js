// Ship it: whether a worktree session has something to ship, the draft commit message and PR
// text, and following open PRs (checks, reviews, merges) so their cards stay current.

import fs from 'node:fs';
import { worktreeStatus, prView } from '../git.js';
import { blocksToMarkdown } from '../render.js';
import { summarize } from '../runner.js';

const PR_POLL_MS = 60_000;
const SHIP_RECHECK_MS = 5_000;

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
    if (pr.state !== prev.state) app.auto.signals(summarize(s, store));
    // Things worth coming back for: CI finished either way, a review landed, it merged or closed.
    const settledChecks = (x) => (x.checks.pending ? 'pending' : x.checks.fail ? 'fail' : 'pass');
    if (changed((x) => x.state) || changed((x) => x.review) || (changed(settledChecks) && settledChecks(pr) !== 'pending')) s.unread = true;
    app.sessionChanged(s);
    return pr;
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

  runner.on('ended', ({ session }) => recheck(store.get(session.id)));
  for (const s of store.all()) delete s.shipping; // a ship cut short by a restart isn't running anymore
  for (const s of store.all()) if (s.worktree && !s.archived && s.pr?.state !== 'MERGED') recheck(s);

  const timer = setInterval(async () => {
    for (const s of store.all()) if (s.pr?.state === 'OPEN') await refreshPr(s).catch(() => {});
  }, PR_POLL_MS);
  timer.unref();

  return { recheck, refreshPr, draft, stop: () => clearInterval(timer) };
}
