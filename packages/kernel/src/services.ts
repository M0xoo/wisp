// Plugin services (plan §6.11.1): typed handles by contract id and major, never by provider. Every
// method call goes through a proxy that checks the caller's permission for that method, refuses
// non-read-only methods inside an interceptor, copies plain data across, and throws `service_gone`
// once the provider is off. Handles belong to the consumer's scope.
import type { Disposable, ServiceRef, UseOptions } from './contract.ts';
import { fail, KernelError } from './errors.ts';
import { isJson, isObj } from './manifest-check.ts';
import { current } from './trace-context.ts';

/** `defineService<GitService>('git.service', 1, {repo: 'git:repo', …})`. */
export function defineService<T>(id: string, major: number, permissions: Readonly<Record<string, string>>, readOnly: readonly string[] = []): ServiceRef<T> {
  return Object.freeze({ id, major, permissions: Object.freeze({ ...permissions }), readOnly: Object.freeze([...readOnly]) });
}

export interface Provider {
  plugin: string;
  /** the provider's contract: its permission map is the one enforced, whatever the consumer passes */
  ref: ServiceRef<unknown>;
  impl: object;
  version: string;
  order: number;
  /** consumers to tell when it goes */
  handles: Set<Handle>;
}

export interface Handle {
  consumer: string;
  gone?: string;
  onLost?: (reason: string) => void;
  /** disposables a call returned to this consumer */
  owned: Set<Disposable>;
}

export interface ProxyEnv {
  /** may `consumer` use `permission`? the reason when not */
  check(consumer: string, permission: string): string | undefined;
  /** 5 s by default (plan §6.11.2 rule 5) */
  callTimeoutMs: number;
  withTimeout<R>(p: Promise<R>, ms: number, what: string): Promise<R>;
}

/** Plain data in, so a provider never holds a consumer's mutable object. Functions (callbacks) pass. */
function copyArg(v: unknown, at: string): unknown {
  if (typeof v === 'function' || v === undefined) return v;
  if (isJson(v)) return structuredClone(v);
  throw fail('invalid', `${at}: only plain data crosses a service boundary`);
}

const isDisposable = (v: unknown): v is Record<string, unknown> & Disposable => isObj(v) && typeof v['dispose'] === 'function';
const hasMethods = (v: unknown): v is Record<string, unknown> => isObj(v) && Object.values(v).some((x) => typeof x === 'function');

export class ServiceTable {
  readonly #byKey = new Map<string, Provider[]>();
  #order = 0;
  /** contract id → the plugin the user chose, or the resolver picked */
  readonly choice = new Map<string, string>();

  static key(id: string, major: number): string {
    return `${id}@${major}`;
  }

