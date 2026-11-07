// This Mac (design/machine.md): what agents cost this computer, stopping what a finished run left
// running, and Pause automations (server/machine.js). Not to be confused with routes/machines.js
// (other computers, over SSH). The page's routes, with no wisp tool behind them (no /internal or
// /control route): a capped task's harness keeps its shell off wisp's API (server/capped.js), so it
// can't stop a process or pause automations.

export function register(r, app) {
  r.route('GET', '/machine', async (c) => c.send(200, await app.machine.read()));
  r.route('POST', '/machine/stop', async (c) => c.send(200, await app.machine.stopPid((await c.body())?.pid)));
  r.route('POST', '/machine/fix', async (c) => c.send(200, await app.machine.fileFix((await c.body())?.group)));
  r.route('POST', '/machine/harness/clean', async (c) => c.send(200, await app.machine.cleanHarness((await c.body())?.ids)));
  r.route('POST', '/automations/pause', async (c) => c.send(200, app.machine.pause((await c.body())?.until)));
}
