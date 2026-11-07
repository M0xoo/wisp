// The connection manager: one Conn per peer, whatever transport reaches it (v1 Machines' connect,
// #ready, #closed, #asleep, #fail, disconnect). Every attempt lives in a scope of its own; dropping
// it stops the transport (its ssh child, its HTTPS waits), the feed and every timer of that attempt.
//
//   connect   transport.connect → the 'tunnel' step (wisp answers /health through the channel) →
//             'agents' (/agents, /config) → online, and a feed keeps its rows here.
//   lost      once it has worked, keep trying (laptop lid, Wi-Fi, VPN) with backoff; a first connect
//             that fails stops. A box that went to sleep is watched (probe) without waking it.

import type { Clock, Json, Log, Scope, SecretsService } from '@wisp/kernel';
import { secretKey, TransportError, type Channel, type ChannelEnd, type ConnectIO, type PeerRow, type PeerState, type PeerStatus, type RemoteAgent, type RemoteInfo, type Step, type Transport } from '@wisp-plugin/machines-api';
import { errText, type Feed } from './feed.ts';
import { startFeed, type FeedHost } from './feeds.ts';
import type { Registry } from './registry.ts';
import { freshSteps, moveStep, type StatusStore } from './state.ts';

export const RETRY_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
export const WATCH_MS = 20_000; // how often an asleep box is checked (without waking it)
const MAX_LOG = 80;

export interface Conn {
  readonly id: string;
  /** this attempt's scope: its transport, feed and timers */
  readonly scope: Scope;
  state: PeerState;
  steps: Step[];
  error: string;
  hint: PeerStatus['hint'];
  attempt: number;
  since: number | null;
  remote: RemoteInfo | null;
  stale: number | null;
  log: string[];
  channel?: Channel;
  feed?: Feed;
  /** a connect still waiting for the box to answer: a request gets through meanwhile */
  waking: boolean;
  /** this attempt hasn't settled yet (online, failed or asleep) */
  inFlight: boolean;
  stopped: boolean;
  giveUp: boolean;
  wasOnline: boolean;
}

export interface ManagerOptions extends FeedHost {
  scope: Scope;
  clock: Clock;
  log: Log;
  registry: Registry;
  status: StatusStore;
  secrets: SecretsService;
  transport(kind: string): Transport | undefined;
  emit(type: string, data: { [k: string]: string }): void;
  retryMs?: readonly number[];
  watchMs?: number;
  /** /health tries through a fresh channel, and the gap between them (v1: 40 × 250 ms) */
  healthTries?: number;
  healthGapMs?: number;
}

export const wakes = (c: Conn | undefined): boolean => c !== undefined && (c.state === 'asleep' || (c.waking && !c.stopped));

export class Manager {
  readonly o: ManagerOptions;
  readonly conns = new Map<string, Conn>();

  constructor(o: ManagerOptions) {
    this.o = o;
  }

  transportOf(peer: PeerRow): Transport | undefined {
    return this.o.transport(peer.transport);
  }

  /** Opening wisp shouldn't wake a box: follow those, connect the rest. */
  start(): void {
    for (const m of this.o.registry.all()) {
      if (!m.autoConnect) continue;
      if (this.transportOf(m)?.autoStart?.(m) === false) this.follow(m.id);
      else void this.connect(m.id).catch(() => {});
    }
  }

  // ---------- status ----------

  status(c: Conn): PeerStatus {
    const peer = this.o.registry.find(c.id);
    const takes = !!(peer && this.transportOf(peer)?.wakesOnRequest?.(peer));
    return { id: c.id, state: c.state, steps: c.steps, error: c.error, hint: c.hint, attempt: c.attempt, since: c.since, remote: c.remote, stale: c.stale, wakes: takes && wakes(c) };
  }

  changed(c: Conn): void {
    if (this.conns.get(c.id) !== c) return;
    this.o.status.write(this.status(c));
    this.o.emit('machines.changed', { id: c.id });
  }

