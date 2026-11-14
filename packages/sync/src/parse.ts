// Untrusted input from the wire, checked into typed messages. Anything malformed is null (dropped):
// the sync stream never throws on what a client sends.

import { PROTO, PROTO_MIN, isTopic } from '@wisp/protocol';
import type { ClientMessage, Topic } from '@wisp/protocol';
import type { ConnectQuery } from './types.ts';

export interface ParsedHello {
  protoMin: number;
  protoMax: number;
  clientId: string;
  build: string;
  epoch: string | null;
  cursor: number | null;
  topics: Topic[];
  fresh: Topic[];
  invalid: string[];
  /** 'all', or the topics of this hello that are passive */
  passive: 'all' | Topic[];
}

const int = (s: string | undefined): number | null => {
  if (s === undefined || !/^\d{1,15}$/.test(s)) return null;
  return Number(s);
};

function topicList(s: string | undefined, invalid: string[]): Topic[] {
  if (s === undefined || s === '') return [];
  const out: Topic[] = [];
  for (const t of s.split(',')) {
    if (isTopic(t)) {
      if (!out.includes(t)) out.push(t);
    } else invalid.push(t);
  }
  return out;
}

/** A client that sends no proto window is taken to speak exactly this build's. */
export function parseHello(q: ConnectQuery, fallbackClientId: string): ParsedHello {
  const invalid: string[] = [];
  const topics = topicList(q.topics, invalid);
  const fresh = topicList(q.fresh, invalid).filter((t) => !topics.includes(t));
  return {
    protoMin: int(q.proto_min) ?? PROTO_MIN,
    protoMax: int(q.proto_max) ?? PROTO,
    clientId: q.client_id !== undefined && q.client_id !== '' ? q.client_id.slice(0, 128) : fallbackClientId,
    build: q.build ?? '',
    epoch: q.epoch !== undefined && q.epoch !== '' ? q.epoch : null,
    cursor: int(q.cursor) ?? int(q.last_event_id),
    topics,
    fresh,
    invalid,
    passive: q.passive === '1' || q.passive === 'true' ? 'all' : topicList(q.passive, []),
  };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const nat = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (!isObj(raw)) return null;
  switch (raw['t']) {
    case 'sub': {
      const topic = raw['topic'];
      if (typeof topic !== 'string' || !isTopic(topic)) return null;
      const since = raw['since'];
      if (since !== undefined && !nat(since)) return null;
      return { t: 'sub', topic, ...(since !== undefined && { since }), ...(raw['passive'] === true && { passive: true }) };
    }
    case 'unsub': {
      const topic = raw['topic'];
      return typeof topic === 'string' && isTopic(topic) ? { t: 'unsub', topic } : null;
    }
    case 'window': {
      const { req, topic, before_seq, limit } = raw;
      if (!str(req) || typeof topic !== 'string' || !isTopic(topic) || !nat(before_seq) || !nat(limit)) return null;
      return { t: 'window', req, topic, before_seq, limit: Math.min(limit, 1000) };
    }
    case 'mutate': {
      const { mid, cmd, args, base_seq } = raw;
      if (!str(mid) || !str(cmd)) return null;
      if (base_seq !== undefined && !nat(base_seq)) return null;
      return { t: 'mutate', mid, cmd, args, ...(base_seq !== undefined && { base_seq }) };
    }
    case 'hello': {
      const { proto_min, proto_max, client_id, build } = raw;
      if (!nat(proto_min) || !nat(proto_max) || !str(client_id) || typeof build !== 'string') return null;
      return { t: 'hello', proto_min, proto_max, client_id, build };
    }
    default:
      return null;
  }
}
