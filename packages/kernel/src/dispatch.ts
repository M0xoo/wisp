// The command bus and the interceptor chain (plan §6.1b, §6.11.2). Every call carries a trace: depth
// at most MAX_DEPTH, no re-entering a (plugin, hook) pair, read-only inside interceptors. A root
// command runs in one transaction; its events go out after it commits, and veto follow-ups (`then`)
// run after it settles, each as a new root command speaking for the plugin that vetoed.
import type { Caller, CommandDef, Disposable, InterceptorDef, PluginId, Trace, Verdict } from './contract.ts';
import { fail, KernelError, toKernelError } from './errors.ts';
import type { DispatchHost } from './host-types.ts';
import { localName, ownerPrefix, uuidv7 } from './ids.ts';
import { current, detached, type ActiveCall, type RootState } from './trace-context.ts';

/** Calls nest at most this deep: a call at depth MAX_DEPTH is refused with `depth_exceeded`. */
export const MAX_DEPTH = 8;
export const INTERCEPTOR_TIMEOUT_MS = 200;
export const INTERCEPTOR_TIMEOUT_MAX_MS = 2000;
export const KERNEL_ID = 'wisp.kernel' as PluginId;

export interface RunRequest {
  cmd: string;
  args: unknown;
  /** the plugin whose context made the call; absent for a call from the edge */
  from?: PluginId;
  /** who the call speaks for; from the edge it is required, from a plugin it can only narrow */
  caller?: Caller;
  parent?: ActiveCall;
}

interface Registered {
  owner: PluginId;
  def: CommandDef<unknown, unknown>;
  permission: string;
}

interface Hooked {
  owner: PluginId;
  def: InterceptorDef<unknown>;
  order: number;
}

/** `runtime.start` owned by `wisp.runtime` needs `runtime:start` unless it names its own permission. */
export const defaultPermission = (owner: string, cmd: string): string => `${ownerPrefix(owner)}:${localName(cmd, owner)}`;

export class Dispatcher {
  readonly #host: DispatchHost;
  readonly #commands = new Map<string, Registered>();
  readonly #hooks = new Map<string, Hooked[]>();
  readonly #pending = new Set<Promise<unknown>>();
  #order = 0;

  constructor(host: DispatchHost) {
    this.#host = host;
  }

