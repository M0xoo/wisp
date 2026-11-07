// A wisp.telemetry on the fake kernel, with a fake runtime (one tour session) and a fake PostHog.
import type { Caller, Json } from '@wisp/kernel';
import type { AgentStatus, Session, Turn } from '@wisp-plugin/runtime-api';
import plugin from '../src/index.ts';
import { Host, KitError } from './harness.ts';

export interface Posted {
  api_key: string;
  batch: { event: string; properties: Record<string, Json> }[];
}

const turn = (idx: number, over: Partial<Turn> = {}): Turn =>
  ({
    id: `t${idx}`,
    sessionId: 's1',
    idx,
    prompt: 'a secret prompt about payroll',
    agent: 'wisp',
    model: '',
    effort: '',
    mode: 'auto',
    attachments: [],
    status: 'done',
    startedAt: 1000,
    endedAt: 4000,
    stats: { inputTokens: 10, outputTokens: 20, costUsd: 0.01 },
    presentation: { blocks: [{ type: 'hero', status: 'done' }, { type: 'text' }, { type: 'text' }], v: 1 },
    ext: {},
    ...over,
  }) as Turn;

export function session(over: Partial<Session> = {}): Session {
  return { id: 's1', title: 'Tour', agent: 'wisp', model: '', effort: '', mode: 'auto', cwd: '/tmp/x', dirs: [], state: 'review', unread: false, archived: false, createdAt: 0, updatedAt: 0, queue: [], ext: {}, ...over } as Session;
}

export interface Fixture {
  host: Host;
  posts: Posted[];
  sessions: Map<string, { s: Session; turns: Turn[] }>;
  online: { value: boolean };
  peerCalls: { machine: string; method: string; path: string; body: unknown }[];
}

export async function start(o: { agents?: AgentStatus[]; settings?: Record<string, Json>; peer?: (body: unknown) => unknown } = {}): Promise<Fixture> {
  const posts: Posted[] = [];
  const online = { value: true };
  const sessions = new Map([['s1', { s: session(), turns: [turn(0), turn(1)] }]]);
  const peerCalls: Fixture['peerCalls'] = [];
  const find = (id: unknown) => {
    const got = sessions.get(String(id));
    if (!got) throw new KitError('not_found', 'no such session');
    return got;
  };
  const net = {
    fetch: async (_url: string, init?: { body?: unknown }): Promise<Response> => {
      if (!online.value) throw new Error('offline');
      posts.push(JSON.parse(String(init?.body)) as Posted);
      return new Response('{}', { status: 200 });
    },
  };
  const host = new Host({
    manifest: new URL('../wisp-plugin.json', import.meta.url),
    services: { net, app: { version: '2.0.0', root: '/opt/wisp', port: () => 4477, shutdown: () => {} } },
    settings: o.settings ?? {},
    commands: {
      'runtime.get': (a) => find((a as { id: string }).id).s,
      'runtime.turns': (a) => find((a as { id: string }).id).turns,
      'runtime.turn.setExt': (a, _c: Caller) => {
        const { id, turnId, plugin: p, value } = a as { id: string; turnId: string; plugin: string; value: Json };
        const t = find(id).turns.find((x) => x.id === turnId);
        if (!t) throw new KitError('not_found', 'no such turn');
        if (value === null) delete t.ext[p];
        else t.ext[p] = value;
        return {};
      },
      'runtime.agents': () => o.agents ?? [],
    },
    provided: o.peer
      ? {
          'machines.peers': {
            json: async (machine: string, method: string, path: string, body: unknown) => (peerCalls.push({ machine, method, path, body }), o.peer?.(body)),
          },
        }
      : {},
  });
  await host.start(plugin);
  return { host, posts, sessions, online, peerCalls };
}

/** Runs `fn` with these environment variables, as v1's tests flipped them around a call. */
export async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const was = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(was)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
  }
}

export const sent = (f: Fixture): Posted['batch'] => f.posts.flatMap((p) => p.batch);
