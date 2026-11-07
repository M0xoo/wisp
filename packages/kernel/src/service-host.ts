// use / provide / kernel services, as the kernel runs them (plan §6.11.1). Requested by contract,
// checked against the manifest (a plugin uses only what it requires and provides only what it
// declares), and handed out through the permission-checking proxy.
import type { DeepReadonly, Disposable, Manifest, PluginId, ServiceRef, UseOptions } from './contract.ts';
import { fail } from './errors.ts';
import { majorOf, satisfies } from './semver.ts';
import { makeProxy, type Handle, type Provider, type ProxyEnv, type ServiceTable } from './services.ts';
import type { ScopeImpl } from './scope.ts';
import type { Timers } from './scope.ts';
import { isObj } from './manifest-check.ts';

export interface ServiceHost {
  readonly services: ServiceTable;
  readonly timers: Timers;
  readonly options: { services?: Record<string, unknown>; servicePermissions?: Record<string, Readonly<Record<string, string>>>; serviceTimeoutMs?: number };
  manifest(plugin: string): DeepReadonly<Manifest>;
  scope(plugin: string): ScopeImpl;
  checkPlugin(plugin: string, permission: string): string | undefined;
  entry(id: string): { builtin: boolean } | undefined;
}

function env(host: ServiceHost): ProxyEnv {
  return {
    check: (consumer, perm) => (perm ? host.checkPlugin(consumer, perm) : 'the contract maps this method to no permission'),
    callTimeoutMs: host.options.serviceTimeoutMs ?? 5000,
    withTimeout: <R>(p: Promise<R>, ms: number, what: string) =>
      new Promise<R>((ok, no) => {
        const t = host.timers.setTimeout(() => no(fail('timeout', `${what} didn't answer within ${ms} ms`)), ms);
        p.then(
          (v) => (host.timers.clearTimeout(t), ok(v)),
          (e: unknown) => (host.timers.clearTimeout(t), no(e)),
        );
      }),
  };
}

/** A handle the consumer's scope owns: freed when the consumer goes off. */
function attach(host: ServiceHost, consumer: string, p: Provider, opts: UseOptions | undefined): Handle {
  const h: Handle = { consumer, owned: new Set(), ...(opts?.onLost && { onLost: opts.onLost }) };
  p.handles.add(h);
  host.scope(consumer).add(() => {
    if (!h.gone) h.gone = `${consumer} let go of it`;
    for (const d of h.owned) d.dispose();
    h.owned.clear();
    p.handles.delete(h);
  });
  return h;
}

export function useService<T>(host: ServiceHost, plugin: PluginId, ref: ServiceRef<T>, opts: UseOptions | undefined, optional: boolean): T | undefined {
  const r = host.manifest(plugin).requires?.[ref.id];
  if (r === undefined) throw fail('forbidden', `${plugin} uses ${ref.id} but doesn't list it in requires`);
  const range = typeof r === 'string' ? r : r.version;
  const p = host.services.pick(ref.id, ref.major);
  if (!p || !satisfies(p.version, range)) {
    if (optional) return undefined;
    throw fail('service_gone', p ? `${plugin} needs ${ref.id} ${range}, and ${p.plugin} provides ${p.version}` : `no plugin provides ${ref.id}@${ref.major}`);
  }
  return makeProxy<T>(p, attach(host, plugin, p, opts), env(host));
}

export function provideService<T>(host: ServiceHost, plugin: PluginId, ref: ServiceRef<T>, impl: T): Disposable {
  const decl = host.manifest(plugin).provides?.[ref.id];
  if (!decl || majorOf(decl.version) !== ref.major) throw fail('forbidden', `${plugin} provides ${ref.id}@${ref.major}, which its manifest doesn't declare (provides: {"${ref.id}": {"version": "${ref.major}.0.0"}})`);
  if (!isObj(impl)) throw fail('invalid', `${plugin}: a service is an object of methods`);
  return host.services.add(ref, plugin, impl, decl.version);
}

/** A kernel service ('store', 'proc', …). With declared permissions, every call is checked like a plugin service. */
export function kernelServiceProxy<T>(host: ServiceHost, plugin: PluginId, name: string): T {
  const impl = host.options.services?.[name];
  if (impl === undefined) throw fail('not_found', `no kernel service ${name}`);
  const permissions = host.options.servicePermissions?.[name];
  if (!permissions || !isObj(impl)) return impl as T;
  const p: Provider = { plugin: 'wisp.kernel', ref: { id: `kernel.${name}`, major: 0, permissions }, impl, version: '0.0.0', order: 0, handles: new Set() };
  return makeProxy<T>(p, attach(host, plugin, p, undefined), env(host));
}