  add(ref: ServiceRef<unknown>, plugin: string, impl: object, version: string): Disposable {
    const key = ServiceTable.key(ref.id, ref.major);
    for (const [name, v] of Object.entries(impl)) if (typeof v === 'function' && !(name in ref.permissions)) throw fail('invalid', `${plugin} provides ${key}, whose method ${name} maps to no permission`);
    const list = this.#byKey.get(key) ?? [];
    if (list.some((p) => p.plugin === plugin)) throw fail('conflict', `${plugin} already provides ${key}`);
    const p: Provider = { plugin, ref, impl, version, order: this.#order++, handles: new Set() };
    this.#byKey.set(key, [...list, p]);
    return { dispose: () => this.#remove(key, p) };
  }

  #remove(key: string, p: Provider): void {
    this.#byKey.set(key, (this.#byKey.get(key) ?? []).filter((x) => x !== p));
    const why = `${p.plugin} stopped providing ${key}`;
    for (const h of p.handles) {
      if (h.gone) continue;
      h.gone = why;
      for (const d of h.owned) d.dispose();
      h.owned.clear();
      try {
        h.onLost?.(why);
      } catch {
        // a consumer's onLost failing doesn't keep the provider alive
      }
    }
    p.handles.clear();
  }

  /** The provider for (id, major): the one resolution chose (the user's pick, else an override), else the first. */
  pick(id: string, major: number): Provider | undefined {
    const list = this.#byKey.get(ServiceTable.key(id, major)) ?? [];
    const chosen = this.choice.get(id);
    return list.find((p) => p.plugin === chosen) ?? list[0];
  }

  providers(id: string, major: number): string[] {
    return (this.#byKey.get(ServiceTable.key(id, major)) ?? []).map((p) => p.plugin);
  }

  /** handles alive held by `consumer` (the leak check reads it) */
  handlesOf(consumer: string): number {
    let n = 0;
    for (const list of this.#byKey.values()) for (const p of list) for (const h of p.handles) if (h.consumer === consumer && !h.gone) n++;
    return n;
  }
  providedBy(plugin: string): number {
    let n = 0;
    for (const list of this.#byKey.values()) n += list.filter((p) => p.plugin === plugin).length;
    return n;
  }
}

/** The consumer's view of a provider: every method checked, every result plain or owned. */
export function makeProxy<T>(p: Provider, h: Handle, env: ProxyEnv): T {
  return wrap(p.ref, p.impl, h, env, '') as T;
}

function wrap(ref: ServiceRef<unknown>, target: object, h: Handle, env: ProxyEnv, path: string): object {
  const out: Record<string, unknown> = {};
  for (const [name, v] of Object.entries(target)) {
    if (typeof v !== 'function') continue;
    const method = path ? `${path}.${name}` : name;
    // a handle's method answers to its own permission when the contract names one, else its parent's
    const perm = ref.permissions[method] ?? (path ? ref.permissions[path] : undefined) ?? '';
    out[name] = (...args: unknown[]) => call(ref, target, v as (...a: unknown[]) => unknown, { method, perm, h, env }, args);
  }
  return Object.freeze(out);
}

interface CallInfo {
  method: string;
  perm: string;
  h: Handle;
  env: ProxyEnv;
}

function call(ref: ServiceRef<unknown>, self: object, fn: (...a: unknown[]) => unknown, c: CallInfo, args: unknown[]): unknown {
  const what = `${ref.id}@${ref.major}.${c.method}`;
  if (c.h.gone) throw fail('service_gone', `${what}: ${c.h.gone}`);
  const denied = c.env.check(c.h.consumer, c.perm);
  if (denied) throw fail('forbidden', `${c.h.consumer} may not call ${what}: ${denied}`);
  const top = c.method.split('.')[0] ?? c.method;
  if (current.getStore()?.trace.readOnly && !(ref.readOnly ?? []).includes(c.method) && !(ref.readOnly ?? []).includes(top)) throw fail('forbidden', `${what} writes, and an interceptor may only read`);
  const copied = args.map((a, i) => {
    const x = copyArg(a, `${what} argument ${i + 1}`);
    // a callback stops firing once the consumer lets go of the handle
    return typeof x === 'function' ? (...cbArgs: unknown[]) => (c.h.gone ? undefined : (x as (...y: unknown[]) => unknown)(...cbArgs)) : x;
  });
  const result = fn.apply(self, copied);
  if (result instanceof Promise) return c.env.withTimeout(result.then((r) => adopt(ref, r, c)), c.env.callTimeoutMs, what);
  return adopt(ref, result, c);
}

/** Results: plain data is copied, a Disposable is owned by the consumer, a handle is wrapped in turn. */
function adopt(ref: ServiceRef<unknown>, r: unknown, c: CallInfo): unknown {
  if (r === undefined || isJson(r)) return r === undefined ? r : structuredClone(r);
  if (isDisposable(r) && !hasMethodsBesidesDispose(r)) {
    const once = { dispose: () => (c.h.owned.delete(once), r.dispose()) };
    c.h.owned.add(once);
    return once;
  }
  if (hasMethods(r)) {
    const d = r['dispose'];
    // a handle that can be disposed is released with the consumer
    if (typeof d === 'function') c.h.owned.add({ dispose: () => void d.call(r) });
    return wrap(ref, r, c.h, c.env, c.method);
  }
  throw new KernelError('internal', `${ref.id}.${c.method} returned something that isn't plain data, a Disposable or a handle`);
}

const hasMethodsBesidesDispose = (r: Record<string, unknown>): boolean => Object.entries(r).some(([k, v]) => k !== 'dispose' && typeof v === 'function');

export type { UseOptions };
