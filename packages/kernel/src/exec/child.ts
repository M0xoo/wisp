// The exec tier's other half: what a plugin running as a subprocess calls. `serve(def)` gives its
// setup the same PluginContext, carried over JSON-RPC on stdin/stdout. Some calls can't be synchronous
// across a process: `contributions`, `service` and `provide` throw `unavailable` here, and `use`
// returns a proxy whose methods all return promises.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Readable, Writable } from 'node:stream';
import { format } from 'node:util';
import type { CallContext, CommandDef, EventEnvelope, InterceptorDef, Json, Log, Manifest, PluginContext, PluginDef, PluginId, ServiceRef, Trace } from '../contract.ts';
import { fail } from '../errors.ts';
import { isObj } from '../manifest-check.ts';
import { ScopeImpl } from '../scope.ts';
import { noMethod, RpcPeer } from './rpc.ts';

export interface ServeOptions {
  input?: Readable;
  output?: Writable;
}

interface State {
  peer: RpcPeer;
  commands: Map<string, CommandDef<unknown, unknown>>;
  hooks: InterceptorDef<unknown>[];
  subs: ((e: EventEnvelope) => void | Promise<void>)[];
  settings: Map<string, Json | undefined>;
  watchers: Map<string, Set<(v: Json | undefined) => void>>;
  /** registrations in flight: setup isn't done until the kernel has accepted every one */
  pending: Promise<unknown>[];
  ctx: PluginContext | undefined;
}

const token = new AsyncLocalStorage<string>();
const never = new AbortController().signal;

/** Serve `def` over stdio. Resolves when the kernel closes the connection. */
export function serve(def: PluginDef, o: ServeOptions = {}): RpcPeer {
  // stdout is the wire: anything the plugin prints goes to stderr instead
  console.log = (...a: unknown[]) => void process.stderr.write(`${format(...a)}\n`);
  console.info = console.log;
  const st: State = { peer: undefined as unknown as RpcPeer, commands: new Map(), hooks: [], subs: [], settings: new Map(), watchers: new Map(), pending: [], ctx: undefined };
  st.peer = new RpcPeer(o.input ?? process.stdin, o.output ?? process.stdout, (m, p) => handle(def, st, m, isObj(p) ? p : {}));
  return st.peer;
}

function callCtx(st: State, p: Record<string, unknown>): CallContext {
  const t = isObj(p['trace']) ? p['trace'] : {};
  const call = String(p['call'] ?? '');
  const trace: Trace = {
    root: String(t['root'] ?? ''),
    depth: Number(t['depth'] ?? 0),
    stack: Array.isArray(t['stack']) ? t['stack'].map(String) : [],
    caller: isObj(t['caller']) ? { set: String(t['caller']['set'] ?? 'plugin') } : { set: 'plugin' },
    signal: never,
    ...(t['readOnly'] === true && { readOnly: true }),
  };
  const base = st.ctx ?? (() => { throw fail('unavailable', 'not initialized'); })();
  return {
    ...base,
    trace,
    run: <R>(cmd: string, args?: unknown) => st.peer.request('run', { cmd, args, call }) as Promise<R>,
    runHook: <C>(hook: string, c: C) => st.peer.request('hook', { hook, ctx: c, call }) as Promise<C>,
  };
}

async function handle(def: PluginDef, st: State, method: string, p: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case 'initialize': {
      st.ctx = makeCtx(st, p);
      for (const [k, v] of Object.entries(isObj(p['settings']) ? p['settings'] : {})) st.settings.set(k, v as Json);
      await def.setup(st.ctx);
      await Promise.all(st.pending.splice(0));
      return { ok: true };
    }
    case 'command.run': {
      const c = st.commands.get(String(p['id']));
      if (!c) throw fail('not_found', `no command ${String(p['id'])} in this process`);
      const ctx = callCtx(st, p);
      return token.run(String(p['call']), () => c.run(c.parse ? c.parse(p['args']) : p['args'], ctx)) ?? null;
    }
    case 'intercept.run': {
      const h = st.hooks[Number(p['n'])];
      if (!h) throw fail('not_found', `no interceptor ${String(p['n'])}`);
      const ctx = callCtx(st, p);
      return token.run(String(p['call']), () => h.run(p['ctx'], ctx));
    }
    case 'event': {
      const fn = st.subs[Number(p['n'])];
      await fn?.(p['e'] as EventEnvelope);
      return null;
    }
    case 'settings.changed': {
      const key = String(p['key']);
      const v = (p['value'] ?? undefined) as Json | undefined;
      st.settings.set(key, v);
      for (const fn of st.watchers.get(key) ?? []) fn(v);
      return null;
    }
    default:
      throw noMethod(method);
  }
}

function makeCtx(st: State, p: Record<string, unknown>): PluginContext {
  const id = String(p['id']) as PluginId;
  const manifest = (isObj(p['manifest']) ? p['manifest'] : { id }) as unknown as Manifest;
  const req = (m: string, params: Record<string, unknown>): Promise<unknown> => st.peer.request(m, { ...params, call: token.getStore() });
  const register = (m: string, params: Record<string, unknown>): void => void st.pending.push(st.peer.request(m, params));
  const log = (level: keyof Log) => (msg: string, data?: Json) => st.peer.notify('log', { level, msg, ...(data !== undefined && { data }) });
  const scope = new ScopeImpl(id);
  const unavailable = (what: string) => (): never => {
    throw fail('unavailable', `${what} isn't available to an exec plugin`);
  };
  const proxy = <T>(ref: ServiceRef<T>): T =>
    Object.fromEntries(Object.keys(ref.permissions).filter((k) => !k.includes('.')).map((method) => [method, (...args: unknown[]) => req('service.call', { service: ref.id, major: ref.major, method, args })])) as T;
  return {
    id,
    manifest,
    scope,
    clock: { now: Date.now },
    log: { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') },
    settings: {
      get: <T extends Json>(key: string) => st.settings.get(key) as T | undefined,
      watch: (key, fn) => {
        const set = st.watchers.get(key) ?? new Set();
        st.watchers.set(key, set.add(fn));
        const d = { dispose: () => void set.delete(fn) };
        scope.add(d);
        return d;
      },
    },
    service: unavailable('a kernel service'),
    use: proxy,
    tryUse: proxy,
    provide: unavailable('providing a service'),
    command: (def) => {
      st.commands.set(def.id, def as CommandDef<unknown, unknown>);
      register('command.register', { id: def.id, ...(def.readOnly && { readOnly: true }), ...(def.permission && { permission: def.permission }) });
    },
    intercept: (def) => {
      const n = st.hooks.push(def as InterceptorDef<unknown>) - 1;
      register('intercept.register', { n, hook: def.hook, ...(def.priority !== undefined && { priority: def.priority }), ...(def.failure && { failure: def.failure }), ...(def.timeoutMs !== undefined && { timeoutMs: def.timeoutMs }) });
    },
    on: (type, fn) => {
      const n = st.subs.push(fn as (e: EventEnvelope) => void) - 1;
      register('on', { n, type });
    },
    emit: (type, data) => void req('emit', { type, data }).catch(() => undefined),
    contribute: (point, item) => register('contribute', { point, item }),
    contributions: unavailable('reading a list point'),
    run: <R>(cmd: string, args?: unknown) => req('run', { cmd, args }) as Promise<R>,
  };
}
