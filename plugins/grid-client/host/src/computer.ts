// This computer on your wisp Grid (v1 services/computer.js; Machines → Reach this computer from
// anywhere). Signed in to a grid (cloud.ts), wisp here adds itself as one of your computers there and
// holds a tunnel open to it (tunnel.ts): your phone and your other computers then open it at
// <name>--<handle>.<grid>, signed in with the same account. No SSH, no Tailscale, no open port.
//
// The other way: your other computers on that grid show up here as `grid-tunnel` peers, looked up
// again now and then, followed (asleep) until their tunnel is up.
//
// Its place on the grid is one row (schema.ts), on the plugin's computer topic: the page watches it.

import os from 'node:os';
import type { Json, Scope } from '@wisp/kernel';
import { COMMANDS as MACHINES } from '@wisp-plugin/machines-api';
import type { PeerRow } from '@wisp-plugin/machines-api';
import type { AccountRef, ComputerView, TunnelState } from '@wisp-plugin/grid-client-api';
import { EVENTS } from '@wisp-plugin/grid-client-api';
import { accounts, dataOf, sameAccount } from './deps.ts';
import type { Deps } from './deps.ts';
import { bad, gridJson, str, why } from './grid-http.ts';
import type { ComputerRow, Tables } from './schema.ts';
import { dialTunnel } from './tunnel.ts';

const SYNC_MS = 5 * 60_000;
const FRESH_MS = 15_000; // a list this new is good enough when Machines opens

export const computerName = (): string => os.hostname().replace(/\.(local|lan|home)$/i, '').slice(0, 40) || 'Computer';

export interface ComputerOptions {
  tables: Tables;
  scope: Scope;
  /** wisp's port here: the tunnel hands its streams to it */
  port(): number;
  /** this wisp is a cloud computer itself (its public address), or '' */
  publicUrl: string;
  /** a sandbox peer about to go: off the grid too (sandbox.ts) */
  sandboxRemoving(p: PeerRow): Promise<void>;
}

export type Computer = ReturnType<typeof createComputer>;

