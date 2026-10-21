// Signing in to a wisp Grid (grid/) from here: the device flow (RFC 8628). wisp asks the grid for a
// code, you approve it in your browser (signed in to the grid with Google, GitHub, …), and the grid
// hands this computer a device token. Your cloud computer then shows up as a machine (kind: 'grid').
//
// The page can't call the grid itself (another origin), so the flow runs here and the page follows
// it through GET /api/cloud/signin/:id and the 'cloud' event.

import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { gridJson, gridUrl } from '../grid-client.js';
import { bad } from '../util.js';

const KEEP_MS = 10 * 60_000; // a finished sign-in stays readable this long

export function createCloud(app) {
  const flows = new Map(); // id -> flow

  const view = (f) => ({ id: f.id, grid: f.grid, state: f.state, userCode: f.userCode, verifyUrl: f.verifyUrl, expiresAt: f.expiresAt, error: f.error || '', machineId: f.machineId || null, user: f.user || null });
  const changed = (f) => app.broadcast('cloud', view(f));

  async function poll(f) {
    if (f.state !== 'waiting') return;
    if (Date.now() > f.expiresAt) return finish(f, 'expired', 'The code expired. Start again.');
    let r;
    try {
      r = await gridJson(`${f.grid}/api/device/token`, { method: 'POST', body: { device_code: f.deviceCode } });
    } catch (err) {
      f.timer = setTimeout(() => poll(f), f.interval * 1000); // a blip: keep going until it expires
      return;
    }
    const e = r.body.error;
    if (e === 'authorization_pending' || e === 'slow_down') {
      if (e === 'slow_down') f.interval += 5;
      f.timer = setTimeout(() => poll(f), f.interval * 1000);
      return;
    }
    if (e === 'access_denied') return finish(f, 'denied', 'Sign-in was declined in the browser.');
    if (e || r.status >= 400) return finish(f, 'failed', r.body.error_description || e || `The grid said ${r.status}.`);
    const { token, user, instance } = r.body;
    const m = app.machines.addGrid({ url: instance.url, grid: f.grid, handle: user.handle, name: instance.name || 'Cloud', token, user: { handle: user.handle, name: user.name || '', email: user.email || '' } });
    Object.assign(f, { machineId: m.id, user });
    finish(f, 'done');
    app.machines.connect(m.id).catch(() => {});
  }

  function finish(f, state, error = '') {
    clearTimeout(f.timer);
    Object.assign(f, { state, error, deviceCode: null });
    changed(f);
    setTimeout(() => flows.delete(f.id), KEEP_MS).unref?.();
  }

  return {
    async start(raw) {
      const grid = gridUrl(raw);
      let r;
      try {
        r = await gridJson(`${grid}/api/device/code`, { method: 'POST', body: { name: `${os.hostname().replace(/\.local$/, '')} (wisp)` } });
      } catch (err) {
        throw bad(`Couldn’t reach ${new URL(grid).host}: ${err.message}`, 400);
      }
      if (r.status >= 400 || !r.body.device_code) throw bad(r.body.error_description || r.body.error || `${new URL(grid).host} isn’t a wisp Grid (HTTP ${r.status}).`, 400);
      const b = r.body;
      const f = { id: randomBytes(6).toString('hex'), grid, state: 'waiting', deviceCode: b.device_code, userCode: b.user_code, verifyUrl: b.verification_uri_complete || b.verification_uri, interval: Math.max(1, Number(b.interval) || 5), expiresAt: Date.now() + (Number(b.expires_in) || 600) * 1000 };
      flows.set(f.id, f);
      f.timer = setTimeout(() => poll(f), f.interval * 1000);
      changed(f);
      return view(f);
    },
    get(id) {
      const f = flows.get(id);
      if (!f) throw bad('No such sign-in.', 404);
      return view(f);
    },
    cancel(id) {
      const f = flows.get(id);
      if (!f) throw bad('No such sign-in.', 404);
      if (f.state === 'waiting') finish(f, 'cancelled');
      return view(f);
    },
    stop() {
      for (const f of flows.values()) clearTimeout(f.timer);
    },
  };
}
