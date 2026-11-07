// A plugin context without a kernel: commands, interceptors, events, points, services and an http
// registry the test calls like a client would. Just enough of PluginContext for this plugin's setup.
import type { CallContext, EventEnvelope, InterceptorDef, PluginContext, Scope, ServiceRef } from '@wisp/kernel';

type Handler = (c: unknown) => unknown;
interface Route { method: string; pattern: string; handler: Handler; permission: string }

export interface FakeRes { status: number; headers: Record<string, string>; text: string; ended: boolean; close(): void }

function fakeScope(): Scope & { disposed: boolean } {
  const items: (() => void)[] = [];
  const ac = new AbortController();
  const s = {
    disposed: false,
    signal: ac.signal,
    get alive() {
      return !s.disposed;
    },
    add: (d: { dispose(): void } | (() => void)) => void items.push(typeof d === 'function' ? d : () => d.dispose()),
    child: (): Scope => {
      const c = fakeScope();
      items.push(() => c.dispose());
      return c;
    },
    timeout: (ms: number, fn: () => void) => {
      const t = setTimeout(fn, ms);
      t.unref();
      items.push(() => clearTimeout(t));
    },
    interval: (ms: number, fn: () => void) => {
      const t = setInterval(fn, ms);
      t.unref();
      items.push(() => clearInterval(t));
    },
    dispose: () => {
      if (s.disposed) return;
      s.disposed = true;
      ac.abort();
      for (const d of items.splice(0).reverse()) d();
    },
  };
  return s;
}

export function fakeCtx(o: { services: Record<string, unknown>; settings?: Record<string, unknown>; commands?: Record<string, (a: unknown) => unknown> }) {
  const commands = new Map<string, (a: unknown, c: CallContext) => unknown>(Object.entries(o.commands ?? {}).map(([k, f]) => [k, (a: unknown) => f(a)]));
  const hooks: InterceptorDef<unknown>[] = [];
  const handlers = new Map<string, ((e: EventEnvelope<unknown>) => unknown)[]>();
  const points = new Map<string, unknown[]>();
  const provided = new Map<string, unknown>();
  const emitted: { type: string; data: unknown }[] = [];
  const routes: Route[] = [];
  const scope = fakeScope();
  let seq = 0;
  const http = {
    route: (method: string, pattern: string, handler: Handler, opts: { permission: string }) => (routes.push({ method, pattern, handler, permission: opts.permission }), { dispose() {} }),
    raw: () => ({ dispose() {} }),
    url: 'http://127.0.0.1:0',
  };
  const services: Record<string, unknown> = { http, ...o.services };
  const run = async <R>(cmd: string, args?: unknown): Promise<R> => {
    const f = commands.get(cmd);
    if (!f) throw Object.assign(new Error(`no command ${cmd}`), { code: 'not_found' });
    return (await f(args, ctx as unknown as CallContext)) as R;
  };
  const ctx = {
    id: 'wisp.test',
    manifest: {},
    scope,
    clock: { now: () => Date.now() },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    settings: { get: (k: string) => o.settings?.[k], watch: () => ({ dispose() {} }) },
    service: <T>(name: string): T => services[name] as T,
    use: <T>(ref: ServiceRef<T>): T => provided.get(ref.id) as T,
    tryUse: <T>(ref: ServiceRef<T>): T | undefined => provided.get(ref.id) as T | undefined,
    provide: <T>(ref: ServiceRef<T>, impl: T) => void provided.set(ref.id, impl),
    command: (def: { id: string; run(a: unknown, c: CallContext): unknown }) => void commands.set(def.id, (a, c) => def.run(a, c)),
    intercept: (def: InterceptorDef<unknown>) => void hooks.push(def),
    on: (type: string, fn: (e: EventEnvelope<unknown>) => unknown) => void handlers.set(type, [...(handlers.get(type) ?? []), fn]),
    emit: (type: string, data: unknown) => void emitted.push({ type, data }),
    contribute: (point: string, item: unknown) => void points.set(point, [...(points.get(point) ?? []), item]),
    contributions: <T>(point: string): readonly T[] => (points.get(point) ?? []) as T[],
    run,
  };
  const match = (pattern: string, path: string): Record<string, string> | null => {
    const a = pattern.split('/');
    const b = path.split('/');
    if (a.length !== b.length) return null;
    const params: Record<string, string> = {};
    for (let i = 0; i < a.length; i++) {
      const p = a[i] ?? '';
      if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(b[i] ?? '');
      else if (p !== b[i]) return null;
    }
    return params;
  };
  /** Call a route as a client would; an SSE route answers with its raw response. */
  const call = async (method: string, path: string, opts: { body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; json: Record<string, unknown>; res: FakeRes; permission: string }> => {
    const [p, q = ''] = path.split('?');
    const r = routes.find((x) => x.method === method && match(x.pattern, p ?? ''));
    if (!r) throw new Error(`no route ${method} ${path}`);
    let closer = (): void => {};
    const res: FakeRes = { status: 0, headers: {}, text: '', ended: false, close: () => closer() };
    const raw = {
      writeHead: (s: number, h: Record<string, string>) => ((res.status = s), (res.headers = h)),
      write: (s: string) => void (res.text += s),
      end: (s = '') => void ((res.text += s), (res.ended = true)),
      on: (_ev: string, fn: () => void) => void (closer = fn),
    };
    const out = (await r.handler({ method, path: p, params: match(r.pattern, p ?? ''), query: new URLSearchParams(q), headers: opts.headers ?? {}, caller: { set: 'user:full' }, body: async () => opts.body ?? {}, rawBody: async () => new Uint8Array(), raw: { req: {}, res: raw } })) as { status?: number; json?: Record<string, unknown>; stream?: true };
    return { status: out.stream ? res.status : (out.status ?? 0), json: out.json ?? {}, res, permission: r.permission };
  };
  const fire = async (type: string, data: unknown): Promise<void> => {
    for (const f of handlers.get(type) ?? []) await f({ seq: ++seq, type, plugin: 'wisp.runtime' as never, at: Date.now(), data });
  };
  const hook = async (name: string, c: unknown) => {
    for (const h of hooks.filter((x) => x.hook === name)) {
      const v = await h.run(c, ctx as unknown as CallContext);
      if (v.kind !== 'continue') return v;
    }
    return { kind: 'continue' as const };
  };
  return { ctx: ctx as unknown as PluginContext, call, routes, fire, hook, emitted, points, provided, commands, scope, run };
}
