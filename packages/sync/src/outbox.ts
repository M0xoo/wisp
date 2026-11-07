// One connection's outbox (plan §4.4): entity ops keyed by (topic, e, id) so a newer change folds
// into the one still queued, plus snapshot and window pages in front of each topic's ops. Taking
// from it follows the priority order: the client's sessions, then the list, then the rest.

import type { EntityOp, ServerMessage, Topic } from '@wisp/protocol';
import { fold } from './fold.ts';

interface Item {
  ops: EntityOp[];
  /** the oldest change folded in: the cursor can't pass it until the item is sent */
  firstSeq: number;
  bytes: number;
}

interface Front {
  msg: ServerMessage;
  bytes: number;
  /** a snapshot that replaces rows the client holds as of firstSeq - 1 pins the cursor like an op */
  firstSeq: number | null;
}

interface TopicQueue {
  /** snapshot and rows messages, sent before the topic's ops */
  front: Front[];
  items: Map<string, Item>;
}

export interface Taken {
  messages: ServerMessage[]; // snapshots and rows, in order
  ops: EntityOp[];
  bytes: number;
}

/** Lower goes first. Acks and control messages are ahead of every topic. */
export function topicRank(topic: Topic): number {
  if (topic.startsWith('session:')) return 1;
  if (topic === 'list') return 2;
  return 3;
}

function queueOldest(q: TopicQueue): number | null {
  let min: number | null = null;
  for (const f of q.front) if (f.firstSeq !== null) min = min === null ? f.firstSeq : Math.min(min, f.firstSeq);
  for (const item of q.items.values()) min = min === null ? item.firstSeq : Math.min(min, item.firstSeq);
  return min;
}

const keyOf = (e: string, id: string): string => `${e}\u0000${id}`;

export class Outbox {
  #topics = new Map<Topic, TopicQueue>();

  #queue(topic: Topic): TopicQueue {
    let q = this.#topics.get(topic);
    if (q === undefined) {
      q = { front: [], items: new Map() };
      this.#topics.set(topic, q);
    }
    return q;
  }

  pushOp(op: EntityOp, seq: number, bytes: number): void {
    const q = this.#queue(op.topic);
    const key = keyOf(op.e, op.id);
    const item = q.items.get(key);
    if (item === undefined) {
      q.items.set(key, { ops: [op], firstSeq: seq, bytes });
      return;
    }
    item.ops = fold(item.ops, op);
    // upsert and del replace what was queued; the rest grows by about the new op's size
    item.bytes = op.op === 'upsert' || op.op === 'del' ? bytes : item.bytes + bytes;
  }

  pushFront(topic: Topic, msg: ServerMessage, bytes: number, firstSeq: number | null = null): void {
    this.#queue(topic).front.push({ msg, bytes, firstSeq });
  }

  /** Drops the topic's queued ops and snapshot pages; window rows stay (someone asked for them). Returns the oldest dropped seq, or null. */
  drop(topic: Topic, keepRows = true): { oldestSeq: number | null; any: boolean } {
    const q = this.#topics.get(topic);
    if (q === undefined) return { oldestSeq: null, any: false };
    const oldestSeq = queueOldest(q);
    const any = q.items.size > 0 || q.front.some((f) => f.msg.t === 'snapshot');
    q.items.clear();
    q.front = keepRows ? q.front.filter((f) => f.msg.t === 'rows') : [];
    if (q.front.length === 0) this.#topics.delete(topic);
    return { oldestSeq, any };
  }

  /** Topics with ops or snapshot pages waiting (window rows alone don't count). */
  busyTopics(): Topic[] {
    const out: Topic[] = [];
    for (const [t, q] of this.#topics) if (q.items.size > 0 || q.front.some((f) => f.msg.t === 'snapshot')) out.push(t);
    return out;
  }

  oldestSeq(): number | null {
    let min: number | null = null;
    for (const q of this.#topics.values()) {
      const m = queueOldest(q);
      if (m !== null) min = min === null ? m : Math.min(min, m);
    }
    return min;
  }

  get empty(): boolean {
    return this.#topics.size === 0;
  }

  /**
   * Takes messages and ops up to `budget` bytes, highest priority first. Something is always taken
   * when anything is queued, so one item bigger than the budget can't stall the connection.
   */
  take(budget: number): Taken {
    const taken: Taken = { messages: [], ops: [], bytes: 0 };
    const order = [...this.#topics.keys()].sort((a, b) => topicRank(a) - topicRank(b));
    for (const topic of order) {
      const q = this.#topics.get(topic);
      if (q === undefined) continue;
      if (!this.#takeTopic(q, taken, budget)) {
        this.#gc(topic, q);
        break;
      }
      this.#gc(topic, q);
    }
    return taken;
  }

  /** false when the budget ran out inside this topic */
  #takeTopic(q: TopicQueue, taken: Taken, budget: number): boolean {
    const fits = (bytes: number): boolean => taken.bytes === 0 || taken.bytes + bytes <= budget;
    while (q.front.length > 0) {
      const f = q.front[0] as Front; // length checked
      if (!fits(f.bytes)) return false;
      q.front.shift();
      taken.messages.push(f.msg);
      taken.bytes += f.bytes;
    }
    for (const [key, item] of q.items) {
      if (!fits(item.bytes)) return false;
      q.items.delete(key);
      taken.ops.push(...item.ops);
      taken.bytes += item.bytes;
    }
    return true;
  }

  #gc(topic: Topic, q: TopicQueue): void {
    if (q.front.length === 0 && q.items.size === 0) this.#topics.delete(topic);
  }
}
