// Transcripts (plan §4.6.9): a task opens at the tail and pages backwards. Opening subscribes to
// `session:<id>`, whose snapshot and appends bring the tail; `older()` asks the peer for the page
// before the oldest event held (`window` → `rows`) and merges it under the tail in the entity
// store, so the task view reads one list from one home. A page answer that comes after the view
// closed, or after a newer request, is dropped: each request belongs to the view's scope.

import type { Topic } from '@wisp/protocol';
import type { EntityReader, EntityWriter } from './entities.ts';
import { entityKey, uuidv7 } from './ids.ts';
import type { Peers, RowsAnswer } from './peers.ts';
import type { Scope } from './scope.ts';
import { computed, signal, untracked, type Readable, type WritableSignal } from './signals.ts';
import type { DeepReadonly, PeerId } from './types.ts';

export type Paging = { kind: 'idle'; atStart: boolean } | { kind: 'loading' } | { kind: 'failed'; reason: string };

export interface Transcript<T> {
  /** the events held, oldest first: the pages loaded so far plus the live tail */
  readonly events: Readable<readonly DeepReadonly<T>[]>;
  readonly paging: Readable<Paging>;
  /** loads the page before the oldest event held; a call while one loads joins it */
  older(): Promise<void>;
}

export interface Transcripts {
  open<T = unknown>(peer: PeerId, sessionId: string, scope: Scope): Transcript<T>;
}

export interface TranscriptOptions {
  reader: EntityReader;
  writer: EntityWriter;
  peers: Peers;
  /** the entity kind of a session's event list (one list row per session) */
  kind?: string;
  seqOf?: (item: unknown) => number;
  /** the session an event belongs to, for rows that come one event at a time */
  groupOf?: (item: unknown) => string | undefined;
  pageSize?: number;
  timeoutMs?: number;
}

const field = (name: string) => (item: unknown): unknown => (typeof item === 'object' && item !== null ? (item as Record<string, unknown>)[name] : undefined);
const seqField = field('seq');
const sessionField = field('session_id');
const defaultSeq = (item: unknown): number => {
  const s = seqField(item);
  return typeof s === 'number' ? s : 0;
};
const defaultGroup = (item: unknown): string | undefined => {
  const g = sessionField(item);
  return typeof g === 'string' ? g : undefined;
};

interface Request {
  readonly peer: PeerId;
  readonly sessionId: string;
  readonly topic: Topic;
  resolve(r: RowsAnswer | Error): void;
}

export function createTranscripts(o: TranscriptOptions): Transcripts {
  const kind = o.kind ?? 'event';
  const seqOf = o.seqOf ?? defaultSeq;
  const groupOf = o.groupOf ?? defaultGroup;
  const pageSize = o.pageSize ?? 100;
  const timeoutMs = o.timeoutMs ?? 15_000;
  const requests = new Map<string, Request>();

  o.peers.onRows((peer, answer) => {
    const req = requests.get(answer.req);
    if (!req || req.peer !== peer) return; // not ours, or the view is gone: dropped
    requests.delete(answer.req);
    req.resolve(answer);
  });

  /** the items of one session in a `rows` answer: list rows (id = the session) or single events */
  function itemsOf(answer: RowsAnswer, peer: PeerId, sessionId: string): unknown[] {
    const key = entityKey(peer, sessionId);
    const out: unknown[] = [];
    for (const row of answer.rows) {
      if (row.e !== kind) continue;
      if (Array.isArray(row.v)) {
        if (row.id === sessionId || entityKey(peer, row.id) === key) out.push(...row.v);
      } else if (groupOf(row.v) === sessionId) out.push(row.v);
    }
    return out;
  }

  /** sends the window when the peer is online, waiting for it otherwise; resolves with the answer */
  function ask(scope: Scope, r: Omit<Request, 'resolve'>, beforeSeq: number): Promise<RowsAnswer | Error> {
    return new Promise((resolve) => {
      // one child scope per request: its timer and cleanups go when it is answered, or with the view
      const rs = scope.child('window');
      const req = uuidv7(scope.timers.now());
      const done = (x: RowsAnswer | Error): void => {
        resolve(x); // first: disposing runs the 'closed' cleanup, which must not win
        rs.dispose();
      };
      requests.set(req, { ...r, resolve: done });
      rs.add(() => {
        requests.delete(req); // a late answer finds nothing to land on
        resolve(new Error('closed')); // the view went first; load() sees its scope gone and stops
      });
      let sent = false;
      const send = (): void => {
        if (!sent) sent = o.peers.window(r.peer, { req, topic: r.topic, beforeSeq, limit: pageSize });
      };
      send();
      if (!sent) rs.add(o.peers.onLive((p) => p === r.peer && send())); // offline: ask once it's back
      rs.timeout(timeoutMs, () => done(new Error(`${o.peers.name(r.peer)} didn't answer`)));
    });
  }

  function load(scope: Scope, peer: PeerId, sessionId: string, events: Readable<readonly unknown[]>, paging: WritableSignal<Paging>): Promise<void> {
    const topic = `session:${sessionId}` as Topic;
    const held = untracked(events);
    const oldest = held.length > 0 ? seqOf(held[0]) : Number.MAX_SAFE_INTEGER; // nothing held: the latest page
    paging({ kind: 'loading' });
    return ask(scope, { peer, sessionId, topic }, oldest).then((answer) => {
      if (!scope.alive) return;
      if (answer instanceof Error) return paging({ kind: 'failed', reason: answer.message });
      const items = itemsOf(answer, peer, sessionId).filter((x) => seqOf(x) < oldest);
      o.writer.mergeOlder(peer, kind, sessionId, topic, items, seqOf);
      paging({ kind: 'idle', atStart: items.length < pageSize });
    });
  }

  return {
    open<T>(peer: PeerId, sessionId: string, scope: Scope): Transcript<T> {
      o.peers.watch(peer, `session:${sessionId}` as Topic, scope); // opening a task is use: it wakes a box
      const row = o.reader.row<T[]>(kind, entityKey(peer, sessionId));
      const events = computed(() => row() ?? []) as Readable<readonly DeepReadonly<T>[]>;
      const paging = signal<Paging>({ kind: 'idle', atStart: false });
      let inflight: Promise<void> | undefined;
      return {
        events,
        paging: () => paging(),
        older() {
          const p = untracked(paging);
          if (inflight) return inflight;
          if (p.kind === 'idle' && p.atStart) return Promise.resolve();
          inflight = load(scope, peer, sessionId, events, paging).finally(() => (inflight = undefined));
          return inflight;
        },
      };
    },
  };
}