  io(c: Conn): ConnectIO {
    return {
      step: (id, status, detail) => {
        if (moveStep(c.steps, id, status, detail)) this.changed(c);
      },
      log: (line) => {
        c.log.push(line);
        if (c.log.length > MAX_LOG) c.log.splice(0, c.log.length - MAX_LOG);
      },
      stale: (pid) => {
        c.stale = pid;
      },
      secret: () => this.o.secrets.get(secretKey(c.id)),
    };
  }

  #newConn(peer: PeerRow, t: Transport | undefined, state: PeerState, prev: Conn | undefined, retry: boolean): Conn {
    prev?.scope.dispose();
    const c: Conn = {
      id: peer.id,
      scope: this.o.scope.child(`peer:${peer.id}`),
      state,
      steps: t ? freshSteps(t.steps) : [],
      error: '',
      hint: null,
      attempt: retry ? (prev?.attempt ?? 0) : 0,
      since: null,
      remote: prev?.remote ?? this.o.status.read(peer.id)?.remote ?? null,
      stale: null,
      log: [],
      waking: false,
      inFlight: false,
      stopped: false,
      giveUp: false,
      wasOnline: retry ? (prev?.wasOnline ?? false) : false,
    };
    this.conns.set(peer.id, c);
    return c;
  }

  // ---------- connecting ----------

  connect(id: string, { retry = false } = {}): Promise<PeerStatus> {
    const peer = this.o.registry.get(id);
    const prev = this.conns.get(id);
    if (prev !== undefined && !prev.stopped && (prev.state === 'online' || prev.inFlight)) return Promise.resolve(this.status(prev));
    const t = this.transportOf(peer);
    const c = this.#newConn(peer, t, retry ? 'reconnecting' : 'connecting', prev, retry);
    if (!t) {
      this.fail(c, `wisp can’t reach ${peer.name}: nothing here speaks “${peer.transport}” (its plugin is off or missing).`, null, { giveUp: true });
      return Promise.resolve(this.status(c));
    }
    c.waking = !!t.wakesOnRequest?.(peer);
    c.inFlight = true;
    this.changed(c);
    void this.#attempt(peer, t, c).finally(() => (c.inFlight = false));
    return Promise.resolve(this.status(c));
  }

  async #attempt(peer: PeerRow, t: Transport, c: Conn): Promise<void> {
    let channel: Channel;
    try {
      channel = await t.connect(peer, this.io(c), c.scope.signal);
    } catch (err) {
      c.waking = false;
      return this.#connectFailed(peer, t, c, err);
    }
    c.waking = false;
    if (this.conns.get(c.id) !== c || !c.scope.alive) return channel.close();
    c.channel = channel;
    c.scope.add(() => channel.close());
    void channel.closed.then((end) => this.#closed(peer, t, c, end));
    try {
      await this.#ready(peer, c, channel);
    } catch (err) {
      this.fail(c, errText(err), err instanceof TransportError ? (err.hint ?? null) : null);
    }
  }

  #connectFailed(peer: PeerRow, t: Transport, c: Conn, err: unknown): void {
    if (this.conns.get(c.id) !== c || !c.scope.alive) return;
    const e = err instanceof TransportError ? err : undefined;
    if (e?.kind === 'asleep') return this.asleep(peer, t, c);
    this.fail(c, errText(err), e?.hint ?? null, { giveUp: !!e?.giveUp || e?.kind === 'gone' });
    this.#retryOrStop(peer, c);
  }

  /** v1 #ready: wisp answers through the channel, its harnesses are looked up, then it's online. */
  async #ready(peer: PeerRow, c: Conn, channel: Channel): Promise<void> {
    const io = this.io(c);
    io.step('tunnel', 'run');
    const health = await this.#health(c, channel);
    if (!c.scope.alive || this.conns.get(c.id) !== c) return;
    if (!health) throw new Error('The tunnel opened, but wisp doesn’t answer through it.');
    io.step('tunnel', 'done', channel.label);
    const [agents, config] = await Promise.all([getJson(channel, '/agents'), getJson(channel, '/config')]);
    if (!c.scope.alive || this.conns.get(c.id) !== c) return;
    const list = Array.isArray(agents) ? agents.filter(isObj).map(remoteAgent) : [];
    const ready = list.filter((a) => a.available);
    const proto = typeof health['proto_max'] === 'number' ? health['proto_max'] : 1;
    c.remote = { ...c.remote, version: str(health['version']), pid: typeof health['pid'] === 'number' ? health['pid'] : null, home: str(isObj(config) ? config['home'] : ''), agents: list, proto };
    io.step('agents', ready.length ? 'done' : 'warn', ready.length ? ready.map((a) => a.name).join(', ') : 'No coding agent installed there yet. Install Claude Code, Codex or opencode on that computer and sign in once.');
    if (typeof health['peer'] === 'string' && health['peer'] !== peer.peer) this.o.registry.patch(peer.id, { peer: health['peer'] });
    Object.assign(c, { state: 'online', error: '', hint: null, attempt: 0, wasOnline: true, since: this.o.clock.now() });
    this.changed(c);
    this.#feed(peer, c, channel, proto);
    this.o.emit('machines.online', { id: c.id });
  }

  async #health(c: Conn, channel: Channel): Promise<Record<string, unknown> | null> {
    const tries = this.o.healthTries ?? 40;
    for (let i = 0; i < tries && c.scope.alive; i++) {
      const h = await getJson(channel, '/health');
      if (isObj(h) && typeof h['version'] === 'string') return h;
      await sleep(c.scope, this.o.healthGapMs ?? 250);
    }
    return null;
  }

  #feed(peer: PeerRow, c: Conn, channel: Channel, proto: number): void {
    const feed = startFeed(this.o, peer, channel, proto, (line) => this.io(c).log(line));
    c.feed = feed;
    c.scope.add(() => feed.close());
    void feed.done.then((end) => {
      if (this.conns.get(c.id) !== c || !c.scope.alive || c.feed !== feed) return;
      if (end.reason === 'v1') {
        if (c.remote) c.remote = { ...c.remote, proto: 1 };
        return this.#feed(peer, c, channel, 1);
      }
      if (end.reason === 'closed') return;
      if (end.reason === 'incompatible') {
        c.giveUp = true;
        const where = end.update === 'peer' ? `Update wisp on ${peer.name}` : 'Update wisp here';
        Object.assign(c, { state: 'incompatible', error: `${where}: the two don’t speak a common protocol version.`, hint: { title: where, text: 'Restart wisp there to start this version, or update this one.' } });
        this.changed(c);
        return channel.close();
      }
      // the stream ended but the way may be up: a box that sleeps went to sleep; else start over
      const t = this.transportOf(peer);
      if (t?.probe) return this.asleep(peer, t, c);
      c.error = 'wisp stopped answering there.';
      channel.close();
    });
  }

  /** v1 #closed: the way is gone. Once it has worked, try again; else say why and stop. */
  #closed(peer: PeerRow, t: Transport, c: Conn, end: ChannelEnd): void {
    if (this.conns.get(c.id) !== c || c.state === 'asleep' || c.state === 'incompatible') return;
    if (c.stopped) {
      c.state = 'off';
      return this.changed(c);
    }
    if (end.reason === 'asleep') return this.asleep(peer, t, c);
    if (!c.error) {
      c.error = c.wasOnline ? 'Connection lost.' : (end.error ?? 'Connection closed.');
      c.hint = end.hint ?? null;
      const running = c.steps.find((s) => s.status === 'run');
      if (running) Object.assign(running, { status: 'fail', detail: c.hint?.title ?? c.error });
    }
    if (end.giveUp || end.reason === 'gone') c.giveUp = true;
    this.#retryOrStop(peer, c);
    this.o.emit('machines.offline', { id: c.id, state: c.state });
  }

  #retryOrStop(peer: PeerRow, c: Conn): void {
    if (this.conns.get(c.id) !== c) return;
    if (c.wasOnline && !c.giveUp && !c.stopped) {
      c.state = 'reconnecting';
      const retry = this.o.retryMs ?? RETRY_MS;
      const wait = retry[Math.min(c.attempt, retry.length - 1)] ?? 60_000;
      c.attempt += 1;
      c.scope.timeout(wait, () => void this.connect(peer.id, { retry: true }).catch(() => {}));
    } else c.state = c.stopped ? 'off' : 'error';
    this.changed(c);
  }

  /** v1 #fail: say what went wrong on the card and hang up. */
  fail(c: Conn, msg: string, hint: PeerStatus['hint'], { keep = false, giveUp = false } = {}): void {
    if (this.conns.get(c.id) !== c) return;
    if (giveUp) c.giveUp = true;
    if (c.error && !keep) return;
    c.error = msg;
    c.hint = hint ?? c.hint;
    const running = c.steps.find((s) => s.status === 'run');
    if (running) Object.assign(running, { status: 'fail', detail: running.detail || msg });
    c.state = 'error';
    c.waking = false;
    this.changed(c);
    c.feed?.close();
    c.channel?.close();
  }

  // ---------- asleep ----------

  /** Watch a box without waking it; connect once it's up (v1 follow). */
  follow(id: string): void {
    const peer = this.o.registry.get(id);
    const t = this.transportOf(peer);
    if (!t?.probe) return void this.connect(id).catch(() => {});
    const c = this.#newConn(peer, t, 'asleep', this.conns.get(id), false);
    this.asleep(peer, t, c, 0);
  }

  /** The box stopped (idle): keep its rows, check now and then without waking it. */
  asleep(peer: PeerRow, t: Transport, c: Conn, firstMs = this.o.watchMs ?? WATCH_MS): void {
    if (this.conns.get(c.id) !== c) return;
    c.feed?.close();
    c.channel?.close();
    Object.assign(c, { state: 'asleep', error: '', waking: false });
    this.changed(c);
    this.o.emit('machines.offline', { id: c.id, state: 'asleep' });
    const watch = async (): Promise<void> => {
      if (this.conns.get(c.id) !== c || c.state !== 'asleep' || !t.probe) return;
      const r = await t.probe(peer, this.io(c), c.scope.signal).catch(() => 'asleep' as const);
      if (this.conns.get(c.id) !== c || c.state !== 'asleep' || !c.scope.alive) return;
      if (r === 'running') return void this.connect(peer.id, { retry: true }).catch(() => {}); // woken elsewhere: follow it
      if (r === 'gone') return this.fail(c, 'Signed out of this computer’s grid.', { title: 'Sign in again', text: 'Settings → Cloud → Sign in, with the same grid.' }, { giveUp: true });
      c.scope.timeout(this.o.watchMs ?? WATCH_MS, () => void watch());
    };
    c.scope.timeout(firstMs, () => void watch());
  }

  // ---------- hanging up ----------

  disconnect(id: string): void {
    const c = this.conns.get(id);
    if (!c) return;
    Object.assign(c, { stopped: true, giveUp: true, waking: false, state: 'off' });
    this.changed(c);
    c.scope.dispose();
    const peer = this.o.registry.find(id);
    // a box's rows aren't kept once you disconnect it by hand (v1: the grid cache went)
    if (peer && this.transportOf(peer)?.probe) this.o.mirror.reset(id);
  }

  forget(id: string): void {
    this.conns.get(id)?.scope.dispose();
    this.conns.delete(id);
  }
}

// ---------- helpers ----------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** What the UI needs of a machine's harness list. */
export function remoteAgent(a: Record<string, unknown>): RemoteAgent {
  const out: RemoteAgent = { id: str(a['id']), name: str(a['name']), available: a['available'] === true };
  if (typeof a['version'] === 'string') out.version = a['version'];
  for (const k of ['models', 'efforts', 'delegates'] as const) if (a[k] !== undefined) out[k] = a[k] as Json;
  if (a['signedIn'] === false) out.signedIn = false;
  return out;
}

/** A GET through the channel as JSON, or null when it fails (the caller decides what that means). */
export async function getJson(channel: Channel, path: string, timeoutMs = 30_000): Promise<unknown> {
  try {
    const res = await channel.request({ method: 'GET', path, timeoutMs, passive: true });
    const text = await res.text();
    if (res.status >= 400) return null;
    return text ? (JSON.parse(text) as unknown) : {};
  } catch {
    return null;
  }
}

/** A pause inside a scope; one dropped meanwhile never resolves it (the loop it is in is over). */
export const sleep = (scope: Scope, ms: number): Promise<void> =>
  new Promise((resolve) => {
    if (!scope.alive) return resolve();
    scope.timeout(ms, resolve);
  });
