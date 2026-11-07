// Plugin stores (plan §4.6.6): local state a plugin declares, namespaced by its id, persisted only
// if declared, versioned. A store whose saved data fails its migration or its check is reset to
// its defaults with a warning, and the plugin keeps working: one bad plugin can't corrupt the
// client's IndexedDB. The store goes with the plugin's scope; its saved data stays until removed.

import type { Persist } from './persist.ts';
import type { Scope } from './scope.ts';
import { signal, untracked, type Readable } from './signals.ts';
import type { DeepReadonly, Json, Warn } from './types.ts';

export interface StoreDecl<T extends Json> {
  id: string; // '<plugin>.<name>': 'myplugin.view'
  version: number;
  defaults: T;
  /** narrows saved data: the value if it is a T, undefined if not */
  check(value: unknown): T | undefined;
  /** turns data saved by version `from` into this version's shape; may throw */
  migrate?(old: unknown, from: number): unknown;
  /** keep between runs (default: memory only) */
  persist?: boolean;
}

export interface PluginStore<T extends Json> {
  readonly id: string;
  readonly value: Readable<DeepReadonly<T>>;
  set(next: T | ((cur: DeepReadonly<T>) => T)): void;
  reset(): void;
  /** resolves once saved data is loaded (or found missing) */
  readonly ready: Promise<void>;
}

interface Saved {
  version: number;
  data: unknown;
}

export interface StoreHost {
  define<T extends Json>(plugin: string, scope: Scope, decl: StoreDecl<T>): PluginStore<T>;
}

// size-ok: a factory; its body is small closures over shared private state, each under the cap
export function createStoreHost(o: { persist?: Persist; warn?: Warn } = {}): StoreHost {
  const warn = o.warn ?? (() => {});
  const live = new Set<string>();

  function revive<T extends Json>(decl: StoreDecl<T>, saved: unknown): T {
    if (saved === undefined) return decl.defaults;
    const s = saved as Partial<Saved>;
    if (typeof s.version !== 'number' || !('data' in s)) {
      warn(`store ${decl.id}: saved data is unreadable, reset to defaults`);
      return decl.defaults;
    }
    try {
      if (s.version > decl.version) throw new Error(`saved by a newer version (${s.version})`);
      const data = s.version === decl.version ? s.data : decl.migrate ? decl.migrate(s.data, s.version) : undefined;
      const ok = decl.check(data);
      if (ok === undefined) throw new Error(s.version === decl.version ? 'saved data fails its check' : 'migration result fails its check');
      return ok;
    } catch (err) {
      warn(`store ${decl.id}: ${err instanceof Error ? err.message : String(err)}, reset to defaults`);
      return decl.defaults;
    }
  }

  return {
    define<T extends Json>(plugin: string, scope: Scope, decl: StoreDecl<T>): PluginStore<T> {
      if (!decl.id.startsWith(`${plugin}.`)) throw new Error(`${plugin} can't define the store ${decl.id}: ids start with "${plugin}."`);
      if (live.has(decl.id)) throw new Error(`store ${decl.id} is defined twice`);
      live.add(decl.id);
      scope.add(() => live.delete(decl.id));
      const state = signal<T>(decl.defaults);
      let touched = false; // a set before the load finishes wins over the saved value
      const save = (v: T): void => {
        if (!decl.persist || !o.persist || !scope.alive) return;
        const value: Saved = { version: decl.version, data: v };
        o.persist.write([{ ns: `store:${plugin}`, key: decl.id, value }]).catch((err: unknown) => warn(`store ${decl.id} not saved`, String(err)));
      };
      const ready =
        decl.persist && o.persist
          ? o.persist.get(`store:${plugin}`, decl.id).then((saved) => {
              if (touched || !scope.alive) return;
              const v = revive(decl, saved);
              state(v);
              if (saved !== undefined && v === decl.defaults) save(v); // a reset is written, so it warns once
              else if (saved !== undefined && (saved as Saved).version !== decl.version) save(v);
            })
          : Promise.resolve();
      return {
        id: decl.id,
        value: () => state() as DeepReadonly<T>,
        set(next) {
          if (!scope.alive) return;
          touched = true;
          const v = typeof next === 'function' ? next(untracked(state) as DeepReadonly<T>) : next;
          state(v);
          save(v);
        },
        reset() {
          touched = true;
          state(decl.defaults);
          save(decl.defaults);
        },
        ready,
      };
    },
  };
}
