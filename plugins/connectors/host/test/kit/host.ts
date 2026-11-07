// A small in-memory kernel for plugin tests: commands, interceptors, events, points, settings,
// services (store, http, notify, secrets, paths, net, proc) and scopes on a fake clock, plus a fake
// wisp.runtime that keeps sessions in memory. It follows packages/kernel/src/contract.ts; once
// @wisp/testkit ships its plugin harness, these tests move to it (this file is a copy of
// plugins/crew/host/test/kit/host.ts, plus `spawn`/`which` options: connectors start their servers).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore } from '@wisp/store';
import type { Store } from '@wisp/store';
import type {
  CallContext, Caller, CommandDef, DeepReadonly, Disposable, EventEnvelope, HttpRequestContext, HttpResult, InterceptorDef, Json, Manifest,
  PluginContext, PluginDef, PluginId, ProcService, RouteOptions, Scope, ServiceRef, SpawnOptions, Trace, Verdict,
} from '@wisp/kernel';

export class KitError extends Error {
  readonly code: string;
  readonly details: Json | undefined;
  constructor(code: string, message: string, details?: Json) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

// ---------- fake clock and timers ----------

interface Timer {
  id: number;
  at: number;
  every: number;
  fn: () => void;
}

export class FakeClock {
  #now: number;
  #seq = 0;
  readonly timers = new Map<number, Timer>();
  constructor(now = Date.UTC(2026, 10, 2, 9, 0, 0)) {
    this.#now = now;
  }
  now(): number {
    return this.#now;
  }
  set(now: number): void {
    this.#now = now;
  }
  add(ms: number, fn: () => void, every = 0): number {
    const id = ++this.#seq;
    this.timers.set(id, { id, at: this.#now + Math.max(0, ms), every, fn });
    return id;
  }
  clear(id: number): void {
    this.timers.delete(id);
  }
  /** moves time forward, firing due timers in order and letting their promises settle between */
  async advance(ms: number): Promise<void> {
    const end = this.#now + ms;
    for (;;) {
      let next: Timer | undefined;
      for (const t of this.timers.values()) if (t.at <= end && (!next || t.at < next.at || (t.at === next.at && t.id < next.id))) next = t;
      if (!next) break;
      this.#now = Math.max(this.#now, next.at);
      if (next.every > 0) next.at += next.every;
      else this.timers.delete(next.id);
      next.fn();
      await settle();
    }
    this.#now = end;
    await settle();
  }
}

/** lets queued microtasks and immediate callbacks run (event delivery, async handlers) */
export async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
}

class KitScope implements Scope {
  readonly #ac = new AbortController();
  readonly #items: Disposable[] = [];
  readonly #clock: FakeClock;
  #alive = true;
  constructor(clock: FakeClock) {
    this.#clock = clock;
  }
  get signal(): AbortSignal {
    return this.#ac.signal;
  }
  get alive(): boolean {
    return this.#alive;
  }
  add(d: Disposable | (() => void)): void {
    const item = typeof d === 'function' ? { dispose: d } : d;
    if (!this.#alive) item.dispose();
    else this.#items.push(item);
  }
  child(_name: string): Scope {
    const c = new KitScope(this.#clock);
    this.add(c);
    return c;
  }
  timeout(ms: number, fn: () => void): void {
    const id = this.#clock.add(ms, fn);
    this.add(() => this.#clock.clear(id));
  }
  interval(ms: number, fn: () => void): void {
    const id = this.#clock.add(ms, fn, ms);
    this.add(() => this.#clock.clear(id));
  }
  dispose(): void {
    if (!this.#alive) return;
    this.#alive = false;
    this.#ac.abort();
    for (const d of this.#items.splice(0).reverse()) d.dispose();
  }
}

// ---------- fake http ----------

interface Route {
  method: string[];
  parts: string[];
  handler: (ctx: HttpRequestContext) => Promise<HttpResult> | HttpResult;
  opts: RouteOptions;
}

export interface KitResponse {
  status: number;
  json: unknown;
  text?: string;
}

function matchRoute(parts: string[], url: string[]): Record<string, string> | undefined {
  if (parts.length !== url.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] ?? '';
    const u = url[i] ?? '';
    if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(u);
    else if (p !== u) return undefined;
  }
  return params;
}

export class FakeHttp {
  readonly routes: Route[] = [];
  readonly url = 'http://127.0.0.1:7777';
  readonly service = {
    url: this.url,
    route: (method: string | readonly string[], pattern: string, handler: Route['handler'], opts: RouteOptions): Disposable => this.#add(method, `/api${pattern}`, handler, opts),
    raw: (method: string | readonly string[], pattern: string, handler: Route['handler'], opts: RouteOptions): Disposable => this.#add(method, pattern, handler, opts),
  };
  #add(method: string | readonly string[], pattern: string, handler: Route['handler'], opts: RouteOptions): Disposable {
    const r: Route = { method: typeof method === 'string' ? [method] : [...method], parts: pattern.split('/').filter(Boolean), handler, opts };
    this.routes.push(r);
    return { dispose: () => void this.routes.splice(this.routes.indexOf(r), 1) };
  }
  /** `request('POST', '/api/crew', { body })`: the route's answer, or 404 */
  async request(method: string, url: string, o: { body?: unknown; raw?: Uint8Array; headers?: Record<string, string>; caller?: Caller } = {}): Promise<KitResponse> {
    const u = new URL(url, this.url);
    const segs = u.pathname.split('/').filter(Boolean);
    for (const r of this.routes) {
      if (!r.method.includes(method)) continue;
      const params = matchRoute(r.parts, segs);
      if (!params || (r.opts.when && !r.opts.when(params))) continue;
      const raw = o.raw ?? new TextEncoder().encode(o.body === undefined ? '' : JSON.stringify(o.body));
      const ctx: HttpRequestContext = {
        method, path: u.pathname, params, query: u.searchParams, headers: o.headers ?? {},
        caller: o.caller ?? { set: 'user:full' },
        body: async () => (o.body !== undefined ? structuredClone(o.body) : raw.length ? JSON.parse(new TextDecoder().decode(raw)) : {}),
        rawBody: async () => raw,
        raw: { req: null, res: null },
      };
      try {
        const res = await r.handler(ctx);
        if ('stream' in res) return { status: 200, json: null };
        if ('json' in res) return { status: res.status, json: structuredClone(res.json) };
        if ('text' in res) return { status: res.status, json: null, text: res.text };
        return { status: res.status, json: null, text: new TextDecoder().decode(res.bytes) };
      } catch (e) {
        const err = e as { code?: string; message?: string; status?: number };
        const status = err.status ?? ({ not_found: 404, invalid: 400, forbidden: 403, conflict: 409, vetoed: 409, unavailable: 503 } as Record<string, number>)[err.code ?? ''] ?? 500;
        return { status, json: { error: err.message ?? String(e), code: err.code ?? 'internal' } };
      }
    }
    return { status: 404, json: { error: 'no route' } };
  }
}

// ---------- the host ----------

interface Plugin {
  id: PluginId;
  manifest: DeepReadonly<Manifest>;
  scope: KitScope;
  ctx: PluginContext;
}

export interface Notice {
  kind: string;
  data: Json;
}

export interface HostOptions {
  now?: number;
  settings?: Record<string, Json>;
  /** answers the net service's fetch; default: 404 */
  fetch?: (url: string, init?: RequestInit) => Promise<Response> | Response;
  /** answers the proc service's exec; default: exit 127 */
  exec?: (bin: string, args: readonly string[], opts?: { cwd?: string; input?: string }) => Promise<{ code: number | null; stdout: string; stderr: string }> | { code: number | null; stdout: string; stderr: string };
  /** answers the proc service's spawn; default: refused */
  spawn?: ProcService['spawn'];
  /** answers the proc service's which; default: the name as given */
  which?: ProcService['which'];
}

export class TestHost {
  readonly clock: FakeClock;
  readonly store: Store;
  readonly http = new FakeHttp();
  readonly home: string;
  readonly notices: Notice[] = [];
  readonly events: EventEnvelope[] = [];
  readonly settings = new Map<string, Json>();
  readonly secrets = new Map<string, string>();
  readonly commands = new Map<string, { plugin: PluginId; def: CommandDef<unknown, unknown> }>();
  readonly calls: { cmd: string; args: unknown; caller: Caller }[] = [];
  readonly #interceptors: { plugin: PluginId; def: InterceptorDef<unknown> }[] = [];
  readonly #listeners = new Map<string, { plugin: PluginId; fn: (e: EventEnvelope) => void | Promise<void> }[]>();
  readonly #points = new Map<string, { plugin: PluginId; item: unknown }[]>();
  readonly #services = new Map<string, { plugin: PluginId; impl: unknown }>();
  readonly #watchers = new Map<string, Set<(v: Json | undefined) => void>>();
  readonly plugins = new Map<string, Plugin>();
  readonly #opts: HostOptions;
  #seq = 0;
  #pending: Promise<void>[] = [];

  constructor(opts: HostOptions = {}) {
    this.#opts = opts;
    this.clock = new FakeClock(opts.now);
    this.store = openStore({ path: ':memory:', clock: this.clock });
    this.home = mkdtempSync(path.join(tmpdir(), 'wisp-kit-'));
    for (const [k, v] of Object.entries(opts.settings ?? {})) this.settings.set(k, v);
  }

  /** set a setting the way Settings would, telling its watchers */
  set(key: string, value: Json | undefined): void {
    if (value === undefined) this.settings.delete(key);
    else this.settings.set(key, value);
    for (const fn of this.#watchers.get(key) ?? []) fn(value);
  }

  async load(def: PluginDef, manifest?: Partial<Manifest>): Promise<PluginContext> {
    const m = { wispPlugin: 1, id: def.id, version: '2.0.0', api: '^1', ...manifest } as Manifest;
    for (const s of m.contributes?.settings ?? []) if (!this.settings.has(s.key) && s.default !== undefined) this.settings.set(s.key, s.default);
    const scope = new KitScope(this.clock);
    const ctx = this.#context(def.id as PluginId, m, scope);
    this.plugins.set(def.id, { id: def.id as PluginId, manifest: m, scope, ctx });
    await def.setup(ctx);
    return ctx;
  }

  /** switching a plugin off: its scope goes, and with it everything it registered */
  unload(id: string): void {
    const p = this.plugins.get(id);
    if (!p) return;
    p.scope.dispose();
    this.plugins.delete(id);
  }

  /** run a command as `caller` (the user, by default) */
  run<R = unknown>(cmd: string, args?: unknown, caller: Caller = { set: 'user:full' }): Promise<R> {
    return this.#run<R>(cmd, args, { root: `t${++this.#seq}`, depth: 0, stack: [], caller, signal: new AbortController().signal });
  }

  /** an event from outside the plugins under test (the fake runtime uses it too) */
  emit(type: string, data: unknown, plugin = 'wisp.runtime'): void {
    const e: EventEnvelope = { seq: ++this.#seq, type, plugin: plugin as PluginId, at: this.clock.now(), data };
    this.events.push(e);
    for (const l of this.#listeners.get(type) ?? []) {
      // delivered after the caller's work, in order, like the kernel's per-plugin queues
      this.#pending.push(Promise.resolve().then(() => l.fn(e)).catch((err: unknown) => console.error(`[kit] ${l.plugin} on ${type} threw`, err)));
    }
  }

  /** waits until every delivered event's handler (and what it started) has finished */
  async flush(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      await settle(2);
      const p = this.#pending.splice(0);
      if (!p.length) return;
      await Promise.all(p);
    }
  }

  /** time passes: due scope timers fire, then handlers settle */
  async advance(ms: number): Promise<void> {
    await this.clock.advance(ms);
    await this.flush();
  }

  contributions<T>(point: string): T[] {
    return (this.#points.get(point) ?? []).map((c) => c.item as T);
  }

  service<T>(id: string): T | undefined {
    return this.#services.get(id)?.impl as T | undefined;
  }

  async runHook<C>(hook: string, c: C, trace: Trace): Promise<C> {
    const list = this.#interceptors.filter((i) => i.def.hook === hook).sort((a, b) => (a.def.priority ?? 100) - (b.def.priority ?? 100));
    let cur = c;
    for (const i of list) {
      const call = this.#callContext(i.plugin, { ...trace, readOnly: true, depth: trace.depth + 1, stack: [...trace.stack, `${i.plugin}:${hook}`] });
      let v: Verdict<unknown>;
      try {
        v = await i.def.run(structuredClone(cur), call);
      } catch (e) {
        if (i.def.failure === 'closed') throw new KitError('vetoed', `${i.plugin} failed closed: ${(e as Error).message}`, { by: i.plugin, reason: 'failed' });
        continue;
      }
      if (v.kind === 'modify') cur = v.ctx as C;
      if (v.kind === 'veto') {
        for (const t of v.then ?? []) this.#pending.push(this.run(t.cmd, t.args).then(() => undefined, () => undefined));
        throw new KitError('vetoed', v.message, { by: i.plugin, reason: v.code });
      }
    }
    return cur;
  }

  /** a root call made by `plugin` (what its own timers and listeners run under) */
  rootCall(plugin: string, caller: Caller = { set: `plugin:${plugin}`, plugin: plugin as PluginId }): CallContext {
    return this.#callContext(plugin as PluginId, { root: `t${++this.#seq}`, depth: 0, stack: [], caller, signal: new AbortController().signal });
  }

  dispose(): void {
    for (const id of [...this.plugins.keys()].reverse()) this.unload(id);
    this.store.close();
    rmSync(this.home, { recursive: true, force: true });
  }

  async #run<R>(cmd: string, args: unknown, trace: Trace): Promise<R> {
    const c = this.commands.get(cmd);
    if (!c) throw new KitError('not_found', `no command ${cmd}`);
    if (trace.depth > 8) throw new KitError('depth_exceeded', `${cmd} at depth ${trace.depth}`);
    if (trace.readOnly && !c.def.readOnly) throw new KitError('forbidden', `${cmd} writes, and an interceptor may only read`);
    this.calls.push({ cmd, args, caller: trace.caller });
    const parsed = c.def.parse ? c.def.parse(args) : args;
    return (await c.def.run(parsed, this.#callContext(c.plugin, trace))) as R;
  }

  #callContext(plugin: PluginId, trace: Trace): CallContext {
    const base = this.plugins.get(plugin)?.ctx ?? this.#context(plugin, { wispPlugin: 1, id: plugin, version: '0.0.0', api: '^1' }, new KitScope(this.clock));
    return {
      ...base,
      trace,
      run: <R>(cmd: string, a?: unknown) => this.#run<R>(cmd, a, { ...trace, depth: trace.depth + 1 }),
      runHook: <C>(hook: string, c: C) => this.runHook(hook, c, trace),
    } as CallContext;
  }

  #context(id: PluginId, manifest: DeepReadonly<Manifest>, scope: KitScope): PluginContext {
    const log = { debug: () => {}, info: () => {}, warn: () => {}, error: (msg: string) => console.error(`[${id}] ${msg}`) };
    const services: Record<string, unknown> = {
      store: this.store,
      http: this.http.service,
      notify: { notice: (kind: string, data: Json) => void this.notices.push({ kind, data }) },
      secrets: {
        get: async (k: string) => this.secrets.get(k),
        set: async (k: string, v: string) => void this.secrets.set(k, v),
        delete: async (k: string) => void this.secrets.delete(k),
        keys: async (p = '') => [...this.secrets.keys()].filter((k) => k.startsWith(p)),
      },
      paths: { home: this.home, dir: (...parts: string[]) => path.join(this.home, 'plugins', id, ...parts) },
      net: { fetch: async (url: string, init?: RequestInit) => (this.#opts.fetch ? this.#opts.fetch(url, init) : new Response('not found', { status: 404 })) },
      proc: {
        which: async (bin: string, env?: Record<string, string | undefined>) => (this.#opts.which ? this.#opts.which(bin, env) : bin),
        exec: async (bin: string, args: readonly string[], o?: { cwd?: string; input?: string }) => ({ timedOut: false, ...(await (this.#opts.exec?.(bin, args, o) ?? { code: 127, stdout: '', stderr: `${bin}: not found` })) }),
        spawn: (bin: string, args: readonly string[], o?: SpawnOptions) => {
          if (!this.#opts.spawn) throw new KitError('unavailable', 'the kit has no spawn');
          return this.#opts.spawn(bin, args, o);
        },
      },
    };
    const ctx: PluginContext = {
      id, manifest, scope, clock: this.clock, log,
      settings: {
        get: <T extends Json>(key: string) => this.settings.get(key) as T | undefined,
        watch: (key: string, fn: (v: Json | undefined) => void) => {
          const set = this.#watchers.get(key) ?? new Set();
          this.#watchers.set(key, set);
          set.add(fn);
          const d = { dispose: () => void set.delete(fn) };
          scope.add(d);
          return d;
        },
      },
      service: <T>(name: string): T => {
        if (!(name in services)) throw new KitError('not_found', `no kernel service ${name}`);
        return services[name] as T;
      },
      use: <T>(ref: ServiceRef<T>): T => {
        const s = this.#services.get(ref.id);
        if (!s) throw new KitError('service_gone', `nobody provides ${ref.id}`);
        return s.impl as T;
      },
      tryUse: <T>(ref: ServiceRef<T>): T | undefined => this.#services.get(ref.id)?.impl as T | undefined,
      provide: <T>(ref: ServiceRef<T>, impl: T): void => {
        this.#services.set(ref.id, { plugin: id, impl });
        scope.add(() => this.#services.get(ref.id)?.plugin === id && this.#services.delete(ref.id));
      },
      command: <A, R>(def: CommandDef<A, R>): void => {
        this.commands.set(def.id, { plugin: id, def: def as CommandDef<unknown, unknown> });
        scope.add(() => this.commands.get(def.id)?.plugin === id && this.commands.delete(def.id));
      },
      intercept: <C>(def: InterceptorDef<C>): void => {
        const entry = { plugin: id, def: def as InterceptorDef<unknown> };
        this.#interceptors.push(entry);
        scope.add(() => void this.#interceptors.splice(this.#interceptors.indexOf(entry), 1));
      },
      on: <T>(type: string, fn: (e: EventEnvelope<T>) => void | Promise<void>): void => {
        const list = this.#listeners.get(type) ?? [];
        this.#listeners.set(type, list);
        const entry = { plugin: id, fn: fn as (e: EventEnvelope) => void | Promise<void> };
        list.push(entry);
        scope.add(() => void list.splice(list.indexOf(entry), 1));
      },
      emit: <T extends Json>(type: string, data: T): void => this.emit(type, data, id),
      contribute: <T>(point: string, item: T): void => {
        const list = this.#points.get(point) ?? [];
        this.#points.set(point, list);
        const entry = { plugin: id, item };
        list.push(entry);
        scope.add(() => void list.splice(list.indexOf(entry), 1));
      },
      contributions: <T>(point: string): readonly T[] => this.contributions<T>(point),
      run: <R>(cmd: string, args?: unknown, call?: Partial<Pick<Trace, 'caller'>>): Promise<R> =>
        this.#run<R>(cmd, args, { root: `t${++this.#seq}`, depth: 0, stack: [], caller: call?.caller ?? { set: `plugin:${id}`, plugin: id }, signal: scope.signal }),
    };
    return ctx;
  }
}
