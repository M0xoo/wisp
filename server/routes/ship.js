// Ship it. GET: what would ship (branch, changes, draft message). POST { title, body, draft }:
// commit, push, open or update the PR. Then follow it (pr) and squash-merge it (merge). A task in
// several repos (also) ships, follows and merges a PR in each (services/ship.js).

import { worktreeStatus } from '../git.js';
import { reposOf } from '../services/ship.js';

export function register(r, app) {
  const { store, runner, telemetry } = app;
  const one = (fn) => (c) => {
    const s = store.get(c.params.id);
    if (!s) return c.send(404, { error: 'no such session' });
    return fn(c, s);
  };
  const NO_TREE = 'Ship it works on worktree sessions: launch with a worktree to get one.';
  const hasTrees = (s) => !!(s.worktree || s.also?.some((a) => a.worktree));

  r.route(
    'GET',
    '/sessions/:id/ship',
    one(async (c, s) => {
      if (!hasTrees(s)) return c.send(400, { error: NO_TREE });
      app.ship.recheck(s);
      const repos = await Promise.all(reposOf(s, store).map(async (r) => ({ repo: r.name, branch: r.wt.branch, base: r.wt.base, remote: r.wt.remote, ...(await worktreeStatus(r.wt)), pr: r.at.pr || null })));
      // The first repo's fields at the top level (as before one task could span repos), each in `repos`.
      const sum = (k) => repos.reduce((n, r) => n + r[k], 0);
      c.send(200, { ...repos[0], ...(repos.length > 1 && { dirty: sum('dirty'), ahead: sum('ahead'), repos }), ...app.ship.draft(s) });
    }),
  );
  r.route(
    'POST',
    '/sessions/:id/ship',
    one(async (c, s) => {
      if (!hasTrees(s)) return c.send(400, { error: NO_TREE });
      if (runner.working(s)) return c.send(409, { error: 'Still working: wait for it to finish, or stop it.' });
      if (s.shipping) return c.send(409, { error: 'Already shipping: wait for it to land.' });
      const body = await c.body();
      const draft = app.ship.draft(s);
      // The card follows along: s.shipping names the stage (and repo) running now, sent with each summary.
      const pr = await app.ship.shipAll(s, { title: body.title ?? draft.title, body: body.body ?? draft.body, draft: !!body.draft });
      telemetry.track('ship', { agent: s.agent, draft: !!body.draft, ...(pr.prs && { repos: pr.prs.length }) });
      c.send(200, pr);
    }),
  );
  r.route(
    'POST',
    '/sessions/:id/pr',
    one(async (c, s) => {
      if (!s.pr && !s.also?.some((a) => a.pr) && !s.prs?.length) return c.send(404, { error: 'No pull request yet.' });
      c.send(200, await app.ship.refreshPr(s));
    }),
  );
  // Fix conflicts on the PR row: send the task a follow-up to merge the base in now (see
  // services/ship.js). Trusts the conflict wisp last saw, so it starts at once; asks GitHub only if it saw none.
  r.route(
    'POST',
    '/sessions/:id/fix-conflicts',
    one(async (c, s) => {
      if (s.pr?.state !== 'OPEN' || !s.worktree) return c.send(400, { error: 'No open pull request.' });
      if (runner.working(s)) return c.send(409, { error: 'Still working: wait for it to finish, or stop it.' });
      if (!s.pr.conflict) await app.ship.refreshPr(s);
      if (s.conflictFix?.step !== 'fixing') await app.ship.fixConflicts(s, { force: true });
      if (s.conflictFix?.step !== 'fixing') {
        const why = !s.pr.conflict ? 'The PR has no merge conflicts now.' : !s.worktree.remote ? 'This repo has no origin remote to push to.' : s.ask ? 'The task is waiting for your answer first.' : s.shipping ? 'Already shipping: wait for it to land.' : 'Could not start the fix: try again in a moment.';
        return c.send(409, { error: why });
      }
      c.send(200, { conflictFix: s.conflictFix });
    }),
  );
  // Squash-merge the reviewed head, sync the user's base branch, clean up the worktree.
  r.route(
    'POST',
    '/sessions/:id/merge',
    one(async (c, s) => {
      if (!app.ship.prsOf(s).length) return c.send(400, { error: 'No pull request to merge.' });
      const out = await app.ship.mergeAll(s);
      app.launcher.markDone(s);
      telemetry.track('merge', { agent: s.agent });
      app.sessionChanged(s, { now: true });
      c.send(200, out);
    }),
  );
}
