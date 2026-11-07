// Signing in to a wisp Grid from here (v1 services/cloud.js): the device flow (RFC 8628). wisp asks
// the grid for a code, you approve it in your browser (signed in to the grid with Google, GitHub, …),
// and the grid hands this computer a device token. Your cloud computer then shows up as a peer
// (transport 'grid'), its token in secrets.
//
// The page can't call the grid itself (another origin), so the flow runs here and the page follows it
// through grid-client.signin.get and the 'cloud' notice. A flow lives minutes and nobody resumes it, so
// it stays in memory, each one with a scope of its own for its timers.

import os from 'node:os';
import { randomBytes } from 'node:crypto';
import type { Json, Scope } from '@wisp/kernel';
import { COMMANDS as MACHINES } from '@wisp-plugin/machines-api';
import { NOTICES } from '@wisp-plugin/grid-client-api';
import type { SigninState, SigninView } from '@wisp-plugin/grid-client-api';
import { dataOf } from './deps.ts';
import type { Deps } from './deps.ts';
import type { Computer } from './computer.ts';
import { bad, gridJson, gridUrl, str, why } from './grid-http.ts';

const KEEP_MS = 10 * 60_000; // a finished sign-in stays readable this long

interface Flow {
  id: string;
  grid: string;
  addComputer: boolean;
  state: SigninState;
  deviceCode: string | null;
  userCode: string;
  verifyUrl: string;
  interval: number;
  expiresAt: number;
  error: string;
  machineId: string | null;
  user: Json;
  scope: Scope;
}

const view = (f: Flow): SigninView => ({ id: f.id, grid: f.grid, state: f.state, userCode: f.userCode, verifyUrl: f.verifyUrl, expiresAt: f.expiresAt, error: f.error, machineId: f.machineId, user: f.user });

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function createCloud(d: Deps, o: { scope: Scope; computer: () => Computer }) {
  const flows = new Map<string, Flow>();
  const now = (): number => d.ctx.clock.now();
  const changed = (f: Flow): void => d.notice(NOTICES.cloud, { ...view(f) });
  // how far sign-ins get: only whether it's the hosted grid, never a grid's address
  const track = (f: Flow): void => d.track('cloud_signin', { step: f.state === 'waiting' ? 'started' : f.state, hosted: new URL(f.grid).host === 'grid.trywisp.dev' });

  function finish(f: Flow, state: SigninState, error = ''): void {
    f.scope.dispose();
    Object.assign(f, { state, error, deviceCode: null });
    changed(f);
    track(f);
    o.scope.timeout(KEEP_MS, () => flows.delete(f.id));
  }

  const later = (f: Flow): void => f.scope.timeout(f.interval * 1000, () => void poll(f));

  /** A cloud computer, after signing in (v1 machines.addGrid): same address → the same peer. */
  async function addGrid(f: Flow, token: string, user: Record<string, unknown>, instance: Record<string, unknown>): Promise<string> {
    const u = new URL(str(instance['url']));
    const handle = str(user['handle']);
    const who = { handle, name: str(user['name']), email: str(user['email']), avatar: str(user['avatar']) };
    const data = { grid: f.grid, handle, user: who };
    const peers = d.peers();
    const have = peers.find((x) => x.transport === 'grid' && !dataOf(x).computer && !dataOf(x).sandbox && x.address === u.origin);
    if (have) return (await d.updatePeer({ id: have.id, data, token })).id;
    // a second account whose cloud computer has the same name (two 'wisp Cloud's): its handle tells them apart
    let label = str(instance['name']) || 'Cloud';
    if (handle && peers.some((x) => x.name === label.slice(0, 40))) label = `${label} (${handle})`;
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    return (await d.addPeer({ transport: 'grid', address: u.origin, port, name: label.slice(0, 40), data, token, connect: false })).id;
  }

  async function signedIn(f: Flow, body: Record<string, unknown>): Promise<void> {
    const user = obj(body['user']);
    const id = await addGrid(f, str(body['token']), user, obj(body['instance']));
    Object.assign(f, { machineId: id, user: { ...user } as Json });
    // signed in from Machines: this computer joins the grid as well; either way your other computers show up
    if (f.addComputer) await o.computer().enable(id).catch((err: unknown) => d.ctx.log.warn(`grid: ${why(err)}`));
    finish(f, 'done');
    d.ctx.run(MACHINES.connect, { id }).catch(() => {});
    o.computer().sync().catch(() => {});
  }

  async function poll(f: Flow): Promise<void> {
    if (f.state !== 'waiting') return;
    if (now() > f.expiresAt) return finish(f, 'expired', 'The code expired. Start again.');
    let r;
    try {
      r = await gridJson(`${f.grid}/api/device/token`, { method: 'POST', body: { device_code: f.deviceCode } });
    } catch {
      return later(f); // a blip: keep going until it expires
    }
    if (f.state !== 'waiting') return;
    const e = str(r.body['error']);
    if (e === 'authorization_pending' || e === 'slow_down') {
      if (e === 'slow_down') f.interval += 5;
      return later(f);
    }
    if (e === 'access_denied') return finish(f, 'denied', 'Sign-in was declined in the browser.');
    if (e || r.status >= 400) return finish(f, 'failed', str(r.body['error_description']) || e || `The grid said ${r.status}.`);
    try {
      await signedIn(f, r.body);
    } catch (err) {
      finish(f, 'failed', why(err));
    }
  }

  const find = (id: string): Flow => {
    const f = flows.get(id);
    if (!f) throw bad('No such sign-in.', 404);
    return f;
  };

  return {
    async start(raw: unknown, { addComputer = false } = {}): Promise<SigninView> {
      const grid = gridUrl(raw);
      let r;
      try {
        r = await gridJson(`${grid}/api/device/code`, { method: 'POST', body: { name: `${os.hostname().replace(/\.local$/, '')} (wisp)` } });
      } catch (err) {
        throw bad(`Couldn’t reach ${new URL(grid).host}: ${why(err)}`, 400);
      }
      const b = r.body;
      if (r.status >= 400 || !str(b['device_code'])) throw bad(str(b['error_description']) || str(b['error']) || `${new URL(grid).host} isn’t a wisp Grid (HTTP ${r.status}).`, 400);
      const id = randomBytes(6).toString('hex');
      const f: Flow = {
        id, grid, addComputer, state: 'waiting', deviceCode: str(b['device_code']), userCode: str(b['user_code']),
        verifyUrl: str(b['verification_uri_complete']) || str(b['verification_uri']), interval: Math.max(1, Number(b['interval']) || 5),
        expiresAt: now() + (Number(b['expires_in']) || 600) * 1000, error: '', machineId: null, user: null, scope: o.scope.child(`signin:${id}`),
      };
      flows.set(f.id, f);
      later(f);
      changed(f);
      track(f);
      return view(f);
    },
    get: (id: string): SigninView => view(find(id)),
    cancel(id: string): SigninView {
      const f = find(id);
      if (f.state === 'waiting') finish(f, 'cancelled');
      return view(f);
    },
  };
}
