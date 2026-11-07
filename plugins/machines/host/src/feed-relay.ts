// The v1 feed, for a peer that only speaks v1 (plan §7.2.1, the downgrade path): v1 Machines#listen
// and #relay. The whole list first (GET /sessions?here=1), then the whole event stream, marked
// x-wisp-relay so it doesn't keep a cloud computer awake. Rows keep the peer's own ids; the views
// qualify them as `<id>@<machine>` (v1's rewriting, now in one place: qualifySummary).

import type { Json } from '@wisp/kernel';
import { qualify } from '@wisp-plugin/machines-api';
import { errText, readEvents, settle, type Feed, type FeedDeps, type FeedEnd, type FeedStats } from './feed.ts';

export const LIST_TIMEOUT_MS = 5_000;

/**
 * A machine's own session, not one it shows from its own machines. Two wisps that list each other
 * would otherwise pass each task back and forth forever, one "@machine" longer on each lap.
 */
export const ownId = (id: unknown): id is string => typeof id === 'string' && !!id && !id.includes('@');

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : null);

/** v1's own welcome tour and a delegate's run (services/relay.js) aren't listed elsewhere. */
const hidden = (s: Obj): boolean => s['agent'] === 'wisp' || !!s['delegated'];

export interface RelayOptions extends FeedDeps {
  /** a session event, ids already qualified, for whoever shows v1 peers' activity live */
  onEvent(event: string, data: Obj): void;
}

export function startRelayFeed(o: RelayOptions): Feed {
  const stats: FeedStats = { bytes: 0, frames: 0, rows: 0 };
  const end = settle<FeedEnd>();
  let stream: { cancel(): void } | null = null;
  const finish = (e: FeedEnd): void => {
    stream?.cancel();
    end.resolve(e);
  };

  void (async () => {
    try {
      await fetchList(o, stats);
      const res = await o.channel.request({ method: 'GET', path: '/events', headers: { accept: 'text/event-stream', 'x-wisp-relay': '1' }, passive: true, timeoutMs: 90_000 });
      if (res.status !== 200) {
        res.cancel();
        return finish({ reason: 'lost', error: `The event stream answered ${res.status}.` });
      }
      stream = res;
      await readEvents(res, stats, (event, data) => {
        stats.frames++;
        try {
          relay(o, event, JSON.parse(data) as unknown);
        } catch {
          // a frame that isn't JSON: skipped, as v1 did
        }
        return !end.settled();
      });
      finish({ reason: 'lost', error: 'wisp stopped answering there.' });
    } catch (err) {
      finish({ reason: 'lost', error: errText(err) });
    }
  })();

  return { proto: 1, done: end.promise, stats, close: () => finish({ reason: 'closed' }) };
}

/** v1 #ready → sessions({only}): the machine's own sessions, replacing what was kept. */
async function fetchList(o: RelayOptions, stats: FeedStats): Promise<void> {
  const res = await o.channel.request({ method: 'GET', path: '/sessions?here=1', passive: true, timeoutMs: LIST_TIMEOUT_MS });
  const text = await res.text();
  stats.bytes += Buffer.byteLength(text);
  if (res.status >= 400) return;
  let list: unknown;
  try {
    list = JSON.parse(text);
  } catch {
    return;
  }
  if (!Array.isArray(list)) return;
  const rows = list.map(obj).filter((s): s is Obj => s !== null && ownId(s['id']) && !hidden(s));
  stats.rows += rows.length;
  o.mirror.snapshot(o.peer, 'list', rows.map((s) => ({ e: 'session', id: String(s['id']), v: s })));
}

function relay(o: RelayOptions, event: string, raw: unknown): void {
  const d = obj(raw);
  if (!d) return;
  const q = (id: unknown): string => qualify(String(id), o.peer);
  const session = obj(d['session']);
  const subject = event === 'finished' ? session?.['id'] : event === 'activity' || event === 'turn' || event === 'goal-run' ? d['sessionId'] : d['id'];
  if (!ownId(subject)) return;
  if (event === 'summary') {
    if (hidden(d)) return;
    o.mirror.put(o.peer, subject, d);
    return o.onEvent('summary', qualifySummary(o.peer, d));
  }
  if (event === 'activity' || event === 'turn' || event === 'goal-run') return o.onEvent(event, { ...d, sessionId: q(d['sessionId']) });
  if (event === 'finished' && session) {
    if (hidden(session)) return;
    o.mirror.put(o.peer, subject, session);
    return o.onEvent('finished', { ...d, session: qualifySummary(o.peer, session) });
  }
  if (event === 'removed') {
    o.mirror.del(o.peer, subject);
    return o.onEvent('removed', { id: q(d['id']) });
  }
}

export interface MachineTag {
  id: string;
  name: string;
  target: string;
  sandbox?: boolean;
}

/**
 * v1 Machines#summary: a remote summary as this wisp lists it. Project and colour stay the
 * machine's own (the projects plugin maps them to a local project through `machines.proxy`).
 */
export function qualifySummary(mid: string, s: Obj, tag?: MachineTag): Obj {
  const q = (id: unknown): string => qualify(String(id), mid);
  const forked = obj(s['forkedFrom']);
  return {
    ...s,
    id: q(s['id']),
    groupId: s['groupId'] ?? null, // random, and shared across machines when one launch fans out
    ...(s['parentId'] ? { parentId: q(s['parentId']) } : {}),
    ...(forked ? { forkedFrom: { ...forked, id: q(forked['id']) } } : {}),
    ...(Array.isArray(s['forks']) ? { forks: s['forks'].map(q) } : {}),
    ...(Array.isArray(s['group']) ? { group: s['group'].map((x) => qualifySummary(mid, obj(x) ?? {}, tag)) } : {}),
    ...(tag ? { machine: tag as unknown as Json } : {}),
  };
}

/** v1 Machines#session: a whole remote session (turns, children) with its ids qualified. */
export function qualifySession(mid: string, s: Obj, tag?: MachineTag): Obj {
  const q = (id: unknown): string => qualify(String(id), mid);
  const children = obj(s['children']);
  const childSessions = obj(s['childSessions']);
  const turns = Array.isArray(s['turns']) ? s['turns'] : [];
  return {
    ...qualifySummary(mid, s, tag),
    ...(children ? { children: Object.fromEntries(Object.entries(children).map(([k, v]) => [k, q(v)])) } : {}),
    ...(childSessions ? { childSessions: Object.fromEntries(Object.entries(childSessions).map(([k, v]) => [q(k), qualifySession(mid, obj(v) ?? {}, tag)])) } : {}),
    turns: turns.map((raw) => {
      const t = obj(raw) ?? {};
      const dels = Array.isArray(t['delegations']) ? t['delegations'].map((x) => ({ ...(obj(x) ?? {}), sessionId: q(obj(x)?.['sessionId']) })) : null;
      const atts = Array.isArray(t['attachments']) ? t['attachments'].map((x) => ({ ...(obj(x) ?? {}), id: q(obj(x)?.['id']) })) : null;
      return { ...t, ...(dels ? { delegations: dels } : {}), ...(atts ? { attachments: atts } : {}) };
    }),
  };
}
