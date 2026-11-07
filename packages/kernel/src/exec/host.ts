// The exec tier (plan §6.7 tier 3): a plugin as a subprocess speaking JSON-RPC over stdio. Its code
// never runs in the kernel; this bridge registers what it asks for through an ordinary
// PluginContext, so the same permission checks, scopes and traces apply. A dead child turns the
// plugin off with the reason, and the kernel restarts it with a backoff.
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn as nodeSpawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { CallContext, DeepReadonly, Json, Manifest, PluginContext, PluginDef, PluginId, Trace, Verdict } from '../contract.ts';
import { fail } from '../errors.ts';
import { isObj } from '../manifest-check.ts';
import { noMethod, RpcPeer } from './rpc.ts';

export interface ChildProcessLike {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'exit', fn: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', fn: (err: Error) => void): unknown;
}

export interface ExecOptions {
  spawn?: (cmd: string, args: readonly string[], opts: { cwd?: string; env: NodeJS.ProcessEnv }) => ChildProcessLike;
  /** first restart after this many ms, doubling each time (1000 by default) */
  restartBaseMs?: number;
  maxRestarts?: number;
  /** how long the child may take to finish setup (10 s by default) */
  initTimeoutMs?: number;
}

export interface ExecEntry {
  id: PluginId;
  manifest: DeepReadonly<Manifest> | Manifest;
  root: string | undefined;
}

export interface CrashSink {
  crashed(id: string, why: string): void;
}

/** What the child sees of a call: plain data, plus the token that continues it. */
export const traceData = (t: Trace): Json => ({ root: t.root, depth: t.depth, stack: [...t.stack], caller: { ...t.caller } as Json, readOnly: t.readOnly === true });

interface Live {
  call: CallContext;
  /** runs a function in the call's async context, so emits wait for its commit */
  inCall: <R>(fn: () => R) => R;
}

const defaultSpawn: NonNullable<ExecOptions['spawn']> = (cmd, args, opts) => nodeSpawn(cmd, [...args], { ...opts, stdio: ['pipe', 'pipe', 'pipe'] });

export function execPluginDef(entry: ExecEntry, sink: CrashSink, o: ExecOptions = {}): PluginDef {
  return { id: entry.id, setup: (ctx) => startChild(entry, sink, o, ctx) };
}

