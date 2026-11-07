// A small stand-in for the kernel, for the git plugins' tests: several plugins on one bus, with
// commands, interceptors, events, services by contract, settings, scopes and the http edge. It
// follows packages/kernel/src/contract.ts; when the kernel's own plugin harness lands, these tests
// can move to it unchanged (they only touch PluginContext).

import { readFile } from 'node:fs/promises';
import type {
  CallContext,
  CommandDef,
  DeepReadonly,
  Disposable,
  EventEnvelope,
  HttpRequestContext,
  HttpResult,
  HttpService,
  InterceptorDef,
  Json,
  Manifest,
  PluginContext,
  PluginId,
  RouteOptions,
  Scope,
  ServiceRef,
  Trace,
} from '@wisp/kernel';

class TestScope implements Scope {
  readonly #ac = new AbortController();
  readonly #items: Disposable[] = [];
  #alive = true;
  get signal(): AbortSignal {
    return this.#ac.signal;
  }
  get alive(): boolean {
    return this.#alive;
  }
  get size(): number {
    return this.#items.length;
  }
  add(d: Disposable | (() => void)): void {
    const item = typeof d === 'function' ? { dispose: d } : d;
    if (this.#alive) this.#items.push(item);
    else item.dispose();
  }
  child(): Scope {
    const c = new TestScope();
    this.add(c);
    return c;
  }
  timeout(ms: number, fn: () => void): void {
    const h = setTimeout(fn, ms);
    this.add(() => clearTimeout(h));
  }
  interval(ms: number, fn: () => void): void {
    const h = setInterval(fn, ms);
    this.add(() => clearInterval(h));
  }
  dispose(): void {
    if (!this.#alive) return;
    this.#alive = false;
    this.#ac.abort();
    for (const d of this.#items.splice(0).reverse()) d.dispose();
  }
}

interface Route {
  method: string;
  parts: string[];
  handler: (c: HttpRequestContext) => Promise<HttpResult> | HttpResult;
  opts: RouteOptions;
  plugin: string;
}

export interface CallOptions {
  body?: unknown;
  query?: Record<string, string | string[]>;
  caller?: { set: string; session?: string };
}

export interface HttpReply {
  status: number;
  json: unknown;
}

const statusOf = (e: unknown): number => {
  const o = (typeof e === 'object' && e !== null ? e : {}) as Record<string, unknown>;
  if (typeof o['status'] === 'number') return o['status'];
  const code = o['code'];
  return code === 'invalid' ? 400 : code === 'not_found' ? 404 : code === 'conflict' ? 409 : code === 'forbidden' || code === 'vetoed' ? 403 : 500;
};

export class Bus {
  readonly commands = new Map<string, { def: CommandDef<unknown, unknown>; ctx: PluginContext }>();
  readonly hooks = new Map<string, { def: InterceptorDef<unknown>; ctx: PluginContext }[]>();
  readonly listeners = new Map<string, ((e: EventEnvelope) => void | Promise<void>)[]>();
  readonly events: EventEnvelope[] = [];
  readonly provided = new Map<string, unknown>();
  readonly kernel = new Map<string, unknown>();
  readonly settings = new Map<string, Json>();
  readonly routes: Route[] = [];
  readonly scopes: TestScope[] = [];
  readonly notices: { kind: string; data: Json }[] = [];
  readonly points = new Map<string, unknown[]>();
  readonly pending = new Set<Promise<unknown>>();
  now: () => number = () => Date.now();
  #seq = 0;

  constructor(services: Record<string, unknown> = {}) {
    for (const [k, v] of Object.entries(services)) this.kernel.set(k, v);
    if (!this.kernel.has('http')) this.kernel.set('http', this.#http('kernel'));
    if (!this.kernel.has('notify')) this.kernel.set('notify', { notice: (kind: string, data: Json) => this.notices.push({ kind, data }) });
  }

  /** A plugin's context on this bus. */
  plugin(id: string, manifest: Partial<Manifest> = {}): PluginContext & { scope: TestScope } {
    const scope = new TestScope();
    this.scopes.push(scope);
    const bus = this;
    const m = { wispPlugin: 1, id, version: '2.0.0', api: '^1', ...manifest } as DeepReadonly<Manifest>;
    const ctx: PluginContext & { scope: TestScope } = {
      id: id as PluginId,
      manifest: m,
      scope,
      clock: { now: () => bus.now() },
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      settings: {
        get: <T extends Json>(key: string): T | undefined => bus.settings.get(key) as T | undefined,
        watch: () => ({ dispose: () => {} }),
      },
      service: <T>(name: string): T => {
        const s = name === 'http' ? bus.#http(id) : bus.kernel.get(name);
        if (s === undefined) throw Object.assign(new Error(`no kernel service ${name} in this test`), { code: 'unavailable' });
        return s as T;
      },
      use: <T>(ref: ServiceRef<T>): T => {
        const s = bus.provided.get(ref.id);
        if (s === undefined) throw Object.assign(new Error(`${ref.id} is not provided`), { code: 'service_gone' });
        return s as T;
      },
      tryUse: <T>(ref: ServiceRef<T>): T | undefined => bus.provided.get(ref.id) as T | undefined,
      provide: <T>(ref: ServiceRef<T>, impl: T): void => {
        bus.provided.set(ref.id, impl);
        scope.add(() => bus.provided.delete(ref.id));
      },
      command: <A, R>(def: CommandDef<A, R>): void => {
        bus.commands.set(def.id, { def: def as CommandDef<unknown, unknown>, ctx });
        scope.add(() => bus.commands.delete(def.id));
      },
      intercept: <C>(def: InterceptorDef<C>): void => {
        const list = bus.hooks.get(def.hook) ?? [];
        list.push({ def: def as InterceptorDef<unknown>, ctx });
        list.sort((a, b) => (a.def.priority ?? 0) - (b.def.priority ?? 0));
        bus.hooks.set(def.hook, list);
      },
      on: <T>(type: string, fn: (e: EventEnvelope<T>) => void | Promise<void>): void => {
        const list = bus.listeners.get(type) ?? [];
        list.push(fn as (e: EventEnvelope) => void);
        bus.listeners.set(type, list);
      },
      emit: <T extends Json>(type: string, data: T): void => bus.emit(id, type, data),
      contribute: <T>(point: string, item: T): void => {
        const list = bus.points.get(point) ?? [];
        list.push(item);
        bus.points.set(point, list);
        scope.add(() => list.splice(list.indexOf(item), 1));
      },
      contributions: <T>(point: string): readonly T[] => (bus.points.get(point) ?? []) as T[],
      run: <R>(cmd: string, args?: unknown, call?: Partial<Pick<Trace, 'caller'>>): Promise<R> => bus.run<R>(cmd, args, call?.caller),
    };
    return ctx;
  }

  emit(plugin: string, type: string, data: unknown): void {
    const e: EventEnvelope = { seq: ++this.#seq, type, plugin: plugin as PluginId, at: this.now(), data };
    this.events.push(e);
    for (const fn of this.listeners.get(type) ?? []) {
      // after the emitter's call returns, as the kernel delivers after commit
      const p = Promise.resolve().then(() => fn(e)).catch(() => {});
      this.pending.add(p);
      void p.finally(() => this.pending.delete(p));
    }
  }

  /** Every queued event handler (and what they started) has run. */
  async settle(): Promise<void> {
    for (let i = 0; i < 50 && this.pending.size; i++) await Promise.all([...this.pending]);
  }

  async run<R>(cmd: string, args?: unknown, caller: { set: string; session?: string } = { set: 'user:full' }, depth = 0): Promise<R> {
    const c = this.commands.get(cmd);
    if (!c) throw Object.assign(new Error(`no command ${cmd}`), { code: 'not_found' });
    const parsed = c.def.parse ? c.def.parse(args) : args;
    return (await c.def.run(parsed, this.#call(c.ctx, caller, depth))) as R;
  }

  #call(ctx: PluginContext, caller: { set: string; session?: string }, depth: number): CallContext {
    const trace: Trace = { root: 'test', depth, stack: [], caller, signal: new AbortController().signal };
    return {
      ...ctx,
      trace,
      run: <R>(cmd: string, args?: unknown): Promise<R> => this.run<R>(cmd, args, caller, depth + 1),
      runHook: async <C>(hook: string, hctx: C): Promise<C> => {
        let cur = hctx;
        for (const h of this.hooks.get(hook) ?? []) {
          const v = await h.def.run(cur, this.#call(h.ctx, caller, depth + 1));
          if (v.kind === 'modify') cur = v.ctx as C;
          else if (v.kind === 'veto') throw Object.assign(new Error(v.message), { code: 'vetoed', details: { by: h.ctx.id, reason: v.code } });
        }
        return cur;
      },
    };
  }

  #http(plugin: string): HttpService {
    const add = (method: string | readonly string[], pattern: string, handler: Route['handler'], opts: RouteOptions): Disposable => {
      const methods = typeof method === 'string' ? [method] : method;
      const made = methods.map((m) => ({ method: m, parts: pattern.split('/').filter(Boolean), handler, opts, plugin }));
      this.routes.push(...made);
      return { dispose: () => made.forEach((r) => this.routes.splice(this.routes.indexOf(r), 1)) };
    };
    return { route: add, raw: add, url: 'http://127.0.0.1:0' };
  }

  /** Call a route as the edge would: the v1 shape back ({ error } with its status on a throw). */
  async call(method: string, url: string, o: CallOptions = {}): Promise<HttpReply> {
    const [p = '', qs = ''] = url.split('?');
    const parts = p.replace(/^\/api/, '').split('/').filter(Boolean);
    for (const r of this.routes) {
      if (r.method !== method || r.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      if (!r.parts.every((seg, i) => (seg.startsWith(':') ? ((params[seg.slice(1)] = decodeURIComponent(parts[i] ?? '')), true) : seg === parts[i]))) continue;
      if (r.opts.when && !r.opts.when(params)) continue;
      const query = new URLSearchParams(qs);
      for (const [k, v] of Object.entries(o.query ?? {})) for (const x of [v].flat()) query.append(k, x);
      const ctx: HttpRequestContext = {
        method,
        path: p,
        params,
        query,
        headers: {},
        caller: o.caller ?? { set: 'user:full' },
        body: async () => o.body ?? {},
        rawBody: async () => new TextEncoder().encode(JSON.stringify(o.body ?? {})),
        raw: { req: null, res: null },
      };
      try {
        const res = await r.handler(ctx);
        if ('json' in res) return { status: res.status, json: res.json };
        if ('text' in res) return { status: res.status, json: res.text };
        if ('bytes' in res) return { status: res.status, json: res.bytes };
        return { status: 200, json: null };
      } catch (e) {
        return { status: statusOf(e), json: { error: e instanceof Error ? e.message : String(e) } };
      }
    }
    return { status: 404, json: { error: `no route ${method} ${p}` } };
  }

  /**
   * Load a plugin host the way the kernel does: by package name, its wisp-plugin.json for the manifest
   * and its default export's setup(ctx). Tests reach a dependency (wisp.git for wisp.worktrees) like
   * this, never by importing another plugin's host.
   */
  async load(pkg: string): Promise<PluginContext & { scope: TestScope }> {
    const manifestUrl = import.meta.resolve(`${pkg}/wisp-plugin.json`);
    const manifest = JSON.parse(await readFile(new URL(manifestUrl), 'utf8')) as Manifest;
    const mod = (await import(import.meta.resolve(pkg))) as { default?: { id: string; setup(ctx: PluginContext): void | Promise<void> } };
    if (!mod.default) throw new Error(`${pkg} has no default export`);
    const ctx = this.plugin(manifest.id, manifest);
    await mod.default.setup(ctx);
    return ctx;
  }

  dispose(): void {
    for (const s of this.scopes.splice(0).reverse()) s.dispose();
  }
}

export const createBus = (services?: Record<string, unknown>): Bus => new Bus(services);

/** An in-memory blob service: what the store's Blobs offers plugins (put by content, get by hash). */
export function memoryBlobs(): { put(data: Uint8Array | string): { hash: string; size: number }; get(hash: string): Uint8Array | undefined; size: number } {
  const map = new Map<string, Uint8Array>();
  let n = 0;
  return {
    put(data) {
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      const hash = `test:${++n}:${bytes.length}`;
      map.set(hash, bytes);
      return { hash, size: bytes.length };
    },
    get: (hash) => map.get(hash),
    get size() {
      return map.size;
    },
  };
}