  addCommand(owner: PluginId, def: CommandDef<unknown, unknown>): Disposable {
    const had = this.#commands.get(def.id);
    if (had) throw fail('conflict', `${def.id} is already registered by ${had.owner}`);
    const reg = { owner, def, permission: def.permission ?? defaultPermission(owner, def.id) };
    this.#commands.set(def.id, reg);
    return { dispose: () => this.#commands.get(def.id) === reg && this.#commands.delete(def.id) };
  }

  addInterceptor(owner: PluginId, def: InterceptorDef<unknown>): Disposable {
    const h: Hooked = { owner, def, order: this.#order++ };
    this.#hooks.set(def.hook, [...(this.#hooks.get(def.hook) ?? []), h]);
    return { dispose: () => this.#hooks.set(def.hook, (this.#hooks.get(def.hook) ?? []).filter((x) => x !== h)) };
  }

  commandOwner(cmd: string): PluginId | undefined {
    return this.#commands.get(cmd)?.owner;
  }
  commandsOf(plugin: string): string[] {
    return [...this.#commands.values()].filter((r) => r.owner === plugin).map((r) => r.def.id);
  }
  interceptorsOf(plugin: string): number {
    let n = 0;
    for (const list of this.#hooks.values()) n += list.filter((h) => h.owner === plugin).length;
    return n;
  }

  get busy(): boolean {
    return this.#pending.size > 0;
  }

  /** Resolves when no follow-up is still running. */
  async idle(): Promise<void> {
    while (this.#pending.size) await Promise.allSettled([...this.#pending]);
  }

  #refuse(code: string, message: string, plugin: string, stack: readonly string[]): KernelError {
    this.#host.diagnostics.refuse({ at: this.#host.clock.now(), plugin, kind: 'command', code, message, stack });
    this.#host.log.warn(message, { code, stack: [...stack] });
    return fail(code, message);
  }

  async run(req: RunRequest): Promise<unknown> {
    let reg = this.#commands.get(req.cmd);
    if (!reg) {
      await this.#host.activateForCommand(req.cmd, req.args);
      reg = this.#commands.get(req.cmd);
    }
    const parent = req.parent;
    const who = req.from ?? 'edge';
    const stack = [...(parent?.trace.stack ?? []), `${reg?.owner ?? '?'}:${req.cmd}`];
    if (!reg) throw this.#refuse('not_found', `unknown command ${req.cmd} (is its plugin off?)`, who, stack);
    if (!this.#host.isActive(reg.owner)) throw this.#refuse('plugin_off', `${req.cmd}: ${reg.owner} is off`, who, stack);
    const depth = parent ? parent.trace.depth + 1 : 0;
    if (depth >= MAX_DEPTH) throw this.#refuse('depth_exceeded', `${req.cmd} would run at depth ${depth}: calls nest at most ${MAX_DEPTH} deep (${stack.join(' → ')})`, who, stack);
    if (parent?.trace.stack.includes(stack[stack.length - 1] ?? '')) throw this.#refuse('reentrant_hook', `${req.cmd} is already running in this call (${stack.join(' → ')})`, who, stack);
    if (parent?.trace.readOnly && !reg.def.readOnly) throw this.#refuse('forbidden', `${req.cmd} writes, and an interceptor may only read`, who, stack);
    const denied = this.#denied(req, reg.permission);
    if (denied) throw this.#refuse('forbidden', `${req.cmd} refused: ${denied}`, who, stack);
    const caller = req.caller ?? parent?.trace.caller ?? (req.from ? { set: 'plugin', plugin: req.from } : { set: 'user:full' });
    const ac = new AbortController();
    const sig = parent ? AbortSignal.any([parent.trace.signal, ac.signal]) : ac.signal;
    const trace: Trace = { root: parent?.trace.root ?? uuidv7(this.#host.clock.now()), depth, stack, caller, signal: sig, ...(parent?.trace.readOnly && { readOnly: true }) };
    const root: RootState = parent?.root ?? { events: [], followUps: [] };
    const active: ActiveCall = { trace, root, plugin: reg.owner };
    const r = reg;
    const exec = (): Promise<unknown> =>
      current.run(active, async () => {
        let args = req.args;
        if (r.def.parse) {
          try {
            args = r.def.parse(req.args);
          } catch (e) {
            throw fail('invalid', `${req.cmd}: ${toKernelError(e).message}`);
          }
        }
        return r.def.run(args, this.#host.callContext(r.owner, active));
      });
    return parent ? this.#nested(r, exec) : this.#root(r, exec, root, ac);
  }

  #denied(req: RunRequest, permission: string): string | undefined {
    if (req.from) {
      const why = this.#host.checkPlugin(req.from, permission);
      if (why) return why;
    } else if (!req.caller) return 'a call from the edge names who it speaks for';
    return req.caller ? this.#host.checkCaller(req.caller, permission) : undefined;
  }

  async #nested(reg: Registered, exec: () => Promise<unknown>): Promise<unknown> {
    try {
      return await exec();
    } catch (e) {
      throw this.#failed(reg, e);
    }
  }

  async #root(reg: Registered, exec: () => Promise<unknown>, root: RootState, ac: AbortController): Promise<unknown> {
    try {
      const tx = this.#host.transaction;
      const result = tx ? await tx(exec) : await exec();
      // committed: now the world may hear about it
      for (const e of root.events) this.#host.events.publish(e.plugin, e.type, e.data);
      return result;
    } catch (e) {
      throw this.#failed(reg, e);
    } finally {
      ac.abort();
      for (const f of root.followUps.splice(0)) this.#followUp(f);
    }
  }

  #failed(reg: Registered, e: unknown): KernelError {
    const k = toKernelError(e);
    this.#host.diagnostics.record({ at: this.#host.clock.now(), plugin: reg.owner, kind: 'command', code: k.code, message: `${reg.def.id}: ${k.message}` });
    return k;
  }

  #followUp(f: RootState['followUps'][number]): void {
    const p = detached(() => this.run({ cmd: f.cmd, args: f.args, ...(f.caller.plugin && { from: f.caller.plugin }), caller: f.caller }))
      .catch((e: unknown) => {
        const k = toKernelError(e);
        this.#host.log.warn(`follow-up ${f.cmd} failed: ${k.message}`, { code: k.code });
      })
      .finally(() => this.#pending.delete(p));
    this.#pending.add(p);
  }

  #sorted(hook: string): Hooked[] {
    const rnd = this.#host.testHooks?.random;
    const tie = new Map<Hooked, number>();
    const list = (this.#hooks.get(hook) ?? []).filter((h) => this.#host.isActive(h.owner));
    for (const h of list) tie.set(h, rnd ? rnd() : h.order);
    return list.sort((a, b) => (a.def.priority ?? 0) - (b.def.priority ?? 0) || (tie.get(a) ?? 0) - (tie.get(b) ?? 0));
  }

  /** Run `hook`'s interceptors on `value` inside `parent`'s call. */
  async runHook<C>(hook: string, value: C, parent: ActiveCall): Promise<C> {
    let v: unknown = value;
    for (const h of this.#sorted(hook)) {
      const frame = `${h.owner}:${hook}`;
      const stack = [...parent.trace.stack, frame];
      if (parent.trace.stack.includes(frame)) throw this.#refuse('reentrant_hook', `${hook} would run ${h.owner}'s interceptor again inside itself (${stack.join(' → ')})`, h.owner, stack);
      if (parent.trace.depth + 1 >= MAX_DEPTH) throw this.#refuse('depth_exceeded', `${hook} would run at depth ${parent.trace.depth + 1} (${stack.join(' → ')})`, h.owner, stack);
      const verdict = await this.#one(h, v, parent, stack);
      if (verdict.kind === 'modify') v = verdict.ctx;
      else if (verdict.kind === 'veto') {
        for (const t of verdict.then ?? []) parent.root.followUps.push({ cmd: t.cmd, args: t.args, caller: { set: 'plugin', plugin: h.owner } });
        const data = { hook, by: h.owner, code: verdict.code, message: verdict.message, root: parent.trace.root, stack: [...parent.trace.stack] };
        this.#host.events.publish(KERNEL_ID, 'kernel.vetoed', data);
        throw fail('vetoed', verdict.message, { by: h.owner, reason: verdict.code, hook });
      }
    }
    return v as C;
  }

  async #one(h: Hooked, v: unknown, parent: ActiveCall, stack: string[]): Promise<Verdict<unknown>> {
    const ms = Math.min(Math.max(h.def.timeoutMs ?? INTERCEPTOR_TIMEOUT_MS, 1), INTERCEPTOR_TIMEOUT_MAX_MS);
    const ac = new AbortController();
    const trace: Trace = { ...parent.trace, depth: parent.trace.depth + 1, stack, readOnly: true, signal: AbortSignal.any([parent.trace.signal, ac.signal]) };
    const active: ActiveCall = { trace, root: parent.root, plugin: h.owner };
    const t = this.#host.timers;
    let timer: unknown;
    const timeout = new Promise<'timeout'>((r) => (timer = t.setTimeout(() => r('timeout'), ms)));
    const delay = this.#host.testHooks?.interceptorDelay?.(h.owner, h.def.hook) ?? 0;
    const work = current.run(active, async () => {
      if (delay > 0) await new Promise<void>((r) => t.setTimeout(r, delay));
      return h.def.run(v, this.#host.callContext(h.owner, active));
    });
    try {
      const out = await Promise.race([work, timeout]);
      if (out === 'timeout') return this.#broken(h, 'timeout', `${h.owner} didn't answer ${h.def.hook} within ${ms} ms`, stack);
      if (!isVerdict(out)) return this.#broken(h, 'invalid', `${h.owner} answered ${h.def.hook} with something that isn't a verdict`, stack);
      return out;
    } catch (e) {
      const k = toKernelError(e);
      return this.#broken(h, k.code, `${h.owner} failed on ${h.def.hook}: ${k.message}`, stack);
    } finally {
      t.clearTimeout(timer);
      ac.abort();
      work.catch(() => undefined); // a timed-out interceptor that fails later is already accounted for
    }
  }

  /** A guard (failure closed) vetoes; anything else is skipped with a warning. */
  #broken(h: Hooked, code: string, message: string, stack: readonly string[]): Verdict<unknown> {
    this.#host.diagnostics.record({ at: this.#host.clock.now(), plugin: h.owner, kind: 'interceptor', code, message, stack });
    if (h.def.failure === 'closed') return { kind: 'veto', code, message };
    this.#host.log.warn(`${message}; skipped (failure open)`, { code });
    return { kind: 'continue' };
  }
}

function isVerdict(v: unknown): v is Verdict<unknown> {
  if (typeof v !== 'object' || v === null) return false;
  const k = (v as { kind?: unknown }).kind;
  if (k === 'continue') return true;
  if (k === 'modify') return 'ctx' in v;
  if (k !== 'veto') return false;
  const x = v as { code?: unknown; message?: unknown; then?: unknown };
  return typeof x.code === 'string' && typeof x.message === 'string' && (x.then === undefined || Array.isArray(x.then));
}
