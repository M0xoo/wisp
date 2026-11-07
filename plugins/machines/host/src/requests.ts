// Requests to a peer's wisp (v1 Machines#online, #raw, json, stream), and v2 commands routed to the
// peer that owns a row (plan §7.2.1): the same idempotency key goes there, so a flaky tunnel never
// runs a follow-up twice, even across wakes.

import type { Json } from '@wisp/kernel';
import { PeerHttpError, splitId, type Channel, type ChannelRequest, type MirrorRow, type PeerRow, type RawResponse, type RouteArgs } from '@wisp-plugin/machines-api';
import { errText } from './feed.ts';
import { isSyncFeed } from './feeds.ts';
import { wakes, type Manager } from './manager.ts';

/** A machine's answer as JSON. An error page that isn't (a proxy's 413, a gateway's 502) keeps its words. */
export function parseReply(text: string): Record<string, unknown> {
  try {
    const v: unknown = text ? JSON.parse(text) : {};
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : { value: v };
  } catch {
    return { error: text.slice(0, 200) };
  }
}

const ORIGIN = /^([A-Za-z0-9_-]{1,64}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export class Requests {
  readonly #m: Manager;

  constructor(m: Manager) {
    this.#m = m;
  }

  /** Where a request goes: the open channel, or (asleep, waking) one that wakes the box. */
  channelFor(id: string): { peer: PeerRow; channel: Channel } {
    const m = this.#m;
    const peer = m.o.registry.get(id);
    const t = m.transportOf(peer);
    const c = m.conns.get(id);
    const takes = !!t?.wakesOnRequest?.(peer);
    // Your other computer through its tunnel: nothing here can wake it.
    if (t?.probe && !takes && c?.state !== 'online') throw new PeerHttpError(`${peer.name} is offline: it comes back when that computer is on and wisp runs there.`, 503);
    // Asleep: the request itself wakes it; the event stream follows. So does the one after it, while
    // that wake is still going: a box idled out during a long job would otherwise fail its next call.
    if (takes && wakes(c) && t?.direct && c) {
      void m.connect(id, { retry: true }).catch(() => {});
      return { peer, channel: t.direct(peer, m.io(m.conns.get(id) ?? c)) };
    }
    if (c?.state !== 'online' || !c.channel) throw new PeerHttpError(`${peer.name} is offline. Connect it from Machines.`, 503);
    return { peer, channel: c.channel };
  }

  usable(id: string): boolean {
    const peer = this.#m.o.registry.find(id);
    if (!peer) return false;
    const c = this.#m.conns.get(id);
    return c?.state === 'online' || (wakes(c) && !!this.#m.transportOf(peer)?.wakesOnRequest?.(peer));
  }

  async #send(peer: PeerRow, channel: Channel, req: ChannelRequest): Promise<Awaited<ReturnType<Channel['request']>>> {
    try {
      return await channel.request(req);
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (code === 'ETIMEDOUT') throw new PeerHttpError(`${peer.name} didn’t answer in time.`, 504);
      throw new PeerHttpError(errText(err), 502);
    }
  }

  async json<T = unknown>(id: string, method: string, path: string, body?: unknown, opts: { timeoutMs?: number } = {}): Promise<T> {
    const { peer, channel } = this.channelFor(id);
    const hasBody = method !== 'GET' && method !== 'HEAD';
    // content-length always (send() sets it): Node doesn't frame a DELETE's body by default
    const data = hasBody ? JSON.stringify(body ?? {}) : undefined;
    const res = await this.#send(peer, channel, { method, path, ...(data !== undefined && { body: data, headers: { 'content-type': 'application/json' } }), ...(opts.timeoutMs !== undefined && { timeoutMs: opts.timeoutMs }) });
    const j = parseReply(await res.text());
    if (res.status >= 400) throw new PeerHttpError(typeof j['error'] === 'string' && j['error'] ? j['error'] : `${peer.name}: HTTP ${res.status}`, res.status, j['hold'] as Json | undefined); // hold: Ask near the limit there
    return ('value' in j && Object.keys(j).length === 1 ? j['value'] : j) as T;
  }

  async stream(id: string, method: string, path: string, opts: { body?: ChannelRequest['body']; headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<RawResponse> {
    const { peer, channel } = this.channelFor(id);
    const res = await this.#send(peer, channel, { method, path, ...opts });
    return { status: res.status, headers: res.headers, body: res.body, cancel: () => res.cancel() };
  }

  /** The peer that owns an id: v1's `<id>@<machine>`, or a v2 `<peer>:<uuid>` of a known peer. */
  ownerOf(id: string): { machine: string; id: string } | null {
    const v1 = splitId(id);
    if (v1 && this.#m.o.registry.find(v1.machine)) return v1;
    const o = ORIGIN.exec(id);
    const peer = o?.[1] ? this.#m.o.registry.byPeerId(o[1]) : undefined;
    return peer ? { machine: peer.id, id } : null;
  }

  /** machines.route: the command goes to the owning peer with the same key, waking it if it may. */
  async route(a: RouteArgs): Promise<unknown> {
    const target = a.id ?? this.ownerOf(argId(a.args))?.machine;
    if (!target) throw new PeerHttpError('No machine here owns that id.', 404);
    const peer = this.#m.o.registry.get(target);
    let c = this.#m.conns.get(target);
    if (c?.remote?.proto === 1) throw new PeerHttpError(`Update wisp on ${peer.name}: it only takes v1 requests.`, 409);
    if (c?.state !== 'online' && this.usable(target)) {
      await this.#m.connect(target, { retry: true });
      c = await this.#online(target, 90_000);
    }
    if (!c || c.state !== 'online' || !c.channel) throw new PeerHttpError(`${peer.name} is offline. Connect it from Machines.`, 503);
    if (isSyncFeed(c.feed)) return c.feed.mutate(a.mid, a.cmd, a.args);
    const res = await this.#send(peer, c.channel, { method: 'POST', path: '/cmd', headers: { 'content-type': 'application/json', 'idempotency-key': a.mid }, body: JSON.stringify({ cmd: a.cmd, args: a.args }) });
    const j = parseReply(await res.text());
    if (j['ok'] === true) return j['result'];
    const err = typeof j['error'] === 'object' && j['error'] !== null ? (j['error'] as Record<string, unknown>) : {};
    throw new PeerHttpError(typeof err['message'] === 'string' ? err['message'] : `${peer.name}: HTTP ${res.status}`, res.status >= 400 ? res.status : 400);
  }

  /** waits for a connect under way to go online (or to stop trying) */
  async #online(id: string, ms: number): Promise<ReturnType<Manager['conns']['get']>> {
    const until = this.#m.o.clock.now() + ms;
    for (;;) {
      const c = this.#m.conns.get(id);
      if (!c || c.state === 'online' || (!c.inFlight && c.state !== 'reconnecting') || this.#m.o.clock.now() > until) return c;
      await new Promise<void>((resolve) => {
        const off = (): void => resolve();
        c.scope.timeout(250, off);
        c.scope.add(off);
      });
    }
  }

  rows(id?: string): MirrorRow[] {
    return this.#m.o.mirror.rows(id);
  }
}

const argId = (args: unknown): string => (typeof args === 'object' && args !== null && typeof (args as { id?: unknown }).id === 'string' ? (args as { id: string }).id : '');
