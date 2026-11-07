// The inbox's delivery (inbox.ts): what's held for a box goes to it in order, one at a time, waking
// it when it sleeps and retrying with backoff when it fails. And the one request that carries a
// channel's message to a box (boxDelivery), with the only x-wisp-proxy-via: inbox there is.

import http from 'node:http';
import type { GridConfig } from './config.ts';
import type { Db } from './db.ts';
import { messageOf } from './errors.ts';
import type { ChannelInboxRow, UserRow } from './rows.ts';
import type { Secrets } from './secrets.ts';
import { viaHeader } from './trust.ts';

const MAX_TRIES = 5;
const ANSWER_MAX = 16 * 1024; // a box's answer to a channel's live request: 25 autocomplete choices fit

export interface InboxOpts {
  enabled: boolean;
  maxRows: number;
  maxBytes: number;
  ttlMs: number;
  retryMs: number;
  wakeRetryMs: number;
  wakeStrikes: number;
  wakeGapMs: number;
  sweepMs: number;
  liveMs?: number;
  deliverMs?: number;
}

/** What of hostd the inbox uses (hostd.ts has it all). */
export interface InboxHostd {
  state(userId: string): string;
  port(userId: string): number | null;
  ensure(user: { id: string; handle: string }, opts?: { wake?: boolean }): Promise<unknown>;
  begin(userId: string, opts?: { touch?: boolean }): () => void;
}

export interface InboxAccounts {
  audit(userId: string | null, action: string, meta?: Record<string, unknown>): void;
  userById(id: unknown): UserRow | undefined;
}

export interface DeliverPayload {
  channel: string;
  headers: Record<string, string>;
  /** base64 */
  body: string;
  at: number;
  dropped?: number;
  verified?: true;
}
export interface Delivered {
  status: number;
  body: Record<string, unknown>;
}
export type Deliver = (port: number, user: UserRow, payload: DeliverPayload, opts?: { timeout?: number }) => Promise<Delivered>;

/**
 * POST /api/channels/inbound on a box: over the same trust path as the edge's proxy, with a mark of
 * its own (x-wisp-proxy-via: inbox) that the edge drops from anything coming in from outside. The box
 * reads that mark as "a channel's message: not use of the box". → the box's own short answer, which
 * only a sender's live check goes back with.
 */
export function boxDelivery({ cfg, secrets }: { cfg: GridConfig; secrets: Pick<Secrets, 'ensure'> }): Deliver {
  return (port, user, payload, { timeout = cfg.channels?.deliverMs || 30_000 } = {}) =>
    new Promise((resolve, reject) => {
      const data = JSON.stringify(payload);
      const headers = {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
        'x-wisp-proxy-secret': secrets.ensure(user.id, 'wisp-proxy'),
        ...viaHeader('inbox', 'delivery'),
        'x-forwarded-host': new URL(cfg.instanceUrl(user.handle)).host,
        'x-forwarded-proto': cfg.scheme,
      };
      const up = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/channels/inbound', timeout, headers }, (r) => {
        const chunks: Buffer[] = [];
        let size = 0;
        r.on('data', (c: Buffer) => {
          size += c.length;
          if (size <= ANSWER_MAX) chunks.push(c);
        });
        r.on('end', () => {
          let body: Record<string, unknown> = {};
          try {
            const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (typeof v === 'object' && v !== null) body = v as Record<string, unknown>;
          } catch {
            // not JSON: an empty answer
          }
          resolve({ status: r.statusCode ?? 0, body });
        });
        r.on('error', reject);
      });
      up.on('timeout', () => up.destroy(new Error('timeout')));
      up.on('error', reject);
      up.end(data);
    });
}

interface DrainDeps {
  db: Db;
  opts: InboxOpts;
  on: boolean;
  accounts: InboxAccounts;
  hostd: InboxHostd;
  deliver: Deliver;
  delivered: (row: ChannelInboxRow) => void;
  lost: (userId: string, channel: string, size: number, why: string) => void;
  log: (m: string) => void;
}

