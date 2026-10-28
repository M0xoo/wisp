// This computer on your wisp Grid (Machines → Reach this computer from anywhere). Signed in to a
// grid (services/cloud.js), wisp here adds itself as one of your computers there and holds a
// tunnel open to it (server/grid-tunnel.js): your phone and your other computers then open it at
// <name>--<handle>.<grid>, signed in with the same account. No SSH, no Tailscale, no open port.
//
// The other way: your other computers on that grid show up here under Machines (kind 'grid' with
// `computer`: its id there), looked up again now and then, offline until their tunnel is up.

import os from 'node:os';
import { gridJson } from '../grid-client.js';
import { dialTunnel } from '../grid-tunnel.js';
import { bad } from '../util.js';

const SYNC_MS = 5 * 60_000;
const FRESH_MS = 15_000; // a list this new is good enough when Machines opens

export const computerName = () => os.hostname().replace(/\.(local|lan|home)$/i, '').slice(0, 40) || 'Computer';

export function createComputer(app) {
  const { store, machines, secrets } = app;
  let tunnel = null;
  let live = { state: 'off', error: '' };
  let syncing = null;
  let syncedAt = 0;
  let timer = null;

  const conf = () => store.config.computer || null;
  // Each sign-in on a grid (its cloud computer and device token) is an account: several grids,
  // and several accounts on one grid, each with its own computers.
  const accounts = () => machines.list.filter((m) => m.kind === 'grid' && !m.computer);
  // The account this computer is on the grid with (its cloud computer's id, or older configs: the
  // first on that grid). None added yet: the one asked for, else the first.
  const account = (c = conf(), id = '') => {
    const list = accounts();
    if (c) return list.find((m) => m.id === c.account) || (!c.account && list.find((m) => m.grid === c.grid)) || null;
    return list.find((m) => m.id === id) || (!id && list[0]) || null;
  };
  const sameAccount = (m, a) => m.grid === a.grid && m.handle === a.handle;
  const tokenOf = (m) => (m ? secrets.get('machines', m.id) : null);

  // Where pages on this computer show through the grid ("https://p{port}--<name>--<handle>.<grid>"),
  // while Show local pages in previews is on; '' otherwise (server/http/preview.js).
  function previewUrl() {
    const c = conf();
    if (!c?.previews || !c.url) return '';
    const u = new URL(c.url);
    return `${u.protocol}//p{port}--${u.host}`;
  }

  function view() {
    const c = conf();
    const a = account(c);
    const who = (m) => ({ id: m.id, grid: m.grid, handle: m.user?.handle || m.handle });
    return { on: !!c, state: c ? live.state : 'off', error: live.error, name: c?.name || computerName(), url: c?.url || '', previews: !!c?.previews, previewUrl: previewUrl(), grid: c?.grid || a?.grid || '', account: a ? who(a) : null, accounts: accounts().map(who), cloud: !!app.publicUrl };
  }
  const changed = () => app.broadcast('computer', view());

  function dial() {
    tunnel?.close();
    tunnel = null;
    const c = conf();
    const token = tokenOf(account(c));
    if (!c || !token) return;
    tunnel = dialTunnel({
      url: c.grid,
      id: c.id,
      token,
      port: app.port,
      previews: () => !!conf()?.previews,
      onState: ({ state, error }) => {
        if (state === 'gone') {
          // Removed on the grid (from another device, or the account page): off here too.
          tunnel = null;
          delete store.config.computer;
          store.saveConfig();
          live = { state: 'off', error: error || 'Removed from the grid.' };
        } else live = { state, error: state === 'online' ? '' : error };
        changed();
      },
    });
  }

  // A request to the grid as account a (a cloud computer: its grid and device token).
  async function call(a, method, p, body) {
    const token = tokenOf(a);
    if (!token) throw bad('Sign in to a wisp Grid first: Machines → Reach this computer from anywhere.', 409);
    let r;
    try {
      r = await gridJson(`${a.grid}${p}`, { method, token, body });
    } catch (err) {
      throw bad(`Couldn’t reach ${new URL(a.grid).host}: ${err.message}`, 502);
    }
    if (r.status === 401) throw bad('The grid signed this computer out. Sign in again.', 401);
    if (r.status >= 400) throw bad(r.body.error || `The grid said ${r.status}.`, r.status);
    return r.body;
  }

  // Your other computers on each grid account you're signed in to, as machines here.
  function sync() {
    if (syncing) return syncing;
    syncing = (async () => {
      for (const a of accounts()) {
        let list;
        try {
          list = (await call(a, 'GET', '/api/computers')).computers || [];
        } catch {
          continue; // offline, or signed out: keep what's there
        }
        const c = conf();
        const mine = c && account(c) === a ? c.id : null;
        const others = list.filter((x) => !x.mine && x.id !== mine);
        for (const x of others) {
          const { m, added } = machines.addComputer({ url: x.url, grid: a.grid, handle: a.handle, name: x.name, token: tokenOf(a), user: a.user, computer: x.id });
          if (added) machines.follow(m.id);
        }
        const keep = new Set(others.map((x) => x.id));
        // Only this account's: another account on the same grid has computers of its own.
        for (const m of machines.list.filter((m) => m.computer && sameAccount(m, a) && !keep.has(m.computer))) machines.remove(m.id);
      }
      syncedAt = Date.now();
    })().finally(() => (syncing = null));
    return syncing;
  }

  return {
    view,
    sync,
    previewUrl,
    // Show local pages in previews: on or off, read by the tunnel on each request.
    previews(on) {
      const c = conf();
      if (!c) throw bad('Add this computer to the grid first.', 409);
      if (on) c.previews = true;
      else delete c.previews;
      store.saveConfig();
      changed();
      app.telemetry?.track?.('grid_computer', { step: on ? 'previews_on' : 'previews_off' });
      return view();
    },
    // Machines opened: a fresh list, unless one just came.
    fresh() {
      if (Date.now() - syncedAt > FRESH_MS) sync().catch(() => {});
    },
    // On the grid with one account (id: its cloud computer; the one it's on, else the first).
    async enable(id = '') {
      if (app.publicUrl) throw bad('This is a cloud computer: it’s on its grid already.', 400);
      const was = conf();
      if (was && id && account(was)?.id !== id) await this.disable(); // moving to another account
      const a = account(conf(), id);
      if (!a) throw bad(id ? 'No such grid account here. Settings → Cloud lists them.' : 'Sign in to a wisp Grid first.', id ? 404 : 409);
      const c = await call(a, 'POST', '/api/computers', { name: computerName() });
      store.config.computer = { grid: a.grid, account: a.id, id: c.id, url: c.url, name: c.name };
      store.saveConfig();
      live = { state: 'connecting', error: '' };
      dial();
      changed();
      app.telemetry?.track?.('grid_computer', { step: 'on', hosted: new URL(a.grid).host === 'grid.trywisp.dev' });
      return view();
    },
    // Off: the tunnel closes and the grid forgets it (best effort: it may be offline itself).
    async disable() {
      const c = conf();
      tunnel?.close();
      tunnel = null;
      delete store.config.computer;
      store.saveConfig();
      live = { state: 'off', error: '' };
      changed();
      const a = c && account(c);
      if (a) {
        await call(a, 'DELETE', `/api/computers/${c.id}`).catch(() => {});
        app.telemetry?.track?.('grid_computer', { step: 'off' });
      }
      return view();
    },
    // A machine is about to go (DELETE /machines/:id). A computer: taken off the grid too. Your
    // sign-in (the cloud computer): this computer leaves that grid, and so do the others' cards.
    async removing(m) {
      if (m.kind !== 'grid') return;
      if (m.computer) {
        const a = accounts().find((x) => sameAccount(m, x));
        return void (a && (await call(a, 'DELETE', `/api/computers/${m.computer}`).catch(() => {})));
      }
      if (conf() && account(conf()) === m) await this.disable();
      for (const x of machines.list.filter((x) => x.computer && sameAccount(x, m))) machines.remove(x.id);
    },
    start() {
      if (conf()) {
        live = { state: 'connecting', error: '' };
        dial();
      }
      setTimeout(() => sync().catch(() => {}), 2_000).unref?.();
      timer = setInterval(() => sync().catch(() => {}), SYNC_MS);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      tunnel?.close();
      tunnel = null;
    },
  };
}
