// What every part of the edge works with: the grid's parts, made once by startGrid (grid.ts), and
// the small views and checks the handlers share. No handler keeps state of its own; it lives here.

import { timingSafeEqual } from 'node:crypto';
import type { Accounts, DeviceOf } from '../accounts.ts';
import type { createProviders } from '../auth/providers.ts';
import type { GridConfig } from '../config.ts';
import type { Db } from '../db.ts';
import { bad } from '../errors.ts';
import type { Hostd } from '../hostd.ts';
import { cookie, type limiter, type Res } from '../http.ts';
import type { createInbox } from '../inbox.ts';
import type { createMail } from '../mail.ts';
import type { createRoutes } from '../route.ts';
import type { ApiKeyView } from '../accounts.ts';
import type { ComputerRow, ShareRow, UserRow } from '../rows.ts';
import type { createSandboxes } from '../sandboxes.ts';
import type { Secrets } from '../secrets.ts';
import type { createShares } from '../shares.ts';
import type { createSites } from '../sites.ts';
import type { createGridTelemetry } from '../telemetry.ts';
import type { createTunnels } from '../tunnels.ts';

export type Inbox = ReturnType<typeof createInbox>;
export type Mail = ReturnType<typeof createMail>;
export type Routes = ReturnType<typeof createRoutes>;
export type Sites = ReturnType<typeof createSites>;
export type Shares = ReturnType<typeof createShares>;
export type Sandboxes = ReturnType<typeof createSandboxes>;
export type Tunnels = ReturnType<typeof createTunnels>;
export type Stats = ReturnType<typeof createGridTelemetry>;
export type Providers = ReturnType<typeof createProviders>;
export type Log = (m: string) => void;

export interface Parts {
  cfg: GridConfig;
  db: Db;
  accounts: Accounts;
  secrets: Secrets;
  hostd: Hostd;
  inbox: Inbox;
  mail: Mail | null;
  routes: Routes;
  sites: Sites;
  shares: Shares;
  sandboxes: Sandboxes;
  tunnels: Tunnels;
  stats: Stats;
  providers: Providers;
  limit: ReturnType<typeof limiter>;
  log: Log;
  /** Account pages open in a browser, each with an event stream (GET /events). */
  watchers: Map<string, Set<Res>>;
  /** pages in boxes: p<port>--<handle> (hostd.previews; on by default for containers) */
  previews: boolean;
  /** device-code polling, seconds */
  interval: number;
  /** where wisp's page look (index.html, css/, js/, logos/) is read from, for a shared task's page */
  webRoot: URL;
}

export interface CookieNames {
  grid: string;
  wisp: string;
  oauth: string;
}

export type Ctx = Parts & ReturnType<typeof views>;

const SIGN_IN_AGAIN = 'Sign in again: this device isn’t known here (removed, or a typo in the token).';
export { SIGN_IN_AGAIN };

export function views(p: Parts) {
  const { cfg, accounts, secrets, hostd, tunnels, watchers } = p;
  const names: CookieNames = { grid: cfg.secure ? '__Host-grid' : 'grid', wisp: cfg.secure ? '__Host-wisp' : 'wisp_grid', oauth: cfg.secure ? '__Host-grid_oauth' : 'grid_oauth' };
  // Previews show in frames of other sites (wisp on a computer): framed where browsers allow it.
  const framable = cfg.secure || cfg.domain === 'localhost' || cfg.domain.endsWith('.localhost');
  const instanceView = (u: UserRow) => {
    const row = accounts.instance(u.id);
    return { url: cfg.instanceUrl(u.handle), name: cfg.name, state: hostd.state(u.id), startedAt: row.started_at || null, stoppedAt: row.stopped_at || null, nextWakeAt: row.next_wake_at || null };
  };
  return {
    names,
    // When something on an account page changed (a computer came online, the cloud wisp woke), it fetches again.
    notify(userId: string): void {
      for (const res of watchers.get(userId) || []) res.write('event: change\ndata: {}\n\n');
    },
    setCookie: (name: string, value: string, maxAge: number): string => cookie(name, value, { secure: cfg.secure, maxAge }),
    previewCookie: (name: string, value: string, maxAge: number): string => cookie(name, value, { secure: cfg.secure, maxAge, framed: framable }),
    csrfFor: (s: { hash: string }): string => secrets.sign(`csrf|${s.hash}`),
    previewUrl: (label: string, port: number | string): string => cfg.instanceUrl(`p${port}--${label}`),
    // identities: how they sign in (GitHub, Google…), so the phone app can say which account each one is.
    userView: (u: UserRow) => ({
      id: u.id,
      handle: u.handle,
      name: u.name || '',
      email: u.email || '',
      avatar: u.avatar || '',
      identities: accounts.identities(u.id).map(({ provider, email, login }) => ({ provider, email: email || '', login: login || '' })),
    }),
    instanceView,
    // dev: the device asking, so a computer can tell itself apart in the list.
    computerView: (c: ComputerRow, dev: DeviceOf | null = null) => ({
      id: c.id,
      name: c.name,
      url: cfg.instanceUrl(c.label),
      online: tunnels.online(c.id),
      lastSeenAt: tunnels.online(c.id) ? Date.now() : c.last_seen_at || null,
      mine: !!dev && c.device_id === dev.device.id,
    }),
    keyView: (k: ApiKeyView) => ({ id: k.id, name: k.name, hint: k.hint, createdAt: k.created_at, lastUsedAt: k.last_used_at ?? null }),
    // The cloud wisp asking for itself: "Box <handle> <its trusted-proxy secret>" (hostd gave it both).
    boxUser(auth: unknown): UserRow | null {
      const m = /^Box\s+([a-z0-9-]+)\s+(\S+)$/.exec(String(auth || ''));
      const u = m?.[1] ? accounts.byHandle(m[1]) : undefined;
      if (!m?.[2] || !u || u.disabled) return null;
      const want = Buffer.from(secrets.ensure(u.id, 'wisp-proxy'));
      const got = Buffer.from(m[2]);
      return got.length === want.length && timingSafeEqual(got, want) ? u : null;
    },
    // A user's computer, or a 404.
    ownComputer(userId: string, id: unknown): ComputerRow {
      const c = accounts.computer(id);
      if (!c || c.user_id !== userId) throw bad('No such computer.', 404);
      return c;
    },
    shareCard: (row: ShareRow) => p.shares.card(row, accounts.userById(row.user_id)),
  };
}
