// A small fake kernel for this plugin's tests (@wisp/testkit has no generic plugin harness yet): one
// plugin's PluginContext over an in-memory store, with commands (other plugins' faked by `commands`),
// events, points, settings from the manifest, services, a fake clock whose timers belong to the scope,
// and the `http` service as a route table the tests call like the edge does (v1 `{ error }` on a throw).
// No network: `net` is whatever the test passes.
import { readFileSync } from 'node:fs';
import type { CallContext, Caller, CommandDef, Disposable, EventEnvelope, Json, Manifest, PluginContext, PluginDef, PluginId, Scope, ServiceRef } from '@wisp/kernel';
import { openStore, type Store } from '@wisp/store';

type Handler = (c: Req) => Promise<{ status: number; json: Json }> | { status: number; json: Json };
interface Req {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  caller: Caller;
  body(): Promise<unknown>;
}
interface Route {
  method: string;
  parts: string[];
  handler: Handler;
  permission: string;
}

export class FakeClock {
  t = Date.UTC(2026, 10, 7, 9, 0, 0);
  timers: { at: number; every: number; fn: () => void; alive: boolean }[] = [];
  now = (): number => this.t;
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      const next = this.timers.filter((x) => x.alive && x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.t = Math.max(this.t, next.at);
      if (next.every) next.at += next.every;
      else next.alive = false;
      next.fn();
      await settle();
    }
    this.t = end;
  }
}

export const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

class FakeScope implements Scope {
  readonly #ac = new AbortController();
  readonly items: Disposable[] = [];
  #alive = true;
  readonly clock: FakeClock;
  constructor(clock: FakeClock) {
    this.clock = clock;
  }
  get signal(): AbortSignal {
    return this.#ac.signal;
  }
  get alive(): boolean {
    return this.#alive;
  }
  add(d: Disposable | (() => void)): void {
    const item = typeof d === 'function' ? { dispose: d } : d;
    if (this.#alive) this.items.push(item);
    else item.dispose();
  }
  child(): Scope {
    const c = new FakeScope(this.clock);
    this.add(c);
    return c;
  }
  #timer(ms: number, every: number, fn: () => void): void {
    const t = { at: this.clock.t + ms, every, fn, alive: true };
    this.clock.timers.push(t);
    this.add(() => (t.alive = false));
  }
  timeout(ms: number, fn: () => void): void {
    this.#timer(ms, 0, fn);
  }
  interval(ms: number, fn: () => void): void {
    this.#timer(ms, ms, fn);
  }
  dispose(): void {
    if (!this.#alive) return;
    this.#alive = false;
    this.#ac.abort();
    for (const d of this.items.splice(0).reverse()) d.dispose();
  }
}

export class KitError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface HostOptions {
  manifest: string | URL;
  services?: Record<string, unknown>;
  /** other plugins' commands, faked */
  commands?: Record<string, (args: unknown, caller: Caller) => unknown>;
  /** other plugins' services, by contract id */
  provided?: Record<string, unknown>;
  settings?: Record<string, Json>;
  store?: Store;
}

const STATUS: Record<string, number> = { invalid: 400, forbidden: 403, not_found: 404, conflict: 409, vetoed: 409 };

export class Host {
  readonly clock = new FakeClock();
  readonly scope: FakeScope;
  readonly store: Store;
  readonly manifest: Manifest;
  readonly routes: Route[] = [];
  readonly commands = new Map<string, CommandDef<unknown, unknown>>();
  readonly fakes: Record<string, (args: unknown, caller: Caller) => unknown>;
  readonly ran: { cmd: string; args: unknown; caller: Caller }[] = [];
  readonly emitted: { type: string; data: Json }[] = [];
  readonly subs: { type: string; fn: (e: EventEnvelope) => void | Promise<void> }[] = [];
  readonly contributed = new Map<string, unknown[]>();
  readonly provided = new Map<string, unknown>();
  readonly settings = new Map<string, Json>();
  readonly logs: string[] = [];
  #seq = 0;
  ctx!: PluginContext; // set by start(), before any test reads it

  readonly o: HostOptions;
  constructor(o: HostOptions) {
    this.o = o;
    this.manifest = JSON.parse(readFileSync(o.manifest, 'utf8')) as Manifest;
    this.scope = new FakeScope(this.clock);
    this.store = o.store ?? openStore({ path: ':memory:', clock: { now: () => this.clock.now() } });
    this.fakes = { ...(o.commands ?? {}) };
    for (const [k, v] of Object.entries(o.provided ?? {})) this.provided.set(k, v);
    for (const [k, v] of Object.entries(o.settings ?? {})) this.settings.set(k, v);
  }

  async start(plugin: PluginDef): Promise<this> {
    this.ctx = this.#context();
    await plugin.setup(this.ctx);
    return this;
  }

  #services(): Record<string, unknown> {
    const http = { route: (method: string, pattern: string, handler: Handler, opts: { permission: string }): Disposable => this.#route(method, pattern, handler, opts.permission) };
    return { store: this.store, http, ...(this.o.services ?? {}) };
  }

  #route(method: string, pattern: string, handler: Handler, permission: string): Disposable {
    const r: Route = { method, parts: pattern.split('/').filter(Boolean), handler, permission };
    this.routes.push(r);
    return { dispose: () => void this.routes.splice(this.routes.indexOf(r), 1) };
  }

