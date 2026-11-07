// The kernel (ADR-0003, plan §6.1–§6.4): it registers manifests, resolves them, applies their static
// contributions, activates plugin code lazily, and drops a plugin's scope to switch it off, which
// cascades to whatever depends on it. It knows no feature: every name below comes from a manifest.
import { eager, wakes, type ActivationKind } from './activation.ts';
import { CapabilityRegistry, explain, pluginSet, type CapabilitySet } from './capabilities.ts';
import { makeCallContext, makePluginContext, type ContextHost } from './context.ts';
import type { Caller, CallContext, Clock, CommandDef, DeepReadonly, Disposable, InterceptorDef, Log, Manifest, PluginContext, PluginDef, PluginId, PluginState, PluginStatus, Seq, ServiceRef, UiExtensionDecl, UseOptions } from './contract.ts';
import { Diagnostics } from './diagnostics.ts';
import { Dispatcher, KERNEL_ID, type RunRequest } from './dispatch.ts';
import { fail } from './errors.ts';
import { EventBus } from './events.ts';
import { execPluginDef, type ExecOptions } from './exec/host.ts';
import type { PluginGroup } from './group.ts';
import type { TestHooks } from './host-types.ts';
import { asPluginId } from './ids.ts';
import { validateManifest } from './manifest.ts';
import { Points } from './points.ts';
import { resolve, type Resolution } from './resolve.ts';
import { realTimers, ScopeImpl, type Timers } from './scope.ts';
import { kernelServiceProxy, provideService, useService } from './service-host.ts';
import { ServiceTable } from './services.ts';
import { SettingsRegistry, type SettingsBackend } from './settings.ts';
import type { ActiveCall } from './trace-context.ts';

export interface KernelOptions {
  clock?: Clock;
  log?: Log;
  timers?: Timers;
  /** kernel services by name ('store', 'proc', 'fs', …); an install overrides any of them */
  services?: Record<string, unknown>;
  /** method → permission for a kernel service; the plugin's grants are checked on every call */
  servicePermissions?: Record<string, Readonly<Record<string, string>>>;
  /** the store wraps each root command in one transaction; events go out after it commits */
  transaction?: <R>(fn: () => Promise<R>) => Promise<R>;
  capabilities?: CapabilityRegistry;
  settings?: SettingsBackend;
  events?: { cap?: number; attempts?: number; nextSeq?: () => Seq; onLagging?: (plugin: PluginId, fromSeq: Seq) => void };
  diagnosticsSize?: number;
  /** 5 s by default (plan §6.11.2 rule 5) */
  serviceTimeoutMs?: number;
  /** the kernel api version manifests' `api` ranges are matched against */
  api?: string;
  exec?: ExecOptions;
  testHooks?: TestHooks;
}

export interface RegisterOptions {
  def?: PluginDef;
  /** folder the exec command runs in */
  root?: string;
  builtin?: boolean;
  /** false (or a reason) registers it switched off */
  enabled?: boolean | string;
}

export interface Entry {
  id: PluginId;
  manifest: Manifest;
  def: PluginDef | undefined;
  root: string | undefined;
  builtin: boolean;
  state: PluginState;
  reason: string | undefined;
  scope: ScopeImpl | undefined;
  statics: ScopeImpl | undefined;
  ctx: PluginContext | undefined;
  activating: Promise<void> | undefined;
  caps: CapabilitySet;
  restarts: number;
}

export interface LeakReport {
  scope: number;
  commands: number;
  interceptors: number;
  subscriptions: number;
  provided: number;
  handles: number;
  contributions: number;
  queued: number;
}

const silent: Log = { debug() {}, info() {}, warn() {}, error() {} };
const live = (e: Entry | undefined): boolean => e?.state === 'active' || e?.state === 'resolved';

export class Kernel implements ContextHost {
  readonly clock: Clock;
  readonly log: Log;
  readonly timers: Timers;
  readonly diagnostics: Diagnostics;
  readonly events: EventBus;
  readonly points = new Points();
  readonly settings: SettingsRegistry;
  readonly services = new ServiceTable();
  readonly capabilities: CapabilityRegistry;
  readonly testHooks: TestHooks | undefined;
  readonly transaction: (<R>(fn: () => Promise<R>) => Promise<R>) | undefined;
  readonly options: KernelOptions;
  readonly #entries = new Map<string, Entry>();
  readonly #off = new Map<string, string>();
  readonly #choices = new Map<string, string>();
  readonly #dispatch: Dispatcher;
  readonly #scope: ScopeImpl;
  #res: Resolution = { order: [], refused: new Map(), providers: new Map(), deps: new Map() };
  #started = false;

