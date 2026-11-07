// A small stand-in for the kernel, enough to set the plugin up and drive it: commands by id (each run
// records its args and caller), events, list points, the http service, a scope with real timers, and a
// clock. The kernel's own host replaces this once @wisp/kernel exports one.

import type { Caller, Disposable, EventEnvelope, HttpRequestContext, HttpResult, PluginContext, PluginId, RouteOptions, Scope } from '@wisp/kernel';
import { AGENT_TOKENS } from '@wisp-plugin/mcp-api';
import { readFileSync } from 'node:fs';

const manifest: unknown = JSON.parse(readFileSync(new URL('../wisp-plugin.json', import.meta.url), 'utf8'));

type Handler = (args: unknown, caller: Caller) => unknown;

export interface Fake {
  ctx: PluginContext;
  handlers: Map<string, Handler>;
  calls: { cmd: string; args: unknown; caller: Caller }[];
  routes: { method: string; pattern: string; handler: (r: HttpRequestContext) => Promise<HttpResult> | HttpResult; opts: RouteOptions }[];
  points: Map<string, unknown[]>;
  emit(type: string, data: unknown): void;
  scope: Scope;
  commands: Map<string, { run(a: unknown, call: unknown): unknown; parse?: (a: unknown) => unknown }>;
  /** runs one of this plugin's own commands as `caller` */
  own<R>(cmd: string, args: unknown, caller: Caller): Promise<R>;
}

export function makeScope(): Scope {
  const ac = new AbortController();
  const items: (() => void)[] = [];
  const scope: Scope = {
    get signal() {
      return ac.signal;
    },
    get alive() {
      return !ac.signal.aborted;
    },
    add(d: Disposable | (() => void)) {
      items.push(typeof d === 'function' ? d : () => d.dispose());
    },
    child() {
      const c = makeScope();
      items.push(() => c.dispose());
      return c;
    },
    timeout(ms: number, fn: () => void) {
      const t = setTimeout(fn, ms);
      items.push(() => clearTimeout(t));
    },
    interval(ms: number, fn: () => void) {
      const t = setInterval(fn, ms);
      items.push(() => clearInterval(t));
    },
    dispose() {
      if (ac.signal.aborted) return;
      ac.abort();
      for (const f of items.splice(0).reverse()) f();
    },
  };
  return scope;
}

export function fake(o: { tokens?: boolean; harnesses?: unknown[] } = {}): Fake {
  const handlers = new Map<string, Handler>();
  const calls: Fake['calls'] = [];
  const routes: Fake['routes'] = [];
  const points = new Map<string, unknown[]>([['runtime.harness', o.harnesses ?? []]]);
  const listeners = new Map<string, ((e: EventEnvelope) => void | Promise<void>)[]>();
  const commands: Fake['commands'] = new Map();
  const scope = makeScope();
  let seq = 0;
  const runAs = async <R>(cmd: string, args: unknown, caller: Caller): Promise<R> => {
    calls.push({ cmd, args, caller });
    const own = commands.get(cmd);
    if (own) return (await own.run(own.parse ? own.parse(args) : args, callCtx(caller))) as R;
    const h = handlers.get(cmd);
    if (!h) throw Object.assign(new Error(`no command ${cmd}`), { code: 'not_found' });
    return (await h(args, caller)) as R;
  };
  const callCtx = (caller: Caller): unknown => ({ ...ctx, trace: { root: 'r', depth: 1, stack: [], caller, signal: scope.signal }, run: (c: string, a: unknown) => runAs(c, a, caller), runHook: async (_h: string, c: unknown) => c });
  const http = {
    url: 'http://127.0.0.1:4545',
    route(method: string | readonly string[], pattern: string, handler: Fake['routes'][number]['handler'], opts: RouteOptions) {
      routes.push({ method: String(method), pattern, handler, opts });
      return { dispose() {} };
    },
    raw() {
      return { dispose() {} };
    },
  };
  const ctx = {
    id: 'wisp.mcp' as PluginId,
    manifest,
    scope,
    clock: { now: () => Date.now() },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    settings: { get: () => undefined, watch: () => ({ dispose() {} }) },
    service: (name: string) => {
      if (name === 'http') return http;
      throw new Error(`no service ${name}`);
    },
    use: () => {
      throw new Error('use');
    },
    tryUse: (ref: { id: string }) => (ref.id === AGENT_TOKENS.id && o.tokens !== false ? { sessionToken: (id: string) => `tok-${id}` } : undefined),
    provide() {},
    command: (def: { id: string; run(a: unknown, call: unknown): unknown; parse?: (a: unknown) => unknown }) => void commands.set(def.id, def),
    intercept() {},
    on: (type: string, fn: (e: EventEnvelope) => void) => void listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    emit() {},
    contribute: (point: string, item: unknown) => void points.set(point, [...(points.get(point) ?? []), item]),
    contributions: (point: string) => points.get(point) ?? [],
    run: <R>(cmd: string, args?: unknown, call?: { caller?: Caller }) => runAs<R>(cmd, args, call?.caller ?? { set: 'plugin:wisp.mcp' }),
  } as unknown as PluginContext;
  return {
    ctx,
    handlers,
    calls,
    routes,
    points,
    scope,
    commands,
    own: (cmd, args, caller) => runAs(cmd, args, caller),
    emit(type, data) {
      for (const fn of listeners.get(type) ?? []) void fn({ seq: ++seq, type, plugin: 'wisp.runtime' as PluginId, at: Date.now(), data });
    },
  };
}

export const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));