  #context(): PluginContext {
    const services = this.#services();
    const id = this.manifest.id as PluginId;
    return {
      id,
      manifest: this.manifest,
      scope: this.scope,
      clock: { now: this.clock.now },
      log: { debug: (m) => this.logs.push(m), info: (m) => this.logs.push(m), warn: (m) => this.logs.push(m), error: (m) => this.logs.push(m) },
      settings: {
        get: <T extends Json>(key: string) => (this.settings.get(key) ?? this.#decl(key)?.default) as T | undefined,
        watch: () => ({ dispose: () => {} }),
      },
      service: <T>(name: string): T => {
        if (!(name in services)) throw new KitError('not_found', `no kernel service ${name}`);
        return services[name] as T;
      },
      use: <T>(ref: ServiceRef<T>): T => {
        const s = this.provided.get(ref.id);
        if (!s) throw new KitError('service_gone', `nobody provides ${ref.id}`);
        return s as T;
      },
      tryUse: <T>(ref: ServiceRef<T>): T | undefined => this.provided.get(ref.id) as T | undefined,
      provide: (ref, impl) => {
        this.provided.set(ref.id, impl);
        this.scope.add(() => this.provided.delete(ref.id));
      },
      command: (def) => {
        const declared = (this.manifest.contributes?.commands ?? []).some((c) => c.id === def.id);
        if (!declared) throw new KitError('invalid', `${def.id} isn't in the manifest's contributes.commands`);
        this.commands.set(def.id, def as CommandDef<unknown, unknown>);
        this.scope.add(() => this.commands.delete(def.id));
      },
      intercept: () => {},
      on: (type, fn) => {
        const sub = { type, fn: fn as (e: EventEnvelope) => void | Promise<void> };
        this.subs.push(sub);
        this.scope.add(() => void this.subs.splice(this.subs.indexOf(sub), 1));
      },
      emit: (type, data) => void this.emitted.push({ type, data }),
      contribute: (point, item) => {
        const list = this.contributed.get(point) ?? [];
        list.push(item);
        this.contributed.set(point, list);
      },
      contributions: <T>(point: string) => (this.contributed.get(point) ?? []) as T[],
      run: <R>(cmd: string, args?: unknown, call?: { caller?: Caller }) => this.run<R>(cmd, args, call?.caller ?? { set: `plugin:${id}`, plugin: id }),
    };
  }

  #decl(key: string): { default?: Json } | undefined {
    return this.manifest.contributes?.settings?.find((s) => s.key === key);
  }

  async run<R>(cmd: string, args: unknown, caller: Caller = { set: 'user:full' }): Promise<R> {
    this.ran.push({ cmd, args, caller });
    const def = this.commands.get(cmd);
    if (def) {
      const parsed = def.parse ? def.parse(args) : args;
      const call = { ...this.ctx, trace: { root: 'r', depth: 1, stack: [], caller, signal: this.scope.signal }, run: <X>(c: string, a?: unknown) => this.run<X>(c, a, caller), runHook: async <C>(_h: string, c: C) => c } as CallContext;
      return (await def.run(parsed, call)) as R;
    }
    const fake = this.fakes[cmd];
    if (!fake) throw new KitError('not_found', `no command ${cmd}`);
    return (await fake(args, caller)) as R;
  }

  /** Delivers an event to this plugin's subscribers, as the kernel would after a commit. */
  async deliver<T>(type: string, data: T): Promise<void> {
    const e: EventEnvelope<T> = { seq: ++this.#seq, type, plugin: 'wisp.runtime' as PluginId, at: this.clock.now(), data };
    for (const s of this.subs.filter((x) => x.type === type)) await s.fn(e);
  }

  /** Calls a route as the edge does: `/api/...`, JSON in, v1's `{ error }` with its status on a throw. */
  async call(method: string, url: string, body?: unknown, caller: Caller = { set: 'user:full' }): Promise<{ status: number; json: Record<string, unknown> & Json }> {
    const [p = '', qs = ''] = url.split('?');
    const parts = p.replace(/^\/api/, '').split('/').filter(Boolean);
    for (const r of this.routes) {
      if (r.method !== method || r.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      if (!r.parts.every((seg, i) => (seg.startsWith(':') ? ((params[seg.slice(1)] = decodeURIComponent(parts[i] ?? '')), true) : seg === parts[i]))) continue;
      const req: Req = { method, path: p, params, query: new URLSearchParams(qs), headers: {}, caller, body: async () => body ?? {} };
      try {
        const res = await r.handler(req);
        return { status: res.status, json: res.json as Record<string, unknown> & Json };
      } catch (e) {
        const rec = e as { status?: unknown; code?: unknown; message?: unknown };
        const status = typeof rec.status === 'number' ? rec.status : (STATUS[String(rec.code)] ?? 500);
        return { status, json: { error: String(rec.message ?? e) } };
      }
    }
    return { status: 404, json: { error: `no route ${method} ${p}` } };
  }

  /** What a leak check reads: everything the plugin registered is gone once its scope is. */
  stop(): void {
    this.scope.dispose();
  }
}