async function startChild(entry: ExecEntry, sink: CrashSink, o: ExecOptions, ctx: PluginContext): Promise<void> {
  const server = entry.manifest.server;
  if (!server || !('exec' in server)) throw fail('invalid', `${entry.id} has no exec command`);
  const [cmd = '', ...args] = server.exec;
  const child = (o.spawn ?? defaultSpawn)(cmd, args, { ...(entry.root && { cwd: entry.root }), env: { ...process.env, WISP_PLUGIN: entry.id } });
  if (!child.stdin || !child.stdout) throw fail('internal', `${entry.id}: the child has no stdio`);
  const calls = new Map<string, Live>();
  let n = 0;
  const bridge = new Bridge(ctx, calls);
  const peer = new RpcPeer(child.stdout, child.stdin, (m, p) => bridge.handle(m, p));
  bridge.peer = peer;
  let stopping = false;
  let lines = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (s: string) => {
    lines += s;
    for (let i = lines.indexOf('\n'); i >= 0; i = lines.indexOf('\n')) (ctx.log.warn(`[${entry.id}] ${lines.slice(0, i)}`), (lines = lines.slice(i + 1)));
  });
  const died = (why: string): void => {
    peer.close(why);
    if (!stopping) sink.crashed(entry.id, why);
  };
  child.on('exit', (code, signal) => died(`${entry.id}'s process exited (${signal ?? `code ${code}`})`));
  child.on('error', (e) => died(`${entry.id}'s process failed: ${e.message}`));
  ctx.scope.add(() => {
    stopping = true;
    peer.close(`${entry.id} is off`);
    child.kill();
  });
  bridge.token = (call: CallContext) => {
    const t = `c${++n}`;
    calls.set(t, { call, inCall: AsyncLocalStorage.snapshot() });
    return t;
  };
  const settings = Object.fromEntries((entry.manifest.contributes?.settings ?? []).map((s) => [s.key, ctx.settings.get(s.key) ?? null]));
  for (const key of Object.keys(settings)) ctx.settings.watch(key, (value) => peer.notify('settings.changed', { key, value: value ?? null }));
  const ms = o.initTimeoutMs ?? 10_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, no) => (timer = setTimeout(() => no(fail('timeout', `${entry.id} didn't finish setup within ${ms} ms`)), ms)));
  try {
    await Promise.race([peer.request('initialize', { id: entry.id, manifest: entry.manifest as unknown as Json, settings }), late]);
  } catch (e) {
    stopping = true;
    child.kill();
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

class Bridge {
  peer: RpcPeer | undefined;
  token: (call: CallContext) => string = () => '';
  readonly #ctx: PluginContext;
  readonly #calls: Map<string, Live>;
  readonly #proxies = new Map<string, Record<string, unknown>>();

  constructor(ctx: PluginContext, calls: Map<string, Live>) {
    this.#ctx = ctx;
    this.#calls = calls;
  }

  /** Forward a call into the child; the token lets it run nested commands inside this trace. */
  async #into(call: CallContext, method: string, params: Record<string, unknown>): Promise<unknown> {
    const t = this.token(call);
    try {
      return await (this.peer?.request(method, { ...params, call: t, trace: traceData(call.trace) }) ?? Promise.reject(fail('unavailable', 'no child')));
    } finally {
      this.#calls.delete(t);
    }
  }

  #live(p: Record<string, unknown>): Live | undefined {
    return typeof p['call'] === 'string' ? this.#calls.get(p['call']) : undefined;
  }

  handle(method: string, params: unknown): unknown {
    const p = isObj(params) ? params : {};
    const ctx = this.#ctx;
    const live = this.#live(p);
    const inCall = <R>(fn: () => R): R => (live ? live.inCall(fn) : fn());
    switch (method) {
      case 'command.register':
        return ctx.command({
          id: String(p['id']),
          ...(p['readOnly'] === true && { readOnly: true }),
          ...(typeof p['permission'] === 'string' && { permission: p['permission'] }),
          run: (args, call) => this.#into(call, 'command.run', { id: p['id'], args }),
        });
      case 'intercept.register':
        return ctx.intercept({
          hook: String(p['hook']),
          ...(typeof p['priority'] === 'number' && { priority: p['priority'] }),
          ...((p['failure'] === 'open' || p['failure'] === 'closed') && { failure: p['failure'] }),
          ...(typeof p['timeoutMs'] === 'number' && { timeoutMs: p['timeoutMs'] }),
          run: (c, call) => this.#into(call, 'intercept.run', { n: p['n'], ctx: c }) as Promise<Verdict>,
        });
      case 'on':
        return ctx.on(String(p['type']), (e) => this.peer?.request('event', { n: p['n'], e }).then(() => undefined));
      case 'emit':
        return inCall(() => ctx.emit(String(p['type']), (p['data'] ?? null) as Json));
      case 'contribute':
        return ctx.contribute(String(p['point']), p['item']);
      case 'run':
        return live ? live.call.run(String(p['cmd']), p['args']) : ctx.run(String(p['cmd']), p['args']);
      case 'hook':
        if (!live) throw fail('invalid', 'a hook runs inside a call');
        return live.call.runHook(String(p['hook']), p['ctx']);
      case 'service.call':
        return inCall(() => this.#serviceCall(p));
      case 'settings.get':
        return ctx.settings.get(String(p['key'])) ?? null;
      case 'log': {
        const level = p['level'] === 'debug' || p['level'] === 'info' || p['level'] === 'error' ? p['level'] : 'warn';
        return ctx.log[level](String(p['msg']), (p['data'] ?? undefined) as Json);
      }
      default:
        throw noMethod(method);
    }
  }

  /** The child names a contract by id and major; permissions come from the provider, never the child. */
  #serviceCall(p: Record<string, unknown>): unknown {
    const id = String(p['service']);
    const major = Number(p['major']);
    const key = `${id}@${major}`;
    let proxy = this.#proxies.get(key);
    if (!proxy) {
      proxy = this.#ctx.use<Record<string, unknown>>({ id, major, permissions: {} });
      this.#proxies.set(key, proxy);
    }
    const fn = proxy[String(p['method'])];
    if (typeof fn !== 'function') throw fail('not_found', `${key} has no method ${String(p['method'])}`);
    const out = (fn as (...a: unknown[]) => unknown)(...(Array.isArray(p['args']) ? p['args'] : []));
    return Promise.resolve(out).then((r) => {
      if (r !== undefined && r !== null && typeof r === 'object' && Object.values(r).some((v) => typeof v === 'function')) throw fail('invalid', `${key}.${String(p['method'])} returned a handle, which can't cross a process boundary`);
      return r ?? null;
    });
  }
}
