// The PluginContext each plugin's setup receives, and the CallContext a handler receives. Every
// registration lands in the plugin's scope, so dropping the scope undoes all of it.
import type { Caller, CallContext, CommandDef, DeepReadonly, Disposable, EventEnvelope, InterceptorDef, Json, Manifest, PluginContext, PluginId, ServiceRef, Trace, UseOptions } from './contract.ts';
import { fail } from './errors.ts';
import type { DispatchHost } from './host-types.ts';
import { ownedBy } from './ids.ts';
import { isJson } from './manifest-check.ts';
import type { Points } from './points.ts';
import type { ScopeImpl } from './scope.ts';
import type { SettingsRegistry } from './settings.ts';
import { current, type ActiveCall } from './trace-context.ts';
import type { RunRequest } from './dispatch.ts';

export interface ContextHost extends DispatchHost {
  readonly points: Points;
  readonly settings: SettingsRegistry;
  manifest(plugin: string): DeepReadonly<Manifest>;
  scope(plugin: string): ScopeImpl;
  dispatchRun(req: RunRequest): Promise<unknown>;
  runHook<C>(hook: string, value: C, parent: ActiveCall): Promise<C>;
  addCommand(owner: PluginId, def: CommandDef<unknown, unknown>): Disposable;
  addInterceptor(owner: PluginId, def: InterceptorDef<unknown>): Disposable;
  use<T>(plugin: PluginId, ref: ServiceRef<T>, opts: UseOptions | undefined, optional: boolean): T | undefined;
  provide<T>(plugin: PluginId, ref: ServiceRef<T>, impl: T): Disposable;
  kernelService<T>(plugin: PluginId, name: string): T;
}

export function makePluginContext(host: ContextHost, id: PluginId): PluginContext {
  const manifest = host.manifest(id);
  const scope = host.scope(id);
  const own = (d: Disposable): void => scope.add(d);
  const alive = (what: string): void => {
    if (!scope.alive) throw fail('plugin_off', `${id} is off: it can't ${what}`);
  };
  const declared = new Set((manifest.contributes?.commands ?? []).map((c) => c.id));
  return {
    id,
    manifest,
    scope,
    clock: host.clock,
    log: host.log,
    settings: {
      get: <T extends Json>(key: string) => host.settings.get(key) as T | undefined,
      watch: (key, fn) => {
        const d = host.settings.watch(key, fn);
        own(d);
        return d;
      },
    },
    service: <T>(name: string) => host.kernelService<T>(id, name),
    use: <T>(ref: ServiceRef<T>, opts?: UseOptions) => host.use(id, ref, opts, false) as T,
    tryUse: <T>(ref: ServiceRef<T>, opts?: UseOptions) => host.use(id, ref, opts, true),
    provide: (ref, impl) => {
      alive('provide a service');
      own(host.provide(id, ref, impl));
    },
    command: <A, R>(def: CommandDef<A, R>) => {
      alive('register a command');
      if (!ownedBy(def.id, id)) throw fail('invalid', `${id} can't register ${def.id}: command ids start with its prefix`);
      if (!declared.has(def.id)) throw fail('invalid', `${id} registers ${def.id}, which isn't in its manifest's contributes.commands`);
      own(host.addCommand(id, def as CommandDef<unknown, unknown>));
    },
    intercept: <C>(def: InterceptorDef<C>) => {
      alive('intercept a hook');
      own(host.addInterceptor(id, def as InterceptorDef<unknown>));
    },
    on: (type, fn) => {
      alive('subscribe');
      own(host.events.on(id, type, fn as (e: EventEnvelope) => void | Promise<void>));
    },
    emit: (type, data) => emit(host, id, type, data),
    contribute: (point, item) => {
      alive('contribute');
      own(host.points.contribute(id, point, item));
    },
    contributions: <T>(point: string) => contributions<T>(host, id, point),
    run: <R>(cmd: string, args?: unknown, call?: Partial<Pick<Trace, 'caller'>>) => {
      const parent = current.getStore();
      const caller: Caller | undefined = call?.caller;
      return host.dispatchRun({ cmd, args, from: id, ...(caller && { caller }), ...(parent && { parent }) }) as Promise<R>;
    },
  };
}

function emit(host: ContextHost, id: PluginId, type: string, data: unknown): void {
  if (!ownedBy(type, id)) throw fail('forbidden', `${id} can't emit ${type}: a plugin announces its own events (${type.split('.')[0]}.* isn't its prefix)`);
  if (!isJson(data)) throw fail('invalid', `${type}: event data is plain JSON`);
  const at = current.getStore();
  // inside a command: wait for its commit; outside one: now
  if (at) at.root.events.push({ plugin: id, type, data });
  else host.events.publish(id, type, data);
}

function contributions<T>(host: ContextHost, id: PluginId, point: string): readonly T[] {
  const owner = host.points.owner(point);
  if (owner !== undefined && owner !== id) {
    const why = host.checkPlugin(id, `points:read{point:${point}}`);
    if (why) throw fail('forbidden', `${id} may not read ${point} (owned by ${owner}): ${why}`);
  }
  return host.points.entries(point).map((e) => e.item as T);
}

export function makeCallContext(host: ContextHost, base: PluginContext, active: ActiveCall): CallContext {
  return {
    ...base,
    trace: active.trace,
    run: <R>(cmd: string, args?: unknown) => host.dispatchRun({ cmd, args, from: base.id, parent: active }) as Promise<R>,
    runHook: <C>(hook: string, ctx: C) => host.runHook(hook, ctx, active),
  };
}
