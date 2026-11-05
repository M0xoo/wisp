// /api/cloud: sign in to a wisp Grid; your cloud computer then shows up under Machines.
// /api/computer: this computer on that grid, reached from your phone and other computers.
// /api/sandbox: /sandbox's boxes on that grid, and the Claude sign-in they all start with.
// /api/cloud/keys: API keys for scripting a cloud wisp, kept on that grid, for a desktop signed in to it.

export function register(r, app) {
  // send() takes no headers, so no-store goes on the response first: refusals carry it too.
  const keys = (fn) => async (c) => {
    c.res.setHeader('cache-control', 'no-store');
    app.apiKeys.guard(c.req);
    await fn(c);
  };
  r.route('POST', '/cloud/signin', async (c) => {
    const b = await c.body();
    c.send(201, await app.cloud.start(b.url, { addComputer: b.addComputer === true }));
  });
  r.route('GET', '/cloud/signin/:id', (c) => c.send(200, app.cloud.get(c.params.id)));
  r.route('DELETE', '/cloud/signin/:id', (c) => c.send(200, app.cloud.cancel(c.params.id)));
  r.route('GET', '/cloud/keys', keys(async (c) => c.send(200, await app.apiKeys.list())));
  r.route('POST', '/cloud/keys', keys(async (c) => c.send(201, await app.apiKeys.create((await c.body()).name))));
  r.route('DELETE', '/cloud/keys/:id', keys(async (c) => c.send(200, await app.apiKeys.revoke(c.params.id))));
  r.route('GET', '/computer', (c) => {
    app.computer.fresh(); // Machines is open: your other computers, looked up again
    c.send(200, app.computer.view());
  });
  // { on }: on the grid or off it; { previews }: show this computer's local pages through it.
  r.route('POST', '/computer', async (c) => {
    const b = await c.body();
    if (typeof b.previews === 'boolean') return c.send(200, app.computer.previews(b.previews));
    c.send(200, b.on === false ? await app.computer.disable() : await app.computer.enable(typeof b.account === 'string' ? b.account : ''));
  });
  r.route('GET', '/sandbox', async (c) => c.send(200, await app.sandbox.view()));
  // Env vars every sandbox starts with, kept sealed on the grid (names back, never values).
  r.route('PUT', '/sandbox/env', async (c) => {
    const b = await c.body();
    c.send(200, await app.sandbox.setEnv(b.key, b.value));
  });
  r.route('DELETE', '/sandbox/env/:key', async (c) => c.send(200, await app.sandbox.dropEnv(c.params.key)));
  // Sign in to Claude for every sandbox: `claude setup-token` here, its token sent to the grid.
  r.route('POST', '/sandbox/login', (c) => c.send(200, app.sandbox.startLogin()));
  r.route('POST', '/sandbox/login/input', async (c) => c.send(200, app.sandbox.input((await c.body()).code)));
  r.route('DELETE', '/sandbox/login', (c) => c.send(200, app.sandbox.cancel()));
  r.route('DELETE', '/sandbox/logins/:agent', async (c) => c.send(200, await app.sandbox.logout(c.params.agent)));
  // A sandboxed task's browser: a one-time link to its live view (noVNC through the grid).
  r.route('POST', '/sandbox/browser', async (c) => {
    const b = await c.body();
    c.send(200, await app.sandbox.browser(b.task, { width: b.width, height: b.height }));
  });
  // In a sandbox: its screen and browser up, for the live view and the Browser connector.
  r.route('POST', '/sandbox/desktop', async (c) => c.send(200, await app.sandbox.desktop(await c.body())));
  // In a sandbox: the project sent along with a /sandbox task, as a repo in ~/code.
  r.route('POST', '/sandbox/seed', async (c) => c.send(200, await app.sandbox.seed(await c.body())));
  // A sandbox nothing here owns (made from another device, or left behind): deleted from the list.
  // Last: /sandbox/login and the rest come first.
  r.route('DELETE', '/sandbox/:id', async (c) => c.send(200, await app.sandbox.remove(c.params.id)));
}
