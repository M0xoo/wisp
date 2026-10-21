// /api/cloud: sign in to a wisp Grid; your cloud computer then shows up under Machines.

export function register(r, app) {
  r.route('POST', '/cloud/signin', async (c) => c.send(201, await app.cloud.start((await c.body()).url)));
  r.route('GET', '/cloud/signin/:id', (c) => c.send(200, app.cloud.get(c.params.id)));
  r.route('DELETE', '/cloud/signin/:id', (c) => c.send(200, app.cloud.cancel(c.params.id)));
}
