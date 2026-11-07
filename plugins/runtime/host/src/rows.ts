// A task and its turns as rows, and back (schema.ts). The columns are what queries read; whatever
// else the runtime keeps goes in `data` whole, so a field v1 added later round-trips without a
// migration. A turn's activity is never in its row: it is the event log (persist.ts).

import type { Json } from '@wisp/kernel';
import type { Change, Presentation, Session, Stats, Step, Turn } from './model.ts';
import { isMode } from './model.ts';
import type { EventRow, SessionRow, TurnRow } from './schema.ts';
import { EVENT_V } from './schema.ts';

type Obj = Record<string, unknown>;

const SESSION_COLS = new Set(['id', 'title', 'agent', 'model', 'effort', 'mode', 'cwd', 'state', 'unread', 'archived', 'parentId', 'createdAt', 'updatedAt', 'queue', 'turns', 'ext']);
const TURN_COLS = new Set(['id', 'prompt', 'status', 'startedAt', 'endedAt', 'presentation', 'stats', 'raw', 'activity', 'ext']);

function rest(o: object, cols: ReadonlySet<string>): Obj {
  const out: Obj = {};
  // by key, not Object.entries: a lazy `activity` getter would load the whole log
  for (const k of Object.keys(o)) if (!cols.has(k)) {
    const v = (o as Obj)[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export function sessionRow(s: Session): SessionRow {
  return {
    id: s.id,
    title: s.title,
    agent: s.agent,
    model: s.model ?? '',
    effort: s.effort ?? '',
    mode: s.mode,
    cwd: s.cwd ?? '',
    state: s.state,
    unread: !!s.unread,
    archived: !!s.archived,
    parent_id: s.parentId ?? null,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
    queue: s.queue,
    data: rest(s, SESSION_COLS),
    ext: s.ext ?? {},
  };
}

export function sessionOf(r: SessionRow, turns: Turn[]): Session {
  const data = (r.data ?? {}) as Obj;
  const s = {
    ...data,
    id: r.id,
    title: r.title,
    agent: r.agent,
    model: r.model,
    effort: r.effort,
    mode: isMode(r.mode) ? r.mode : 'auto',
    cwd: r.cwd,
    state: r.state,
    unread: r.unread,
    ...(r.archived && { archived: true }),
    ...(r.parent_id && { parentId: r.parent_id }),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    queue: Array.isArray(r.queue) ? r.queue : [],
    turns,
    ext: (r.ext ?? {}) as Record<string, Json>,
  } as Session;
  s.agentSessionId ??= null;
  s.agentSessions ??= {};
  return s;
}

/** The words of a card (v1 search.js wordsOf): every string in it, its kind and ids aside. */
const SKIP_KEYS = new Set(['type', 'id', 'status', 'tone', 'change', 'device', 'language']);
function wordsOf(v: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 6 || out.length > 400) return out;
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) wordsOf(x, out, depth + 1);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (!SKIP_KEYS.has(k)) wordsOf(x, out, depth + 1);
  return out;
}

const MAX_PIECE = 40_000; // past this a piece is a log, not something to find words in

export function answerText(t: Turn): string | null {
  if (t.status === 'running' || t.status === 'held') return null;
  const text = wordsOf(t.presentation?.blocks ?? []).join('\n').slice(0, MAX_PIECE);
  return text || null;
}

export function turnRow(sessionId: string, idx: number, t: Turn): TurnRow {
  return {
    id: t.id,
    session_id: sessionId,
    idx,
    prompt: String(t.prompt ?? '').slice(0, 200_000),
    status: t.status,
    started_at: t.startedAt,
    ended_at: t.endedAt ?? null,
    presentation: t.presentation ?? null,
    stats: t.stats ?? null,
    raw: typeof t.raw === 'string' ? t.raw : null,
    answer: answerText(t),
    data: rest(t, TURN_COLS),
    ext: t.ext ?? {},
  };
}

/** A turn from its row; `activity` is a getter that reads the log the first time anything asks. */
export function turnOf(r: TurnRow, load: () => Step[]): Turn {
  const data = (r.data ?? {}) as Obj;
  const t = {
    ...data,
    id: r.id,
    prompt: r.prompt,
    status: r.status,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    presentation: (r.presentation ?? null) as Presentation | null,
    stats: (r.stats ?? null) as Stats | null,
    ...(r.raw !== null && { raw: r.raw }),
    ext: (r.ext ?? {}) as Record<string, Json>,
  } as Turn;
  t.changes ??= [] as Change[];
  t.attachments ??= [];
  lazyActivity(t, load);
  return t;
}

export function lazyActivity(t: Turn, load: () => Step[]): void {
  Object.defineProperty(t, 'activity', {
    configurable: true,
    enumerable: true,
    get(): Step[] {
      const list = load();
      Object.defineProperty(t, 'activity', { value: list, writable: true, enumerable: true, configurable: true });
      return list;
    },
    set(v: Step[]) {
      Object.defineProperty(t, 'activity', { value: v, writable: true, enumerable: true, configurable: true });
    },
  });
}

/** Whether a turn's activity is still on disk (not read since it loaded). */
export const activityLoaded = (t: Turn): boolean => !Object.getOwnPropertyDescriptor(t, 'activity')?.get;

export function stepEvent(sessionId: string, turnId: string, seq: number, step: Step): EventRow {
  const { seq: _drop, ...body } = step;
  return { session_id: sessionId, turn_id: turnId, seq, t: step.t, kind: 'step', body, v: EVENT_V };
}

export function setEvent(sessionId: string, turnId: string, seq: number, ref: number, fields: Partial<Step>, t: number): EventRow {
  return { session_id: sessionId, turn_id: turnId, seq, t, kind: 'set', body: { ...fields, ref }, v: EVENT_V };
}

/** A turn's steps from its log rows (oldest first): `set` rows laid over the step they name. */
export function foldEvents(rows: readonly EventRow[]): Step[] {
  const out: Step[] = [];
  const bySeq = new Map<number, Step>();
  for (const r of rows) {
    const body = (r.body ?? {}) as Obj;
    if (r.kind === 'set') {
      const target = bySeq.get(Number(body['ref']));
      if (target) {
        const { ref: _ref, ...fields } = body;
        Object.assign(target, fields);
      }
      continue;
    }
    const step = { ...body, seq: r.seq } as Step;
    bySeq.set(r.seq, step);
    out.push(step);
  }
  return out;
}
