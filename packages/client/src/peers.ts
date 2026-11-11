// The peer manager (plan §7.2.1, §7.3.1): N peers at once, each with its own transport, sync link
// (epoch + cursor), status and subscriptions, merged into one entity store. It is the host of the
// sans-IO link: it opens the streams the link asks for, feeds it frames, and carries out what it
// returns. Subscriptions belong to the asking scope: two components showing one task share one
// subscription (the link refcounts), and the last to go ends it. A sleeping box stays asleep
// until something wakes it: opening its task or sending it a command (plan §7.2.3).

import type { Ack, Notice, PeerInfo, Reject, Topic } from '@wisp/protocol';
import type { Devtools } from './devtools.ts';
import type { EntityWriter } from './entities.ts';
import { hasFeature, updateReason, type FeatureAnswer, type FeatureNeed } from './features.ts';
import { syncLink, type ClientInput, type ClientOutput, type LinkSaved, type PeerLink } from './peer.ts';
import type { Scope } from './scope.ts';
import { batch, signal, untracked, type Readable, type WritableSignal } from './signals.ts';
import { PeerDown, type Frame, type PeerHttp, type Transport } from './transport.ts';
import type { PeerId, Warn } from './types.ts';

export type PeerStatus =
  | { kind: 'connecting' }
  | { kind: 'online' }
  | { kind: 'asleep' }
  | { kind: 'waking' }
  | { kind: 'unreachable'; reason: string }
  | { kind: 'incompatible'; reason: string; update: 'peer' | 'app' };

export interface PeerConfig {
  peer: PeerId;
  name: string;
  transport: Transport;
  /** the link state saved by an earlier run (first paint) */
  saved?: LinkSaved;
  /** another link implementation; @wisp/sync's SyncClient by default */
  link?: PeerLink;
}

export type Answer = Ack | Reject;
export type RowsAnswer = Extract<ClientOutput, { kind: 'rows' }>;

export interface Peers {
  add(cfg: PeerConfig): void;
  remove(peer: PeerId): void;
  list(): Readable<readonly PeerId[]>;
  status(peer: PeerId): Readable<PeerStatus>;
  info(peer: PeerId): Readable<PeerInfo | undefined>;
  name(peer: PeerId): string;
  hasFeature(peer: PeerId, need: FeatureNeed): FeatureAnswer;
  /** keeps `topic` of `peer` live while `scope` lives; a passive watch never wakes a box */
  watch(peer: PeerId, topic: Topic, scope: Scope, opts?: { passive?: boolean }): void;
  wake(peer: PeerId): Promise<void>;
  /** hands a command to the peer's link: sent now if live, else after the next welcome */
  mutate(peer: PeerId, m: { mid: string; cmd: string; args: unknown }): boolean;
  /** asks for older rows of `topic` (a transcript page); false when the peer isn't online */
  window(peer: PeerId, w: { req: string; topic: Topic; beforeSeq: number; limit: number }): boolean;
  save(peer: PeerId): LinkSaved | undefined;
  /** the peer's own routes (raw bodies, event streams), through its transport */
  http(peer: PeerId): PeerHttp;
  onLive(fn: (peer: PeerId) => void): () => void;
  onSent(fn: (peer: PeerId, mid: string) => void): () => void;
  onAnswer(fn: (peer: PeerId, a: Answer) => void): () => void;
  onNotice(fn: (peer: PeerId, n: Notice) => void): () => void;
  onRows(fn: (peer: PeerId, r: RowsAnswer) => void): () => void;
}

export interface PeersOptions {
  scope: Scope;
  writer: EntityWriter;
  clientId: string;
  build: string;
  warn?: Warn;
  devtools?: Devtools;
}

interface PeerRuntime {
  readonly cfg: PeerConfig;
  readonly link: PeerLink;
  readonly scope: Scope;
  readonly status: WritableSignal<PeerStatus>;
  readonly info: WritableSignal<PeerInfo | undefined>;
  conn?: Scope;
  cancelRetry?: () => void;
  asleep: boolean;
  waking: boolean;
  lastError: string;
}