  constructor(o: KernelOptions = {}) {
    this.options = o;
    this.clock = o.clock ?? { now: Date.now };
    this.log = o.log ?? silent;
    this.timers = o.timers ?? realTimers;
    this.diagnostics = new Diagnostics(o.diagnosticsSize);
    this.capabilities = o.capabilities ?? new CapabilityRegistry();
    this.settings = new SettingsRegistry(o.settings);
    this.testHooks = o.testHooks;
    this.transaction = o.transaction;
    this.#scope = new ScopeImpl('kernel', { timers: this.timers });
    this.events = new EventBus({
      ...o.events,
      now: () => this.clock.now(),
      onFailure: (plugin, type, err, seq) => this.diagnostics.record({ at: this.clock.now(), plugin, kind: 'event', code: 'internal', message: `${type} #${seq}: ${err instanceof Error ? err.message : String(err)}` }),
    });
    this.#dispatch = new Dispatcher(this);
  }

  // ---------- registration ----------

  register(manifest: unknown, o: RegisterOptions = {}): PluginId {
    const r = validateManifest(manifest);
    if (!r.ok) {
      const name = typeof manifest === 'object' && manifest !== null && 'id' in manifest ? String(manifest.id) : '?';
      throw fail('invalid', `manifest ${name}: ${r.errors.map((e) => `${e.path || '(root)'}: ${e.message}`).join('; ')}`, { errors: r.errors.map((e) => ({ ...e })) });
    }
    const m = r.manifest;
    if (this.#entries.has(m.id)) throw fail('conflict', `${m.id} is already registered`);
    if (o.def && o.def.id !== m.id) throw fail('invalid', `${m.id}'s host module says it is ${o.def.id}`);
    const id = asPluginId(m.id);
    const trust = m.trust ?? (o.builtin ? 'trusted' : m.server ? 'untrusted' : 'declarative');
    const manifestWithTrust: Manifest = { ...m, trust };
    this.#entries.set(id, { id, manifest: manifestWithTrust, def: o.def, root: o.root, builtin: o.builtin ?? false, state: 'discovered', reason: undefined, scope: undefined, statics: undefined, ctx: undefined, activating: undefined, caps: pluginSet(m), restarts: 0 });
    if (o.enabled === false || typeof o.enabled === 'string') this.#off.set(id, typeof o.enabled === 'string' ? o.enabled : `${id} was switched off`);
    if (this.#started) void this.#sync();
    return id;
  }

  /** Register a plugin group: its disabled plugins keep their slot, switched off. */
  addGroup(group: PluginGroup): PluginId[] {
    return group.entries.map(({ entry, enabled }) =>
      this.register(entry.manifest, { ...(entry.def && { def: entry.def }), ...(entry.root && { root: entry.root }), builtin: entry.builtin ?? true, enabled: enabled || `${entry.manifest.id} is disabled in the group ${group.id}` }),
    );
  }

  async start(): Promise<void> {
    this.#started = true;
    await this.#sync();
  }

  /** Switch everything off, dependents first. */
  stop(): void {
    for (const id of [...this.#res.order].reverse()) {
      const e = this.#entries.get(id);
      if (e && live(e)) this.#halt(e, 'off', 'the kernel stopped');
    }
    this.#scope.dispose();
    this.#started = false;
  }

  // ---------- resolution and lifecycle ----------

  async #sync(): Promise<void> {
    const before = new Map([...this.#entries.values()].map((e) => [e.id, e.state]));
    const overrides = new Set([...this.#entries.values()].filter((e) => !e.builtin).map((e) => e.id));
    this.#res = resolve({ manifests: [...this.#entries.values()].map((e) => e.manifest), off: this.#off, choices: this.#choices, overrides, ...(this.options.api && { api: this.options.api }) });
    this.services.choice.clear();
    for (const [sid, p] of this.#res.providers) this.services.choice.set(sid, p);
    this.#apply(before);
    for (const id of this.#res.order) {
      const e = this.#entries.get(id);
      if (e?.state === 'resolved' && eager(e.manifest)) await this.#activate(e).catch(() => undefined);
    }
  }

  #apply(before: Map<string, PluginState>): void {
    const resolved = new Set(this.#res.order);
    // going off: dependents first, so nobody holds a handle to something already gone
    const going = [...this.#entries.values()].filter((e) => !resolved.has(e.id));
    for (const e of going.sort((a, b) => this.#depth(b.id) - this.#depth(a.id))) this.#halt(e, this.#off.has(e.id) ? 'off' : 'refused', this.#res.refused.get(e.id) ?? 'refused');
    const fresh = this.#res.order.map((id) => this.#entries.get(id)).filter((e): e is Entry => !!e && before.get(e.id) !== 'resolved' && before.get(e.id) !== 'active');
    for (const e of fresh) {
      Object.assign(e, { state: 'resolved', reason: undefined, statics: new ScopeImpl(`${e.id}#manifest`, { timers: this.timers }) });
      if (e.statics) this.#declare(e, e.statics);
    }
    for (const e of fresh) if (e.statics) this.#contributeStatic(e, e.statics);
  }

  #depth(id: string, seen = new Set<string>()): number {
    if (seen.has(id)) return 0;
    seen.add(id);
    return 1 + Math.max(0, ...(this.#res.deps.get(id) ?? []).map((d) => this.#depth(d, seen)));
  }

  #declare(e: Entry, s: ScopeImpl): void {
    const c = e.manifest.contributes;
    this.#try(e, 'setting', () => s.add(this.settings.declare(e.id, c?.settings ?? [])));
    this.#try(e, 'point', () => s.add(this.points.declare(e.id, c?.points ?? [])));
  }

  /** Locks on other plugins' settings, then items for other plugins' points: live before any code runs. */
  #contributeStatic(e: Entry, s: ScopeImpl): void {
    const c = e.manifest.contributes ?? {};
    for (const [key, value] of Object.entries(c.setSettings ?? {})) this.#try(e, 'setting', () => s.add(this.settings.lock(e.id, key, value)));
    for (const [key, value] of Object.entries(c)) {
      if (!key.includes('.')) continue;
      for (const item of Array.isArray(value) ? value : [value]) this.#try(e, 'point', () => s.add(this.points.contribute(e.id, key, item, true)));
    }
  }

  #try(e: Entry, kind: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.#problem(e, kind, err);
    }
  }

  #problem(e: Entry, kind: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    const code = typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : 'internal';
    this.diagnostics.record({ at: this.clock.now(), plugin: e.id, kind, code, message });
    this.log.warn(`${e.id}: ${message}`);
  }

  #halt(e: Entry, state: PluginState, reason: string): void {
    const was = e.state;
    e.scope?.dispose();
    e.statics?.dispose();
    this.events.drop(e.id);
    Object.assign(e, { state, reason, scope: undefined, statics: undefined, ctx: undefined });
    if (was !== 'active') return;
    this.log.info(`${e.id} is off: ${reason}`);
    this.events.publish(KERNEL_ID, 'kernel.pluginOff', { plugin: e.id, reason });
  }

  async #activate(e: Entry): Promise<void> {
    if (e.state === 'active' && !e.activating) return;
    if (e.activating) return e.activating;
    if (e.state !== 'resolved') throw fail('plugin_off', `${e.id} is ${e.state}${e.reason ? `: ${e.reason}` : ''}`);
    e.activating = this.#setup(e).finally(() => (e.activating = undefined));
    return e.activating;
  }

  async #setup(e: Entry): Promise<void> {
    // its requirements first; resolved optional ones too, so tryUse finds them in setup
    for (const d of [...(this.#res.deps.get(e.id) ?? []), ...this.#optionalDeps(e)]) {
      const x = this.#entries.get(d);
      if (x?.state === 'resolved' || x?.activating) await this.#activate(x).catch(() => undefined);
    }
    const down = (this.#res.deps.get(e.id) ?? []).find((d) => this.#entries.get(d)?.state !== 'active');
    if (down) throw fail('plugin_off', `${e.id} can't start: ${down} didn't`);
    const scope = new ScopeImpl(e.id, { timers: this.timers, onError: (err) => this.#problem(e, 'dispose', err) });
    Object.assign(e, { scope, state: 'active' });
    const def = e.def ?? (e.manifest.server && 'exec' in e.manifest.server ? execPluginDef(e, this, this.options.exec) : undefined);
    try {
      if (def) await def.setup(this.pluginContext(e.id));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.#problem(e, 'setup', err);
      this.#off.set(e.id, `${e.id} failed to start: ${msg}`);
      await this.#sync();
      throw fail('plugin_off', `${e.id} failed to start: ${msg}`);
    }
  }

  #optionalDeps(e: Entry): string[] {
    return Object.entries(e.manifest.requires ?? {}).flatMap(([dep, r]) => (typeof r === 'object' && r.optional ? [this.#res.providers.get(dep) ?? dep] : []));
  }

  /** An exec child died: off now (dependents cascade), back after a backoff, until it gives up. */
  crashed(id: string, why: string): void {
    const e = this.#entries.get(id);
    if (!e || e.state !== 'active') return;
    const o = this.options.exec ?? {};
    const max = o.maxRestarts ?? 5;
    e.restarts++;
    const wait = (o.restartBaseMs ?? 1000) * 2 ** (e.restarts - 1);
    const giveUp = e.restarts > max;
    this.diagnostics.record({ at: this.clock.now(), plugin: id, kind: 'exec', code: 'unavailable', message: why });
    this.#off.set(id, giveUp ? `${why}; gave up after ${max} restarts` : `${why}; restarting in ${wait} ms`);
    void this.#sync();
    if (!giveUp)
      this.#scope.timeout(wait, () => {
        if (this.#off.get(id)?.startsWith(why)) void this.reactivate(id);
      });
  }

  /** Activate whatever waits on (kind, name). Resolves to the plugins that started. */
  async fire(kind: ActivationKind, name: string, args?: unknown): Promise<PluginId[]> {
    const woken = [...this.#entries.values()].filter((e) => e.state === 'resolved' && wakes(e.manifest, kind, name, args));
    await Promise.all(woken.map((e) => this.#activate(e).catch(() => undefined)));
    return woken.filter((e) => e.state === 'active').map((e) => e.id);
  }

  async activateForCommand(cmd: string, args: unknown): Promise<void> {
    await this.fire('onCommand', cmd, args);
  }

  /** Switch a plugin off; whatever requires it goes off too, each with its reason. */
  async deactivate(id: string, reason = `${id} was switched off`): Promise<{ id: string; reason: string }[]> {
    if (!this.#entries.has(id)) throw fail('not_found', `no plugin ${id}`);
    const was = [...this.#entries.values()].filter(live).map((x) => x.id);
    this.#off.set(id, reason);
    await this.#sync();
    return was.filter((x) => !live(this.#entries.get(x))).map((x) => ({ id: x, reason: this.#entries.get(x)?.reason ?? '' }));
  }

  /** Switch it back on; plugins that went off because of it come back with it. */
  async reactivate(id: string): Promise<PluginState> {
    const e = this.#entries.get(id);
    if (!e) throw fail('not_found', `no plugin ${id}`);
    this.#off.delete(id);
    await this.#sync();
    return e.state;
  }

  /** Pick which plugin provides a service when several do. */
  async chooseProvider(contract: string, plugin: string): Promise<void> {
    this.#choices.set(contract, plugin);
    await this.#sync();
  }

  status(): PluginStatus[] {
    return [...this.#entries.values()].map((e) => ({
      id: e.id,
      version: e.manifest.version,
      state: e.state,
      ...(e.reason !== undefined && { reason: e.reason }),
      trust: e.manifest.trust ?? 'declarative',
      builtin: e.builtin,
      ...(this.events.lagging(e.id) && { lagging: true }),
    }));
  }

  // ---------- the edge ----------

  /** A call from outside (the HTTP edge, MCP, a peer), speaking for `caller`. */
  run<R = unknown>(cmd: string, args: unknown, caller: Caller): Promise<R> {
    return this.#dispatch.run({ cmd, args, caller }) as Promise<R>;
  }

  contributions(point: string): { by: string; item: unknown }[] {
    return this.points.entries(point);
  }

  /** The extension tree's nodes: every live extension, minus those a plugin disabled, overrides applied. */
  extensions(): (UiExtensionDecl & { plugin: string })[] {
    const on = [...this.#entries.values()].filter(live);
    const off = new Set(on.flatMap((e) => e.manifest.disable ?? []));
    const byId = new Map<string, UiExtensionDecl & { plugin: string }>();
    for (const e of on)
      for (const x of e.manifest.contributes?.ui ?? []) {
        const had = byId.get(x.id);
        if (!off.has(x.id) && (!had || (x.priority ?? 0) >= (had.priority ?? 0))) byId.set(x.id, { ...x, plugin: e.id });
      }
    return [...byId.values()];
  }

  /** Resolves when no event is queued and no follow-up is running. */
  async idle(): Promise<void> {
    do {
      await this.#dispatch.idle();
      await this.events.idle();
      await new Promise((r) => setImmediate(r));
    } while (this.#dispatch.busy || this.events.busy);
  }

  /** What a plugin still holds; all zero after it goes off (the testkit's leak check). */
  inspect(id: string): LeakReport {
    const p = id as PluginId;
    return {
      scope: this.#entries.get(id)?.scope?.size ?? 0,
      commands: this.#dispatch.commandsOf(id).length,
      interceptors: this.#dispatch.interceptorsOf(id),
      subscriptions: this.events.subscriptionsOf(p),
      provided: this.services.providedBy(id),
      handles: this.services.handlesOf(id),
      contributions: this.points.countBy(id),
      queued: this.events.queued(p),
    };
  }

  // ---------- ContextHost ----------

  entry(id: string): Entry | undefined {
    return this.#entries.get(id);
  }
  isActive(plugin: string): boolean {
    return this.#entries.get(plugin)?.state === 'active';
  }
  manifest(plugin: string): DeepReadonly<Manifest> {
    const e = this.#entries.get(plugin);
    if (!e) throw fail('not_found', `no plugin ${plugin}`);
    return e.manifest;
  }
  scope(plugin: string): ScopeImpl {
    const s = this.#entries.get(plugin)?.scope;
    if (!s) throw fail('plugin_off', `${plugin} is not active`);
    return s;
  }
  checkPlugin(plugin: string, permission: string): string | undefined {
    const e = this.#entries.get(plugin);
    if (!e) return plugin === KERNEL_ID ? undefined : `${plugin} is not a plugin`;
    const d = explain(e.caps, permission);
    return d.ok ? undefined : d.why;
  }
  checkCaller(caller: Caller, permission: string): string | undefined {
    if (caller.set === 'plugin') return caller.plugin ? this.checkPlugin(caller.plugin, permission) : 'a plugin caller names its plugin';
    const set = this.capabilities.get(caller.set);
    if (!set) return `${caller.set} is not a capability set`;
    const d = explain(set, permission);
    return d.ok ? undefined : d.why;
  }
  pluginContext(plugin: PluginId): PluginContext {
    const e = this.#entries.get(plugin);
    if (!e) throw fail('not_found', `no plugin ${plugin}`);
    return (e.ctx ??= makePluginContext(this, plugin));
  }
  callContext(plugin: PluginId, active: ActiveCall): CallContext {
    return makeCallContext(this, this.pluginContext(plugin), active);
  }
  runHook<C>(hook: string, value: C, parent: ActiveCall): Promise<C> {
    return this.#dispatch.runHook(hook, value, parent);
  }
  dispatchRun(req: RunRequest): Promise<unknown> {
    return this.#dispatch.run(req);
  }
  addCommand(owner: PluginId, def: CommandDef<unknown, unknown>): Disposable {
    return this.#dispatch.addCommand(owner, def);
  }
  addInterceptor(owner: PluginId, def: InterceptorDef<unknown>): Disposable {
    return this.#dispatch.addInterceptor(owner, def);
  }
  use<T>(plugin: PluginId, ref: ServiceRef<T>, opts: UseOptions | undefined, optional: boolean): T | undefined {
    return useService(this, plugin, ref, opts, optional);
  }
  provide<T>(plugin: PluginId, ref: ServiceRef<T>, impl: T): Disposable {
    return provideService(this, plugin, ref, impl);
  }
  kernelService<T>(plugin: PluginId, name: string): T {
    return kernelServiceProxy<T>(this, plugin, name);
  }
}
