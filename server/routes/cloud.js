// /api/cloud: sign in to a wisp Grid; your cloud computer then shows up under Machines.
// /api/computer: this computer on that grid, reached from your phone and other computers.

export function register(r, app) {
  r.route('POST', '/cloud/signin', async (c) => {
    const b = await c.body();
    c.send(201, await app.cloud.start(b.url, { addComputer: b.addComputer === true }));
  });
  r.route('GET', '/cloud/signin/:id', (c) => c.send(200, app.cloud.get(c.params.id)));
  r.route('DELETE', '/cloud/signin/:id', (c) => c.send(200, app.cloud.cancel(c.params.id)));
  r.route('GET', '/computer', (c) => {
    app.computer.fresh(); // Machines is open: your other computers, looked up again
    c.send(200, app.computer.view());
  });
  r.route('POST', '/computer', async (c) => c.send(200, (await c.body()).on === false ? await app.computer.disable() : await app.computer.enable()));
}
