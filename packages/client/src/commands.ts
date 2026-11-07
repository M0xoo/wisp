// Writes are commands (plan §4.5, §4.6.5). A command declares its optimistic patch, or says
// `optimistic: 'none'`: the type has no third option, so the optimistic part can't be forgotten.
// Running one: a UUIDv7 mid (the idempotency key), the patch goes on the pending overlay at once,
// the command is persisted, then sent to the peer that owns the id (origin routing, §7.2.1). The
// ack settles it once the peer's patches catch up; a reject rolls it back and calls `onError`
// (the toast). Offline, it waits and is resent after the next welcome with the same mid, so a
// flaky tunnel never runs it twice; and running the same command again while it is in flight
// returns the first run (#643).

import type { Devtools } from './devtools.ts';
import type { EntityReader, EntityWriter } from './entities.ts';
import type { FeatureNeed } from './features.ts';
import { ownerOf, uuidv7 } from './ids.ts';
import type { EntityOps } from './ops.ts';
import type { Answer, Peers } from './peers.ts';
import type { Persist } from './persist.ts';
import { signal, untracked, type Readable } from './signals.ts';
import type { PeerId, Warn, WireError } from './types.ts';

export interface CommandDef<A, R = unknown> {
  readonly id: string; // 'session.rename'
  /** the entity key (or a bare peer id) whose peer runs the command */
  readonly owner: (args: A) => string;
  /** the change to show before the peer answers, computed from what's on screen */
  readonly optimistic: ((base: EntityReader, args: A) => EntityOps) | 'none';
  /** runs with the same key while one is in flight are that one run; default: id + args */
  readonly dedupe?: (args: A) => string;
  /** the peer must offer this, or the command fails at once with the reason */
  readonly feature?: FeatureNeed;
  /** phantom: the result type, for inference only */
  readonly __result?: R;
}

export function defineCommand<A, R = unknown>(def: CommandDef<A, R>): CommandDef<A, R> {
  return def;
}

export class CommandError extends Error implements WireError {
  readonly code: string;
  readonly retry?: boolean;
  constructor(e: WireError) {
    super(e.message);
    this.name = 'CommandError';
    this.code = e.code;
    if (e.retry !== undefined) this.retry = e.retry;
  }
}

/** What survives a reload: enough to show the overlay again and resend with the same mid. */
export interface PendingRecord {
  readonly mid: string;
  readonly cmd: string;
  readonly args: unknown;
  readonly peer: PeerId;
  readonly ops: EntityOps;
  readonly key: string;
  readonly at: number;
}

export interface PendingView {
  readonly mid: string;
  readonly cmd: string;
  readonly peer: PeerId;
  /** not sent yet: "waiting for <box> to wake" */
  readonly waiting: boolean;
}

export interface Commands {
  run<A, R>(def: CommandDef<A, R>, args: A): Promise<R>;
  /** loads commands persisted by an earlier run and hands them to their peers again, same mids */
  restore(): Promise<void>;
  pending(): Readable<readonly PendingView[]>;
}

export interface CommandsOptions {
  reader: EntityReader;
  writer: EntityWriter;
  peers: Peers;
  persist?: Persist;
  devtools?: Devtools;
  onError?: (err: CommandError, cmd: string) => void;
  warn?: Warn;
  now?: () => number;
}

const NS = 'pending';

export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

interface Waiter {
  resolve(v: unknown): void;
  reject(e: CommandError): void;
  readonly promise: Promise<unknown>;
}

