// Ship it. GET: what would ship (branch, changes, draft message). POST { title, body, draft }:
// commit, push, open or update the PR. Then follow it (pr) and squash-merge it (merge).

import { ship, merge, worktreeStatus } from '../git.js';

export function register(r, app) {
  const { store, runner, telemetry } = app;
  const one = (fn) => (c) => {
    const s = store.get(c.params.id);
    if (!s) return c.send(404, { error: 'no such session' });
    return fn(c, s);
  };
  const NO_TREE = 'Ship it works on worktree sessions: launch with a worktree to get one.';

  r.route(
    'GET',
    '/sessions/:id/ship',
    one(async (c, s) => {
      if (!s.worktree) return c.send(400, { error: NO_TREE });
      app.ship.recheck(s);
      c.send(200, { branch: s.worktree.branch, base: s.worktree.base, remote: s.worktree.remote, ...(await worktreeStatus(s.worktree)), pr: s.pr || null, ...app.ship.draft(s) });
    }),
  );
  r.route(
    'POST',
    '/sessions/:id/ship',
    one(async (c, s) => {
      if (!s.worktree) return c.send(400, { error: NO_TREE });
      if (runner.live.has(s.id)) return c.send(409, { error: 'Still working: wait for it to finish, or stop it.' });
      if (s.shipping) return c.send(409, { error: 'Already shipping: wait for it to land.' });
      const body = await c.body();
      const draft = app.ship.draft(s);
      // The card follows along: s.shipping names the stage running now, sent with each summary.
      s.shipping = { step: 'start', update: s.pr?.state === 'OPEN', startedAt: Date.now() };
      app.sessionChanged(s);
      const onStep = (step) => ((s.shipping = { ...s.shipping, step }), app.sessionChanged(s));
      try {
        s.pr = await ship(s.worktree, { title: body.title ?? draft.title, body: body.body ?? draft.body, draft: !!body.draft, pr: s.pr, onStep });
      } finally {
        delete s.shipping;
        app.sessionChanged(s, { now: true });
      }
      telemetry.track('ship', { agent: s.agent, draft: !!body.draft });
      app.ship.recheck(s);
      c.send(200, s.pr);
    }),
  );
  r.route(
    'POST',
    '/sessions/:id/pr',
    one(async (c, s) => {
      if (!s.pr) return c.send(404, { error: 'No pull request yet.' });
      c.send(200, await app.ship.refreshPr(s));
    }),
  );
  // Send the task a follow-up to fix the PR's merge conflicts now: on demand, after the automatic
  // fix gave up, or with it off in Settings (see services/ship.js).
  r.route(
    'POST',
    '/sessions/:id/fix-conflicts',
    one(async (c, s) => {
      if (s.pr?.state !== 'OPEN' || !s.worktree) return c.send(400, { error: 'No open pull request.' });
      if (runner.live.has(s.id)) return c.send(409, { error: 'Still working: wait for it to finish, or stop it.' });
      await app.ship.refreshPr(s);
      if (s.conflictFix?.step !== 'fixing') await app.ship.fixConflicts(s, { force: true });
      if (s.conflictFix?.step !== 'fixing') return c.send(409, { error: s.pr.conflict ? 'It merges cleanly with the latest base here: GitHub may not have caught up yet.' : 'The PR has no merge conflicts now.' });
      c.send(200, { conflictFix: s.conflictFix });
    }),
  );
  // Squash-merge the reviewed head, sync the user's base branch, clean up the worktree.
  r.route(
    'POST',
    '/sessions/:id/merge',
    one(async (c, s) => {
      if (!s.pr || !s.worktree) return c.send(400, { error: 'No pull request to merge.' });
      const { pr, sync } = await merge(s.worktree, s.pr.number);
      s.pr = pr;
      app.launcher.markDone(s);
      telemetry.track('merge', { agent: s.agent });
      app.sessionChanged(s, { now: true });
      c.send(200, { pr, sync });
    }),
  );
}
