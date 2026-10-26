// Ship it: whether a worktree session has something to ship, the draft commit message and PR
// text, and following open PRs (checks, reviews, merges) so their cards stay current. A PR that
// conflicts with its base gets fixed when the user clicks Fix conflicts on its row (or on its own
// with defaults.fixConflicts: 'on'): the task is sent a follow-up to merge the base in, and the
// result is pushed to the PR when it's done.

import fs from 'node:fs';
import path from 'node:path';
import { worktreeStatus, prView, ship, merge, baseMerged, conflictsWithBase } from '../git.js';
import { blocksToMarkdown } from '../render.js';
import { summarize } from '../runner.js';
import { bad } from '../util.js';

const PR_POLL_MS = 60_000;
const PR_FAST_POLL_MS = 10_000; // while GitHub is still working something out: checks running, mergeability unknown, a push just landed
const PR_TICK_MS = 5_000;
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

// The repos a task ships: its own worktree, then those of its other folders (also). Each is
// { name, wt, at }, where `at` holds that repo's PR (the session for its own, else the also entry).
export function reposOf(s, store) {
  const name = (dir) => store?.projectFor?.(dir)?.name || path.basename(dir || '');
  return [s.worktree && { name: name(s.cwd), wt: s.worktree, at: s }, ...(s.also || []).map((a) => a.worktree && { name: name(a.cwd), wt: a.worktree, at: a })].filter(Boolean);
}
// Something new for this repo's PR: uncommitted changes, or commits its open PR (or a new one) lacks.
const pending = (st, pr) => !!(st.dirty || (pr?.state === 'OPEN' ? st.unpushed : st.ahead));
const hasTrees = (s) => !!(s?.worktree || s?.also?.some((a) => a.worktree));