// size-ok: a factory; its body is small closures over shared private state, each under the cap
export function createCommands(o: CommandsOptions): Commands {
  const now = o.now ?? Date.now;
  const warn = o.warn ?? (() => {});
  const records = new Map<string, PendingRecord>(); // by mid, in the order they ran
  const sent = new Set<string>();
  const waiters = new Map<string, Waiter>(); // by mid; restored commands have none
  const byKey = new Map<string, string>(); // dedupe key → mid
  const view = signal<readonly PendingView[]>([]);

  const refresh = (): void => view([...records.values()].map((r) => ({ mid: r.mid, cmd: r.cmd, peer: r.peer, waiting: !sent.has(r.mid) })));
  const save = (r: PendingRecord, value: PendingRecord | undefined): void => {
    o.persist?.write([{ ns: NS, key: r.mid, value }]).catch((err: unknown) => warn('pending command not persisted', String(err)));
  };

  /** the link sends it now if the peer is live, else after the next welcome, with the same mid */
  function send(r: PendingRecord): void {
    if (!o.peers.mutate(r.peer, { mid: r.mid, cmd: r.cmd, args: r.args })) warn(`command ${r.cmd} waits for ${r.peer}, which isn't added`);
  }

  function finish(mid: string): PendingRecord | undefined {
    const r = records.get(mid);
    if (!r) return undefined;
    records.delete(mid);
    sent.delete(mid);
    if (byKey.get(r.key) === mid) byKey.delete(r.key);
    save(r, undefined);
    refresh();
    return r;
  }

  function fail(cmd: string, err: CommandError, w?: Waiter): void {
    o.onError?.(err, cmd);
    w?.reject(err);
  }

  function answer(a: Answer): void {
    const r = finish(a.mid);
    if (!r) return; // not ours, or answered already (a resend's second answer)
    const w = waiters.get(a.mid);
    waiters.delete(a.mid);
    if (a.t === 'ack') {
      o.devtools?.record({ kind: 'ack', mid: a.mid, seq: a.seq });
      o.writer.settle(a.mid, a.seq);
      w?.resolve(a.result);
    } else {
      o.devtools?.record({ kind: 'reject', mid: a.mid, code: a.code, message: a.message });
      o.writer.dropPending(a.mid);
      fail(r.cmd, new CommandError({ code: a.code, message: a.message }), w);
    }
  }

  o.peers.onAnswer((_peer, a) => answer(a));
  o.peers.onSent((peer, mid) => {
    if (!records.has(mid) || sent.has(mid)) return;
    sent.add(mid);
    o.devtools?.record({ kind: 'sent', mid, peer });
    refresh();
  });

  function deferred(): Waiter {
    let resolve: (v: unknown) => void = () => {};
    let reject: (e: CommandError) => void = () => {};
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // the rejection reaches onError (the toast) anyway: a caller that doesn't await isn't a crash
    promise.catch(() => {});
    return { resolve, reject, promise };
  }

  return {
    run<A, R>(def: CommandDef<A, R>, args: A): Promise<R> {
      const key = def.dedupe ? `${def.id}\u0000${def.dedupe(args)}` : `${def.id}\u0000${stableJson(args)}`;
      const running = byKey.get(key);
      const again = running === undefined ? undefined : waiters.get(running);
      if (again) return again.promise as Promise<R>;

      const peer = ownerOf(def.owner(args));
      const w = deferred();
      const gate = def.feature && untracked(o.peers.info(peer)) ? o.peers.hasFeature(peer, def.feature) : { ok: true as const };
      if (!gate.ok) {
        fail(def.id, new CommandError({ code: 'unavailable', message: gate.reason }), w);
        return w.promise as Promise<R>;
      }
      let ops: EntityOps;
      try {
        ops = def.optimistic === 'none' ? [] : def.optimistic(o.reader, args);
      } catch (err) {
        fail(def.id, new CommandError({ code: 'invalid', message: err instanceof Error ? err.message : String(err) }), w);
        return w.promise as Promise<R>;
      }
      const mid = uuidv7(now());
      const r: PendingRecord = { mid, cmd: def.id, args, peer, ops, key, at: now() };
      records.set(mid, r);
      waiters.set(mid, w);
      byKey.set(key, mid);
      o.devtools?.record({ kind: 'command', mid, cmd: def.id, peer });
      o.writer.addPending(mid, peer, ops);
      save(r, r);
      refresh();
      send(r);
      return w.promise as Promise<R>;
    },
    async restore() {
      if (!o.persist) return;
      const saved = (await o.persist.entries(NS)).map(([, v]) => v as PendingRecord).sort((a, b) => a.at - b.at);
      for (const r of saved) {
        if (records.has(r.mid)) continue;
        records.set(r.mid, r);
        waiters.set(r.mid, deferred()); // so running it again joins it instead of sending twice
        byKey.set(r.key, r.mid);
        o.writer.addPending(r.mid, r.peer, r.ops);
        send(r);
      }
      refresh();
    },
    pending: () => () => view(),
  };
}