const listen = <F>(set: Set<F>, fn: F): (() => void) => {
  set.add(fn);
  return () => set.delete(fn);
};
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// size-ok: a factory; its body is small closures over shared private state, each under the cap
export function createPeers(o: PeersOptions): Peers {
  const warn = o.warn ?? (() => {});
  const now = (): number => o.scope.timers.now();
  const peers = new Map<PeerId, PeerRuntime>();
  const ids = signal<readonly PeerId[]>([]);
  const statusOf = new Map<PeerId, WritableSignal<PeerStatus>>();
  const infoOf = new Map<PeerId, WritableSignal<PeerInfo | undefined>>();
  const on = {
    live: new Set<(p: PeerId) => void>(),
    sent: new Set<(p: PeerId, mid: string) => void>(),
    answer: new Set<(p: PeerId, a: Answer) => void>(),
    notice: new Set<(p: PeerId, n: Notice) => void>(),
    rows: new Set<(p: PeerId, r: RowsAnswer) => void>(),
  };

  const lazy = <V>(m: Map<PeerId, WritableSignal<V>>, peer: PeerId, init: V): WritableSignal<V> => {
    let s = m.get(peer);
    if (!s) m.set(peer, (s = signal<V>(init)));
    return s;
  };
  const statusSig = (peer: PeerId): WritableSignal<PeerStatus> => lazy(statusOf, peer, { kind: 'unreachable', reason: 'not added' } as PeerStatus);
  const infoSig = (peer: PeerId): WritableSignal<PeerInfo | undefined> => lazy(infoOf, peer, undefined as PeerInfo | undefined);

  const feed = (p: PeerRuntime, input: ClientInput): void => {
    if (p.scope.alive) for (const out of p.link.handle(input, now())) carry(p, out);
  };

  /** an op the store couldn't apply: the link starts that topic over (unsub, then a fresh sub) */
  const drifted = (p: PeerRuntime, topic: Topic): void => {
    o.devtools?.record({ kind: 'frame', peer: p.cfg.peer, t: `drifted ${topic}` });
    feed(p, { kind: 'drifted', topic });
  };

  function setState(p: PeerRuntime, out: Extract<ClientOutput, { kind: 'state' }>): void {
    switch (out.state) {
      case 'idle':
        return;
      case 'connecting':
        return p.status(p.waking ? { kind: 'waking' } : { kind: 'connecting' });
      case 'live':
        p.waking = false;
        p.status({ kind: 'online' });
        for (const fn of on.live) fn(p.cfg.peer);
        return;
      case 'offline':
        return p.status(p.asleep ? { kind: 'asleep' } : { kind: 'unreachable', reason: p.lastError });
      case 'incompatible': {
        const update = out.update ?? 'peer';
        const name = untracked(p.info)?.name ?? p.cfg.name;
        p.conn?.dispose();
        return p.status({ kind: 'incompatible', reason: updateReason(update, name), update: update === 'client' ? 'app' : 'peer' });
      }
    }
  }

  function carry(p: PeerRuntime, out: ClientOutput): void {
    const peer = p.cfg.peer;
    switch (out.kind) {
      case 'request':
        return void connect(p, out.params);
      case 'send':
        if (out.message.t === 'mutate') for (const fn of on.sent) fn(peer, out.message.mid);
        p.cfg.transport.post(out.message, p.scope.signal).catch((err: unknown) => warn(`${out.message.t} to ${peer} not sent`, message(err)));
        return; // a lost mutate is resent after the next welcome, with the same mid
      case 'reset':
        return o.writer.resetPeer(peer);
      case 'snapshot':
        return o.writer.snapshot(peer, out.topic, out.rows);
      case 'entityOps':
        for (const topic of o.writer.applyServer(peer, out.ops)) drifted(p, topic);
        return;
      case 'ack':
        for (const fn of on.answer) fn(peer, { t: 'ack', mid: out.mid, seq: out.seq, ...(out.result !== undefined && { result: out.result }) });
        return;
      case 'reject':
        for (const fn of on.answer) fn(peer, { t: 'reject', mid: out.mid, code: out.code, message: out.message });
        return;
      case 'rows':
        for (const fn of on.rows) fn(peer, out);
        return;
      case 'denied':
        for (const fn of on.notice) fn(peer, { t: 'notice', kind: 'denied', data: { topic: out.topic, code: out.code } });
        return;
      case 'notice':
        for (const fn of on.notice) fn(peer, out.notice);
        return;
      case 'needResubscribe':
        return o.devtools?.record({ kind: 'frame', peer, t: `resync ${out.topic}` });
      case 'state':
        return setState(p, out);
      case 'retry':
        if (p.asleep) return; // sleeping boxes stay asleep
        p.cancelRetry?.();
        p.cancelRetry = p.scope.timeout(Math.max(0, out.at - now()), () => feed(p, { kind: 'open' }));
        return;
    }
  }

  function onFrame(p: PeerRuntime, frame: Frame): void {
    const peer = p.cfg.peer;
    o.devtools?.record({ kind: 'frame', peer, t: frame.messages.map((m) => m.t).join(','), ...(frame.id !== null && { seq: frame.id }) });
    for (const m of frame.messages) if (m.t === 'welcome') p.info(m.peer); // features come from the peer
    batch(() => {
      feed(p, { kind: 'frame', id: frame.id, messages: frame.messages });
      if (frame.id !== null) o.writer.advance(peer, frame.id);
    });
  }

  async function connect(p: PeerRuntime, params: Readonly<Record<string, string>>): Promise<void> {
    p.conn?.dispose();
    const conn = p.scope.child('conn');
    p.conn = conn;
    try {
      for await (const frame of p.cfg.transport.connect(params, conn.signal)) {
        if (!conn.alive) return;
        onFrame(p, frame);
      }
      p.lastError = 'connection closed';
    } catch (err) {
      if (!conn.alive) return;
      p.asleep = err instanceof PeerDown && err.status === 'asleep';
      p.lastError = message(err);
    }
    if (!conn.alive) return; // replaced or removed: not a loss
    conn.dispose();
    feed(p, { kind: 'lost' });
  }

  const manager: Peers = {
    add(cfg) {
      if (peers.has(cfg.peer)) throw new Error(`peer ${cfg.peer} is added twice`);
      const scope = o.scope.child(`peer:${cfg.peer}`);
      const link = cfg.link ?? syncLink({ peer: cfg.peer, clientId: o.clientId, build: o.build, ...(cfg.saved && { saved: cfg.saved }) });
      const p: PeerRuntime = { cfg, link, scope, status: statusSig(cfg.peer), info: infoSig(cfg.peer), asleep: false, waking: false, lastError: 'not connected' };
      peers.set(cfg.peer, p);
      ids([...untracked(ids), cfg.peer]);
      scope.add(() => {
        peers.delete(cfg.peer);
        ids(untracked(ids).filter((x) => x !== cfg.peer));
        p.status({ kind: 'unreachable', reason: 'removed' });
      });
      // open after the current task, so the views that watch right after add() ride on the hello
      scope.timeout(0, () => feed(p, { kind: 'open' }));
    },
    remove: (peer) => peers.get(peer)?.scope.dispose(),
    http: (peer) => peerHttp(() => peers.get(peer)?.cfg.transport, peer),
    list: () => () => ids(),
    status: (peer) => {
      const s = statusSig(peer);
      return () => s();
    },
    info: (peer) => {
      const s = infoSig(peer);
      return () => s();
    },
    name: (peer) => untracked(infoSig(peer))?.name ?? peers.get(peer)?.cfg.name ?? peer,
    hasFeature: (peer, need) => hasFeature(untracked(infoSig(peer)), need, manager.name(peer)),
    watch(peer, topic, scope, opts = {}) {
      const p = peers.get(peer);
      if (!p) return warn(`watch on an unknown peer ${peer}`, topic);
      const passive = opts.passive === true;
      feed(p, { kind: 'subscribe', topic, passive });
      scope.add(() => feed(p, { kind: 'unsubscribe', topic, passive }));
      if (!passive && p.asleep) void manager.wake(peer); // opening one of its tasks wakes a box
    },
    async wake(peer) {
      const p = peers.get(peer);
      if (!p || p.waking) return;
      p.asleep = false;
      p.waking = true;
      p.status({ kind: 'waking' });
      try {
        await p.cfg.transport.wake?.(p.scope.signal);
      } catch (err) {
        p.waking = false;
        p.lastError = message(err);
        p.status({ kind: 'unreachable', reason: p.lastError });
        return;
      }
      p.cancelRetry?.();
      feed(p, { kind: 'open' });
    },
    mutate(peer, m) {
      const p = peers.get(peer);
      if (!p) return false;
      feed(p, { kind: 'mutate', mid: m.mid, cmd: m.cmd, args: m.args });
      if (p.asleep) void manager.wake(peer); // sending it a command wakes a box
      return true;
    },
    window(peer, w) {
      const p = peers.get(peer);
      if (!p || untracked(p.status).kind !== 'online') return false;
      feed(p, { kind: 'window', req: w.req, topic: w.topic, beforeSeq: w.beforeSeq, limit: w.limit });
      return true;
    },
    save: (peer) => peers.get(peer)?.link.save(),
    onLive: (fn) => listen(on.live, fn),
    onSent: (fn) => listen(on.sent, fn),
    onAnswer: (fn) => listen(on.answer, fn),
    onNotice: (fn) => listen(on.notice, fn),
    onRows: (fn) => listen(on.rows, fn),
  };
  return manager;
}

/** A peer's routes over its transport: JSON answers, a refusal as an Error with the server's words. */
function peerHttp(transport: () => Transport | undefined, peer: PeerId): PeerHttp {
  const need = <K extends 'request' | 'events'>(k: K): NonNullable<Transport[K]> => {
    const t = transport();
    const f = t?.[k];
    if (!t || !f) throw new Error(`${peer} can't be reached that way (${t?.kind ?? 'no transport'})`);
    return f.bind(t) as NonNullable<Transport[K]>;
  };
  return {
    async send(r, signal) {
      const res = await need('request')(r, signal ?? new AbortController().signal);
      let body: unknown = null;
      try {
        body = res.text ? JSON.parse(res.text) : null;
      } catch {
        body = res.text;
      }
      if (res.status >= 400) {
        const msg = (body as { error?: { message?: string }; message?: string } | null)?.error?.message ?? (body as { message?: string } | null)?.message;
        throw new Error(typeof msg === 'string' ? msg : `HTTP ${res.status}`);
      }
      return body;
    },
    events: (path, signal) => need('events')(path, signal),
  };
}
