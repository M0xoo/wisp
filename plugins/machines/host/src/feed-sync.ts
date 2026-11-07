// The v2 feed: a SyncClient per peer, its cursor per (peer, epoch) saved across reconnects and
// restarts, so a box that wakes after a night (or this laptop after sleep) sends only what changed.
// The subscription is passive: it never wakes a box or keeps it up (plan §7.2.3).

import type { ClientMessage, ServerMessage } from '@wisp/protocol';
import { SyncClient, type ClientOutput, type SyncClientSaved } from '@wisp/sync';
import { PeerHttpError } from '@wisp-plugin/machines-api';
import { errText, readEvents, settle, type Feed, type FeedDeps, type FeedEnd, type FeedStats } from './feed.ts';
import { LIST } from './mirror.ts';

export interface SyncFeedOptions extends FeedDeps {
  clientId: string;
  build: string;
  saved?: SyncClientSaved;
  /** the saved state changed (a new cursor): the manager persists it, coalesced */
  onSaved(s: SyncClientSaved): void;
}

export interface SyncFeed extends Feed {
  /** a command for this peer, by its idempotency key: resolves with its result, rejects on reject */
  mutate(mid: string, cmd: string, args: unknown): Promise<unknown>;
  save(): SyncClientSaved;
}

const isMessages = (v: unknown): v is ServerMessage[] => Array.isArray(v) && v.every((m) => typeof m === 'object' && m !== null && typeof (m as { t?: unknown }).t === 'string');

const STATUS_OF: Record<string, number> = { not_found: 404, forbidden: 403, conflict: 409, vetoed: 409, unavailable: 503 };

export function startSyncFeed(o: SyncFeedOptions): SyncFeed {
  const client = new SyncClient({ peer: o.peer, clientId: o.clientId, build: o.build, ...(o.saved !== undefined && { saved: o.saved }) });
  const stats: FeedStats = { bytes: 0, frames: 0, rows: 0 };
  const end = settle<FeedEnd>();
  const answers = new Map<string, { resolve(v: unknown): void; reject(e: Error): void }>();
  const outbox: ClientMessage[] = [];
  let posting = false;
  let stream: { cancel(): void } | null = null;
  let lastCursor = client.cursor;

  const finish = (e: FeedEnd): void => {
    if (end.settled()) return;
    stream?.cancel();
    for (const a of answers.values()) a.reject(new PeerHttpError('The connection to that computer dropped before it answered.', 503));
    answers.clear();
    end.resolve(e);
  };

  const carry = (outs: readonly ClientOutput[]): void => {
    for (const out of outs) {
      if (end.settled()) return;
      handleOutput(out);
    }
    if (client.cursor !== lastCursor) {
      lastCursor = client.cursor;
      o.onSaved(client.save());
    }
  };

  function handleOutput(out: ClientOutput): void {
    switch (out.kind) {
      case 'request':
        void open(out.params);
        return;
      case 'send':
        outbox.push(out.message);
        void flush();
        return;
      case 'reset':
        o.mirror.reset(o.peer);
        return;
      case 'snapshot':
        stats.rows += out.rows.length;
        o.mirror.snapshot(o.peer, out.topic, out.rows);
        return;
      case 'entityOps':
        stats.rows += out.ops.length;
        for (const topic of o.mirror.apply(o.peer, out.ops)) carry(client.handle({ kind: 'drifted', topic }, o.now()));
        return;
      case 'ack':
        answers.get(out.mid)?.resolve(out.result);
        answers.delete(out.mid);
        return;
      case 'reject':
        answers.get(out.mid)?.reject(Object.assign(new PeerHttpError(out.message, STATUS_OF[out.code] ?? 400), { code: out.code }));
        answers.delete(out.mid);
        return;
      case 'state':
        if (out.state === 'incompatible') finish({ reason: 'incompatible', update: out.update ?? 'peer' });
        return;
      case 'retry':
        finish({ reason: 'lost', error: 'The event stream from that computer ended.' }); // the manager decides when to come back
        return;
      case 'denied':
        o.log(`sync: ${out.topic} refused (${out.code})`);
        return;
      default:
        return; // notices, rows and resubscribes: nothing here shows them
    }
  }

  async function open(params: Record<string, string>): Promise<void> {
    try {
      const res = await o.channel.request({ method: 'GET', path: `/events?${new URLSearchParams(params)}`, headers: { accept: 'text/event-stream' }, passive: true, timeoutMs: 60_000 });
      if (res.status !== 200) {
        res.cancel();
        return finish({ reason: 'lost', error: `The event stream answered ${res.status}.` });
      }
      stream = res;
      await readEvents(res, stats, (event, data, id) => onEvent(event, data, id));
      if (!end.settled()) carry(client.handle({ kind: 'lost' }, o.now()));
    } catch (err) {
      if (!end.settled()) {
        carry(client.handle({ kind: 'lost' }, o.now()));
        finish({ reason: 'lost', error: errText(err) });
      }
    }
  }

  function onEvent(event: string, data: string, id: string | undefined): boolean {
    if (event !== 'sync') {
      // a v1 wisp: its stream starts with `event: hello` and summaries, never a welcome
      if (stats.frames === 0 && event !== 'message') finish({ reason: 'v1' });
      return !end.settled();
    }
    let messages: unknown;
    try {
      messages = JSON.parse(data);
    } catch {
      return true;
    }
    if (!isMessages(messages)) return true;
    stats.frames++;
    const seq = id === undefined || id === '' ? null : Number(id);
    carry(client.handle({ kind: 'frame', id: seq !== null && Number.isFinite(seq) ? seq : null, messages }, o.now()));
    return !end.settled();
  }

  async function flush(): Promise<void> {
    if (posting || outbox.length === 0) return;
    posting = true;
    const batch = outbox.splice(0, outbox.length);
    try {
      // only a command counts as use of the box; a passive sub never wakes it
      const passive = batch.every((m) => m.t !== 'mutate');
      const res = await o.channel.request({ method: 'POST', path: '/events', headers: { 'content-type': 'application/json', 'x-wisp-client': o.clientId }, body: JSON.stringify(batch), passive, timeoutMs: 30_000 });
      await res.text();
      if (res.status >= 400) o.log(`sync: POST /events answered ${res.status}`);
    } catch (err) {
      o.log(`sync: ${errText(err)}`); // the stream is going too: pending mutations are resent after welcome
    } finally {
      posting = false;
      if (outbox.length > 0) void flush();
    }
  }

  carry(client.handle({ kind: 'subscribe', topic: LIST, passive: true }, o.now()));
  carry(client.handle({ kind: 'open' }, o.now()));

  return {
    proto: 2,
    done: end.promise,
    stats,
    save: () => client.save(),
    close: () => finish({ reason: 'closed' }),
    mutate(mid, cmd, args) {
      if (end.settled()) return Promise.reject(new PeerHttpError('That computer isn’t connected.', 503));
      return new Promise((resolve, reject) => {
        answers.set(mid, { resolve, reject });
        carry(client.handle({ kind: 'mutate', mid, cmd, args }, o.now()));
      });
    },
  };
}