export function createShip(app) {
  const { store, runner } = app;

  // Ship it shows only when the worktree has something to ship: uncommitted changes, or commits
  // not yet pushed. Rechecked whenever wisp might have changed the worktree. A task in several
  // repos adds theirs up, and `repos` counts the ones with something to ship.
  const check = async (s) => {
    if (!hasTrees(s) || s.parentId) return;
    app.overlaps?.touch(s); // other open tasks changing the same files
    const repos = reposOf(s, store);
    const all = await Promise.all(repos.map((r) => worktreeStatus(r.wt)));
    const sum = (k) => all.reduce((n, st) => n + st[k], 0);
    const next = { dirty: sum('dirty'), ahead: sum('ahead'), unpushed: sum('unpushed'), ...(repos.length > 1 && { repos: all.filter((st, i) => pending(st, repos[i].at.pr)).length }) };
    if (JSON.stringify(next) === JSON.stringify(s.toShip)) return;
    s.toShip = next;
    app.sessionChanged(s);
  };
  // One check at a time per session (one asked for meanwhile runs right after); `lazy` (a card
  // fetching its session) skips running sessions and runs at most every few seconds.
  const checks = new Map(); // id → true while checking, 'again' if another check is due
  const checkedAt = new Map();
  const recheck = (s, { lazy = false } = {}) => {
    if (!hasTrees(s) || s.parentId) return;
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

  // The PRs of the task's other repos: their state, checks and reviews, for the card.
  const refreshAlso = async (s) => {
    const open = (s.also || []).filter((a) => a.pr && a.worktree && a.pr.state === 'OPEN');
    if (!open.length) return false;
    let news = false;
    await Promise.all(
      open.map(async (a) => {
        const prev = a.pr;
        a.pr = await prView(fs.existsSync(a.worktree.path) ? a.worktree.path : a.worktree.root, prev.number).catch(() => ({ ...prev, checkedAt: Date.now() }));
        if (a.pr.state !== prev.state || a.pr.review !== prev.review || (!a.pr.checks.pending && prev.checks?.pending)) news = true;
      }),
    );
    if (news) (s.unread = true), delete s.forLater; // news on its PR: back out of For later
    app.sessionChanged(s);
    return true;
  };
  const refreshPr = async (s) => {
    await refreshAlso(s);
    if (!s.pr || !s.worktree) return s.pr || s.also?.find((a) => a.pr)?.pr;
    const prev = s.pr;
    const dir = fs.existsSync(s.worktree.path) ? s.worktree.path : s.worktree.root;
    const pr = await prView(dir, prev.number);
    const changed = (k) => JSON.stringify(k(pr)) !== JSON.stringify(k(prev));
    s.pr = pr;
    if (s.conflictFix && !pr.conflict && !['fixing', 'pushing'].includes(s.conflictFix.step)) delete s.conflictFix;
    if (pr.state !== prev.state) app.auto.signals(summarize(s, store));
    // Things worth coming back for: CI finished either way, a review landed, it merged or closed.
    const settledChecks = (x) => (x.checks.pending ? 'pending' : x.checks.fail ? 'fail' : 'pass');
    if (changed((x) => x.state) || changed((x) => x.review) || (changed(settledChecks) && settledChecks(pr) !== 'pending')) (s.unread = true), delete s.forLater;
    app.sessionChanged(s);
    await fixConflicts(s).catch(() => {});
    return pr;
  };

  // The PR conflicts with its base: send the task a follow-up to merge the base in. Only when the
  // user clicks Fix conflicts (force), unless defaults.fixConflicts is 'on': then on its own, once
  // per PR head, so a fix that didn't take isn't retried until something changes the branch.
  const starting = new Set(); // a poll and a refresh at once must not both send it
  const fixConflicts = async (s, { force = false } = {}) => {
    const pr = s.pr;
    if ((!force && store.config.defaults.fixConflicts !== 'on') || pr?.state !== 'OPEN' || !pr.conflict || !s.worktree?.remote) return;
    if (runner.live.has(s.id) || s.shipping || s.ask || s.archived || starting.has(s.id)) return;
    const tries = s.conflictFix?.tries || 0;
    if (!force && (s.conflictFix?.head === pr.head || tries >= MAX_CONFLICT_FIXES)) return;
    // The user saw the conflict and asked: no fetch first, the follow-up starts at once.
    if (!force) {
      starting.add(s.id);
      try {
        if ((await conflictsWithBase(s.worktree)) === false || runner.live.has(s.id)) return;
      } finally {
        starting.delete(s.id);
      }
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
      delete s.forLater;
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
      s.pushedAt = Date.now();
      fix.step = 'done';
    } catch (err) {
      Object.assign(fix, { step: 'failed', why: `Push failed: ${err.message}` });
      s.unread = true;
      delete s.forLater;
    } finally {
      delete s.shipping;
      app.sessionChanged(s, { now: true });
    }
    recheck(s);
  };

  // Ship it: commit, push and open (or update) the PR, in each of the task's repos with something
  // new. One repo ships as before, even with nothing new (git says why). Several: one PR each,
  // each noting the others; a failure names its repo and leaves the PRs already opened in place.
  const shipAll = async (s, { title, body = '', draft = false }) => {
    const repos = reposOf(s, store);
    let todo = repos;
    if (repos.length > 1) {
      const st = await Promise.all(repos.map((r) => worktreeStatus(r.wt)));
      todo = repos.filter((r, i) => pending(st[i], r.at.pr));
      if (!todo.length) throw bad('Nothing to ship: none of the task’s repos have new changes.');
    }
    const note = repos.length > 1 ? `\n\nPart of one task across ${repos.map((r) => `\`${r.name}\``).join(', ')}: wisp opens a pull request in each.` : '';
    s.shipping = { step: 'start', update: todo.every((r) => r.at.pr?.state === 'OPEN'), startedAt: Date.now(), ...(todo.length > 1 && { of: todo.length }) };
    app.sessionChanged(s);
    try {
      for (const [i, r] of todo.entries()) {
        const onStep = (step) => ((s.shipping = { ...s.shipping, step, ...(todo.length > 1 && { repo: r.name, at: i + 1 }) }), app.sessionChanged(s));
        try {
          r.at.pr = await ship(r.wt, { title, body: `${body}${note}`.trim(), draft, pr: r.at.pr, onStep });
        } catch (err) {
          throw repos.length > 1 ? Object.assign(new Error(`${r.name}: ${err.message}`), { status: err.status }) : err;
        }
      }
      s.pushedAt = Date.now(); // the PR is polled fast for a while, so its checks show up as they start
    } finally {
      delete s.shipping;
      app.sessionChanged(s, { now: true });
    }
    recheck(s);
    return { ...(s.pr || todo[0].at.pr), ...(repos.length > 1 && { prs: prsOf(s) }) };
  };
  // Every PR the task opened, its own first: { repo, number, url, state }.
  const prsOf = (s) => reposOf(s, store).filter((r) => r.at.pr).map((r) => ({ repo: r.name, number: r.at.pr.number, url: r.at.pr.url, state: r.at.pr.state }));

  // Merge: squash-merge each open PR of the task, its own first. Stops at the first that fails.
  const mergeAll = async (s) => {
    const open = reposOf(s, store).filter((r) => r.at.pr?.state === 'OPEN');
    if (!open.length) throw bad('No pull request to merge.');
    const synced = [];
    for (const r of open) {
      try {
        const { pr, sync } = await merge(r.wt, r.at.pr.number);
        r.at.pr = pr;
        synced.push(sync);
      } catch (err) {
        app.sessionChanged(s, { now: true });
        throw open.length > 1 ? Object.assign(new Error(`${r.name}: ${err.message}`), { status: err.status }) : err;
      }
    }
    app.overlaps?.touch(s); // merged: it no longer overlaps the others
    const sync = { ok: synced.every((x) => x.ok), text: synced.map((x) => x.text).join(' ') };
    return { pr: s.pr || open[0].at.pr, sync, ...(reposOf(s, store).length > 1 && { prs: prsOf(s) }) };
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
    const keep = blocks.filter((b) => !['hero', 'next', 'question', 'diff', 'code', 'image', 'video', 'preview', 'terminal', 'task'].includes(b?.type));
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
  for (const s of store.all()) if (hasTrees(s) && !s.archived && s.pr?.state !== 'MERGED') recheck(s);

  // Open PRs are checked every minute, and every few seconds while their state is still settling,
  // so a check finishing or a pushed fix clearing the conflict shows up quickly.
  const settling = (s) => {
    const pr = s.pr;
    return !!(pr.checks?.pending || pr.mergeState === 'UNKNOWN' || ['pushing', 'done'].includes(s.conflictFix?.step) || Date.now() - (s.pushedAt || 0) < 5 * 60_000);
  };
  let polling = false;
  const timer = setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      // A task's other repos' PRs ride along with its own (or poll on their own when it has none open).
      const lead = (s) => (s.pr?.state === 'OPEN' ? s.pr : s.also?.find((a) => a.pr?.state === 'OPEN')?.pr);
      const due = store.all().filter((s) => lead(s) && Date.now() - (lead(s).checkedAt || 0) >= (s.pr?.state === 'OPEN' && settling(s) ? PR_FAST_POLL_MS : PR_POLL_MS));
      await Promise.all(due.map((s) => refreshPr(s).catch(() => {})));
    } finally {
      polling = false;
    }
  }, PR_TICK_MS);
  timer.unref();

  return { recheck, refreshPr, fixConflicts, draft, shipAll, mergeAll, prsOf, stop: () => clearInterval(timer) };
}