export function createDrain({ db, opts, on, accounts, hostd, deliver, delivered, lost, log }: DrainDeps) {
  const busy = new Map<string, Promise<void>>(); // user id -> the drain running
  const timers = new Map<string, NodeJS.Timeout>(); // user id -> the next try
  const wakes = new Map<string, { strikes: number; at: number }>(); // wakes since a message the box accepted, the last one's time
  const sending = new Map<string, Promise<void>>(); // user id -> the delivery on its way to the box
  let stopped = false;

  const finish = (id: number): void => void db.run("UPDATE channel_inbox SET done_at = ?, body = x'', headers = '{}' WHERE id = ?", Date.now(), id);
  const later = (user: UserRow, ms: number): void => {
    clearTimeout(timers.get(user.id));
    const t = setTimeout(() => {
      timers.delete(user.id);
      void drain(user);
    }, ms);
    t.unref();
    timers.set(user.id, t);
  };

  function failed(row: ChannelInboxRow, user: UserRow): void {
    const tries = row.tries + 1;
    if (tries >= MAX_TRIES) {
      finish(row.id);
      lost(row.user_id, row.channel, row.size, 'tries');
      later(user, 0); // what's behind it was waiting its turn
      return;
    }
    const next = opts.retryMs * 2 ** (tries - 1);
    db.run('UPDATE channel_inbox SET tries = ?, next_at = ? WHERE id = ?', tries, Date.now() + next, row.id);
    later(user, next);
  }

  // Asleep: wake it (earned, see inbox.ts). → true to look again, false to stop for now.
  async function wake(user: UserRow): Promise<boolean> {
    const w = wakes.get(user.id) || { strikes: 0, at: 0 };
    const cold = w.strikes >= opts.wakeStrikes;
    const wait = cold ? w.at + opts.wakeGapMs - Date.now() : 0;
    if (wait > 0) {
      later(user, wait);
      return false;
    }
    try {
      await hostd.ensure(user, { wake: cold });
    } catch (err) {
      // Full, or it wouldn't start: not the message's fault. It stays held until its hour is up.
      if (!stopped) log(`grid: inbox can't wake ${user.handle} yet: ${messageOf(err)}`);
      if (!stopped) later(user, opts.wakeRetryMs);
      return false;
    }
    wakes.set(user.id, { strikes: w.strikes + 1, at: Date.now() });
    return true;
  }

  // One row to the box that's up. → its HTTP status, 0 when it didn't answer.
  async function send(row: ChannelInboxRow, user: UserRow, port: number, dropped: number): Promise<number> {
    const done = hostd.begin(user.id, { touch: false }); // not stopped under it, and it isn't use
    let status = 0;
    let landed = (): void => {};
    sending.set(user.id, new Promise<void>((r) => (landed = r)));
    try {
      const headers = JSON.parse(row.headers) as Record<string, string>;
      ({ status } = await deliver(port, user, { channel: row.channel, headers, body: Buffer.from(row.body).toString('base64'), at: row.at, dropped, ...(row.verified ? { verified: true as const } : {}) }));
    } catch {
      // didn't answer: status 0, retried
    }
    done();
    try {
      if (status >= 200 && status < 300) delivered(row);
    } catch (err) {
      log(`grid: inbox after ${row.channel}: ${messageOf(err)}`);
    }
    sending.delete(user.id);
    landed();
    return status;
  }

  // → true for the next row, false to stop here.
  async function step(user: UserRow, fresh: UserRow): Promise<boolean> {
    const row = db.get<ChannelInboxRow>('SELECT * FROM channel_inbox WHERE user_id = ? AND done_at IS NULL ORDER BY id LIMIT 1', user.id);
    if (!row) return false;
    const wait = row.next_at - Date.now();
    if (wait > 0) return later(user, wait), false; // strictly in order: nothing passes a row being retried
    if (hostd.state(user.id) !== 'running') return wake(fresh);
    const port = hostd.port(user.id);
    if (!port) return later(user, opts.retryMs), false;
    const dropped = db.get<{ dropped: number }>('SELECT dropped FROM channel_urls WHERE user_id = ? AND channel = ?', user.id, row.channel)?.dropped || 0;
    const status = await send(row, fresh, port, dropped);
    if (stopped) return false;
    const ok = status >= 200 && status < 300;
    if (ok) wakes.delete(user.id);
    if (ok && dropped) db.run('UPDATE channel_urls SET dropped = max(0, dropped - ?) WHERE user_id = ? AND channel = ?', dropped, user.id, row.channel);
    // 4xx: the box read it and said no (a bad signature, a stranger, the channel switched off). Retrying can't help.
    if (ok || (status >= 400 && status < 500)) {
      finish(row.id);
      if (!ok) log(`grid: inbox ${row.channel}, ${row.size} bytes refused by the box (${status})`);
      return true;
    }
    failed(row, user);
    return false;
  }

  async function run(user: UserRow): Promise<void> {
    const fresh = accounts.userById(user.id);
    if (!fresh || fresh.disabled) return;
    while (!stopped && (await step(user, fresh)));
  }

  function drain(user: UserRow): Promise<void> {
    if (!on || stopped) return Promise.resolve();
    const running = busy.get(user.id);
    if (running) return running;
    const p = run(user)
      .catch((err: unknown) => log(`grid: inbox for ${user.handle}: ${messageOf(err)}`))
      .finally(() => busy.delete(user.id));
    busy.set(user.id, p);
    return p;
  }

  return {
    drain,
    delivering: (userId: string): Promise<void> | undefined => sending.get(userId),
    stop(): void {
      stopped = true;
      for (const t of timers.values()) clearTimeout(t);
    },
    settled: (): Promise<void[]> => Promise.all(busy.values()),
  };
}
