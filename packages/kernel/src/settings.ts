// The settings registry (plan §3.1 rule 8: one config system). Settings are declared in manifests,
// typed and validated. Another plugin may set an overridable one through `contributes.setSettings`,
// which locks it (lockedBy) until that plugin goes off. `get` answers a lock first, then the value,
// then the default. Server settings sync through the store; device settings stay on this client.
import type { Disposable, Json, SettingDecl } from './contract.ts';
import { fail } from './errors.ts';
import { settingProblem } from './manifest.ts';

export interface SettingInfo {
  key: string;
  owner: string;
  decl: SettingDecl;
  scope: 'server' | 'device';
  value: Json | undefined;
  lockedBy?: string;
}

export interface SettingsBackend {
  /** values saved before (both scopes; a device backend answers its own) */
  load?(scope: 'server' | 'device'): Record<string, Json>;
  save?(key: string, value: Json | undefined, scope: 'server' | 'device'): void;
}

interface Row {
  owner: string;
  decl: SettingDecl;
}

export class SettingsRegistry {
  readonly #decls = new Map<string, Row>();
  readonly #values = new Map<string, Json>();
  readonly #locks = new Map<string, { by: string; value: Json }>();
  readonly #watchers = new Map<string, Set<(v: Json | undefined) => void>>();
  readonly #backend: SettingsBackend;

  constructor(backend: SettingsBackend = {}) {
    this.#backend = backend;
    for (const scope of ['server', 'device'] as const) for (const [k, v] of Object.entries(backend.load?.(scope) ?? {})) this.#values.set(k, v);
  }

  /** Declare a plugin's settings; the returned handle drops them (and their watchers keep nothing). */
  declare(owner: string, decls: readonly SettingDecl[]): Disposable {
    for (const d of decls) {
      const had = this.#decls.get(d.key);
      if (had && had.owner !== owner) throw fail('conflict', `${d.key} is already declared by ${had.owner}`);
    }
    for (const d of decls) this.#decls.set(d.key, { owner, decl: d });
    return {
      dispose: () => {
        for (const d of decls) if (this.#decls.get(d.key)?.owner === owner) this.#decls.delete(d.key);
      },
    };
  }

  /** Set and lock another plugin's overridable setting. Refused when it isn't one or someone else holds it. */
  lock(by: string, key: string, value: Json): Disposable {
    const row = this.#row(key);
    if (!row.decl.overridable) throw fail('forbidden', `${by} can't set ${key}: ${row.owner} doesn't let other plugins set it`);
    const held = this.#locks.get(key);
    if (held && held.by !== by) throw fail('conflict', `${key} is locked by ${held.by}`);
    const why = settingProblem(row.decl, value);
    if (why) throw fail('invalid', `${by} sets ${key}: ${why}`);
    const before = this.get(key);
    this.#locks.set(key, { by, value });
    this.#changed(key, before);
    return {
      dispose: () => {
        if (this.#locks.get(key)?.by !== by) return;
        const was = this.get(key);
        this.#locks.delete(key);
        this.#changed(key, was);
      },
    };
  }

  get(key: string): Json | undefined {
    const lock = this.#locks.get(key);
    if (lock) return lock.value;
    if (this.#values.has(key)) return this.#values.get(key);
    return this.#decls.get(key)?.decl.default;
  }

  /** The user's (or a command's) write. `undefined` resets it to the default. */
  set(key: string, value: Json | undefined): void {
    const row = this.#row(key);
    const lock = this.#locks.get(key);
    if (lock) throw fail('conflict', `${key} is locked by ${lock.by}`);
    if (value !== undefined) {
      const why = settingProblem(row.decl, value);
      if (why) throw fail('invalid', `${key} ${why}`);
    }
    const before = this.get(key);
    if (value === undefined) this.#values.delete(key);
    else this.#values.set(key, value);
    this.#backend.save?.(key, value, row.decl.scope ?? 'server');
    this.#changed(key, before);
  }

  info(key: string): SettingInfo | undefined {
    const row = this.#decls.get(key);
    if (!row) return undefined;
    const lock = this.#locks.get(key);
    return { key, owner: row.owner, decl: row.decl, scope: row.decl.scope ?? 'server', value: this.get(key), ...(lock && { lockedBy: lock.by }) };
  }

  list(scope?: 'server' | 'device'): SettingInfo[] {
    return [...this.#decls.keys()].flatMap((k) => {
      const i = this.info(k);
      return i && (!scope || i.scope === scope) ? [i] : [];
    });
  }

  watch(key: string, fn: (v: Json | undefined) => void): Disposable {
    let set = this.#watchers.get(key);
    if (!set) this.#watchers.set(key, (set = new Set()));
    set.add(fn);
    return {
      dispose: () => {
        set.delete(fn);
        if (!set.size) this.#watchers.delete(key);
      },
    };
  }

  /** watchers alive (the leak check reads it) */
  get watcherCount(): number {
    let n = 0;
    for (const s of this.#watchers.values()) n += s.size;
    return n;
  }

  #row(key: string): Row {
    const row = this.#decls.get(key);
    if (!row) throw fail('not_found', `no plugin declares the setting ${key}`);
    return row;
  }

  #changed(key: string, before: Json | undefined): void {
    const now = this.get(key);
    if (JSON.stringify(now) === JSON.stringify(before)) return;
    for (const fn of [...(this.#watchers.get(key) ?? [])]) fn(now);
  }
}
