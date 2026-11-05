// Settings → Worktrees: what's on disk, and removing it by hand (services/worktrees.js).

export function register(r, app) {
  r.route('GET', '/worktrees', (c) => c.send(200, app.worktrees.view()));
  r.route('POST', '/worktrees/clean', async (c) => c.send(200, await app.worktrees.clean(await c.body())));
}
