// A fake wisp.runtime on a test Bus: sessions in a map, the commands other plugins call (get, list,
// turns, setExt, followUp, setState, markRead) and the events they listen to. Shapes are the runtime
// api's (plugins/runtime/api), written structurally: a package may not import a plugin's api.

import type { Json } from '@wisp/kernel';
import type { Bus } from './bus.ts';

export interface FakeTurn {
  id: string;
  sessionId: string;
  idx: number;
  prompt: string;
  agent: string;
  status: string;
  presentation: { blocks: { type: string; [k: string]: unknown }[]; v: number } | null;
  by?: string;
  [k: string]: unknown;
}

export interface FakeSession {
  id: string;
  title: string;
  agent: string;
  model: string;
  cwd: string;
  state: 'running' | 'review' | 'done' | 'error';
  unread: boolean;
  archived: boolean;
  parentId?: string;
  createdAt: number;
  updatedAt: number;
  queue: { id: string; text: string }[];
  ext: Record<string, Json>;
  turns: FakeTurn[];
  [k: string]: unknown;
}

export interface FakeRuntime {
  sessions: Map<string, FakeSession>;
  followUps: { id: string; text: string; by?: string }[];
  add(s: Partial<FakeSession> & { id: string }): FakeSession;
  /** a turn ended: emits turn.finished as the runtime does after commit */
  finish(id: string, o?: { status?: string; interrupted?: boolean; errorText?: string }): void;
}

interface SummaryField {
  plugin: string;
  fields(session: FakeSession, last: FakeTurn | undefined): Record<string, unknown>;
}

export function fakeRuntime(bus: Bus): FakeRuntime {
  const ctx = bus.plugin('wisp.runtime');
  const sessions = new Map<string, FakeSession>();
  const followUps: FakeRuntime['followUps'] = [];
  const get = (id: unknown): FakeSession => {
    const s = sessions.get(String(id));
    if (!s) throw Object.assign(new Error('no such session'), { code: 'not_found' });
    return s;
  };
  const changed = (s: FakeSession): void => {
    s.updatedAt = bus.now();
    ctx.emit('session.changed', { id: s.id });
  };
  const summary = (s: FakeSession): Record<string, unknown> => {
    const row: Record<string, unknown> = { id: s.id, title: s.title, agent: s.agent, cwd: s.cwd, state: s.state, unread: s.unread, archived: s.archived, createdAt: s.createdAt, updatedAt: s.updatedAt, queued: s.queue.length, ...(s.parentId && { parentId: s.parentId }) };
    for (const f of ctx.contributions<SummaryField>('runtime.summary')) Object.assign(row, f.fields(s, s.turns.at(-1)));
    return row;
  };
  type A = Record<string, unknown>;
  ctx.command({ id: 'runtime.get', readOnly: true, run: (a: A) => get(a['id']) });
  ctx.command({ id: 'runtime.turns', readOnly: true, run: (a: A) => get(a['id']).turns });
  ctx.command({
    id: 'runtime.list',
    readOnly: true,
    run: (a: A) => [...sessions.values()].filter((s) => a['archived'] === undefined || s.archived === a['archived']).map(summary),
  });
  ctx.command({
    id: 'runtime.setExt',
    run: (a: A) => {
      const s = get(a['id']);
      const plugin = String(a['plugin']);
      if (a['value'] === null || a['value'] === undefined) delete s.ext[plugin];
      else s.ext[plugin] = a['value'] as Json;
      changed(s);
      return {};
    },
  });
  ctx.command({
    id: 'runtime.followUp',
    run: (a: A) => {
      const s = get(a['id']);
      followUps.push({ id: s.id, text: String(a['text']), ...(typeof a['by'] === 'string' && { by: a['by'] }) });
      s.state = 'running';
      changed(s);
      return { turnId: `t${followUps.length}` };
    },
  });
  ctx.command({
    id: 'runtime.setState',
    run: (a: A) => {
      const s = get(a['id']);
      s.state = a['state'] as FakeSession['state'];
      changed(s);
      return {};
    },
  });
  ctx.command({
    id: 'runtime.markRead',
    run: (a: A) => {
      const s = get(a['id']);
      s.unread = !!a['unread'];
      changed(s);
      return {};
    },
  });
  return {
    sessions,
    followUps,
    add(o) {
      const now = bus.now();
      const s: FakeSession = { title: 'task', agent: 'claude', model: '', cwd: '', state: 'review', unread: false, archived: false, createdAt: now, updatedAt: now, queue: [], ext: {}, turns: [], ...o };
      sessions.set(s.id, s);
      return s;
    },
    finish(id, o = {}) {
      const s = get(id);
      s.state = o.status === 'error' ? 'error' : 'review';
      const turn = s.turns.at(-1);
      ctx.emit('turn.finished', { sessionId: id, turnId: turn?.id ?? 't0', status: o.status ?? 'done', interrupted: !!o.interrupted, ...(o.errorText && { errorText: o.errorText }), summary: summary(s) as Json });
    },
  };
}