export function createComputer(d: Deps, o: ComputerOptions) {
  let tunnel: { close(): void } | null = null;
  let syncing: Promise<void> | null = null;
  let syncedAt = 0;

  const conf = (): ComputerRow | null => o.tables.computer();
  const write = (row: ComputerRow | null): void => {
    o.tables.setComputer(row);
    d.ctx.emit(EVENTS.computer, { on: !!row?.on, state: row?.state ?? 'off' });
  };
  const live = (state: TunnelState, error = ''): void => {
    const c = conf();
    if (c) write({ ...c, state, error });
  };
  /** the account this computer is on the grid with, else (none yet) the one asked for, else the first */
  const account = (c: ComputerRow | null = conf(), id = ''): PeerRow | null => {
    const list = accounts(d.peers());
    if (c?.on) return list.find((m) => m.id === c.account) ?? (!c.account ? list.find((m) => dataOf(m).grid === c.grid) : undefined) ?? null;
    return list.find((m) => m.id === id) ?? (!id ? list[0] : undefined) ?? null;
  };

  /** pages here through the grid ('https://p{port}--<name>--<handle>.<grid>') while previews are on */
  function previewUrl(): string {
    const c = conf();
    if (!c?.on || !c.previews || !c.url) return '';
    const u = new URL(c.url);
    return `${u.protocol}//p{port}--${u.host}`;
  }

  function view(): ComputerView {
    const c = conf();
    const on = !!c?.on;
    const a = account(c);
    const who = (m: PeerRow): AccountRef => {
      const g = dataOf(m);
      const user = g.user && typeof g.user === 'object' && !Array.isArray(g.user) ? str(g.user['handle']) : '';
      return { id: m.id, grid: g.grid, handle: user || g.handle };
    };
    return {
      on,
      state: on ? (c?.state ?? 'connecting') : 'off',
      error: c?.error ?? '',
      name: (on && c?.name) || computerName(),
      url: on ? (c?.url ?? '') : '',
      previews: on && !!c?.previews,
      previewUrl: previewUrl(),
      grid: (on ? c?.grid : '') || (a ? dataOf(a).grid : ''),
      account: a ? who(a) : null,
      accounts: accounts(d.peers()).map(who),
      cloud: !!o.publicUrl,
    };
  }

  async function dial(): Promise<void> {
    tunnel?.close();
    tunnel = null;
    const c = conf();
    const a = account(c);
    const token = a ? await d.token(a.id) : undefined;
    if (!c?.on || !token) return;
    tunnel = dialTunnel({
      url: c.grid,
      id: c.computer,
      token,
      port: o.port(),
      scope: o.scope,
      previews: () => !!conf()?.previews,
      onState: ({ state, error }) => {
        // removed on the grid (from another device, or the account page): off here too
        if (state === 'gone') {
          tunnel = null;
          write({ ...(conf() ?? c), on: false, state: 'off', error: error || 'Removed from the grid.' });
        } else live(state, state === 'online' ? '' : error);
      },
    });
  }

  /** A request to the grid as account a (a cloud computer: its grid and device token). */
  async function call(a: PeerRow | null, method: string, p: string, body?: unknown): Promise<Record<string, unknown>> {
    const token = a ? await d.token(a.id) : undefined;
    if (!a || !token) throw bad('Sign in to a wisp Grid first: Machines → Reach this computer from anywhere.', 409);
    const grid = dataOf(a).grid;
    let r;
    try {
      r = await gridJson(`${grid}${p}`, { method, token, body });
    } catch (err) {
      throw bad(`Couldn’t reach ${new URL(grid).host}: ${why(err)}`, 502);
    }
    if (r.status === 401) throw bad('The grid signed this computer out. Sign in again.', 401);
    if (r.status >= 400) throw bad(str(r.body['error']) || `The grid said ${r.status}.`, r.status);
    return r.body;
  }

  /** Another of your computers on a grid, as a peer here (v1 machines.addComputer). */
  async function addComputer(a: PeerRow, x: { id: string; url: string; name: string }, token: string): Promise<void> {
    const g = dataOf(a);
    const u = new URL(x.url);
    const data = { grid: g.grid, handle: g.handle, user: g.user, computer: x.id };
    const have = d.peers().find((m) => m.transport === 'grid-tunnel' && dataOf(m).computer === x.id && dataOf(m).grid === g.grid);
    // a peer's address never changes in place (its token goes there): a moved computer is added again
    if (have && have.address === u.origin) {
      if ((await d.token(have.id)) !== token || dataOf(have).handle !== g.handle) await d.updatePeer({ id: have.id, token, data });
      return;
    }
    if (have) await d.removePeer(have.id);
    const m = await d.addPeer({ transport: 'grid-tunnel', address: u.origin, port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80), name: String(x.name || u.hostname).slice(0, 40), data, token, connect: false });
    await d.ctx.run(MACHINES.follow, { id: m.id });
  }

  async function syncAccount(a: PeerRow): Promise<void> {
    let list: unknown;
    try {
      list = (await call(a, 'GET', '/api/computers'))['computers'];
    } catch {
      return; // offline, or signed out: keep what's there
    }
    const token = (await d.token(a.id)) ?? '';
    const c = conf();
    const mine = c?.on && account(c)?.id === a.id ? c.computer : null;
    const others = (Array.isArray(list) ? list : []).filter((x): x is Record<string, Json> => !!x && typeof x === 'object' && x['mine'] !== true && x['id'] !== mine);
    for (const x of others) await addComputer(a, { id: str(x['id']), url: str(x['url']), name: str(x['name']) }, token);
    const keep = new Set(others.map((x) => str(x['id'])));
    // only this account's: another account on the same grid has computers of its own
    for (const m of d.peers().filter((m) => m.transport === 'grid-tunnel' && sameAccount(m, a) && !keep.has(dataOf(m).computer ?? ''))) await d.removePeer(m.id);
  }

  /** Your other computers on each grid account you're signed in to, as peers here. */
  function sync(): Promise<void> {
    if (syncing) return syncing;
    syncing = (async () => {
      for (const a of accounts(d.peers())) await syncAccount(a);
      syncedAt = d.ctx.clock.now();
    })().finally(() => (syncing = null));
    return syncing;
  }

  async function disable(): Promise<ComputerView> {
    const c = conf();
    tunnel?.close();
    tunnel = null;
    const a = c?.on ? account(c) : null;
    write(null);
    if (a && c) {
      await call(a, 'DELETE', `/api/computers/${c.computer}`).catch(() => {});
      d.track('grid_computer', { step: 'off' });
    }
    return view();
  }

  async function enable(id = ''): Promise<ComputerView> {
    if (o.publicUrl) throw bad('This is a cloud computer: it’s on its grid already.', 400);
    const was = conf();
    if (was?.on && id && account(was)?.id !== id) await disable(); // moving to another account
    const a = account(conf(), id);
    if (!a) throw bad(id ? 'No such grid account here. Settings → Cloud lists them.' : 'Sign in to a wisp Grid first.', id ? 404 : 409);
    const c = await call(a, 'POST', '/api/computers', { name: computerName() });
    const g = dataOf(a).grid;
    write({ id: 'this', on: true, grid: g, account: a.id, computer: str(c['id']), url: str(c['url']), name: str(c['name']), previews: false, state: 'connecting', error: '' });
    await dial();
    d.track('grid_computer', { step: 'on', hosted: new URL(g).host === 'grid.trywisp.dev' });
    return view();
  }

  function previews(on: boolean): ComputerView {
    const c = conf();
    if (!c?.on) throw bad('Add this computer to the grid first.', 409);
    write({ ...c, previews: on });
    d.track('grid_computer', { step: on ? 'previews_on' : 'previews_off' });
    return view();
  }

  /**
   * A peer is about to go (machines.remove). A computer: taken off the grid too. Your sign-in (the
   * cloud computer): this computer leaves that grid, and its computers and sandboxes go with it, each
   * sandbox removed on the grid first while the token still works.
   */
  async function removing(m: PeerRow, all: readonly PeerRow[]): Promise<{ also?: string[] }> {
    const g = dataOf(m);
    if (g.sandbox) return void (await o.sandboxRemoving(m)), {};
    if (g.computer) {
      const a = accounts(all).find((x) => sameAccount(m, x)) ?? null;
      if (a) await call(a, 'DELETE', `/api/computers/${g.computer}`).catch(() => {});
      return {};
    }
    const c = conf();
    if (c?.on && account(c)?.id === m.id) await disable();
    const also: string[] = [];
    for (const x of all.filter((x) => x.id !== m.id && sameAccount(x, m))) {
      if (dataOf(x).computer) also.push(x.id);
      else if (dataOf(x).sandbox) {
        await o.sandboxRemoving(x);
        also.push(x.id);
      }
    }
    return { also };
  }

  return {
    view,
    sync,
    previewUrl,
    enable,
    disable,
    previews,
    removing,
    onGrid: () => !!conf()?.on,
    /** a report on a message the grid routed here: thread is all this computer holds of that chat */
    reply: (thread: Json, text: string) => call(account(), 'POST', '/api/channels/reply', { thread, text }),
    /** Machines opened: a fresh list, unless one just came */
    fresh(): void {
      if (d.ctx.clock.now() - syncedAt > FRESH_MS) sync().catch(() => {});
    },
    start(): void {
      if (conf()?.on) {
        live('connecting');
        void dial();
      }
      o.scope.timeout(2_000, () => void sync().catch(() => {}));
      o.scope.interval(SYNC_MS, () => void sync().catch(() => {}));
      o.scope.add(() => {
        tunnel?.close();
        tunnel = null;
      });
    },
  };
}
