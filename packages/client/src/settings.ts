// Preferences, kind 6 (plan §4.6.2): typed from manifest declarations (§6.2). Each key is
// declared `scope: 'server'` (synced: read from the peer's `setting` rows, written by the
// `settings.set` command with an optimistic patch) or `scope: 'device'` (this client only, kept in
// Persist). A value another plugin locked reads as `lockedBy` that plugin and can't be set.

import { CommandError, defineCommand, type Commands } from './commands.ts';
import type { EntityReader } from './entities.ts';
import { entityKey } from './ids.ts';
import type { Persist } from './persist.ts';
import type { Scope } from './scope.ts';
import { computed, signal, untracked, type Readable, type WritableSignal } from './signals.ts';
import type { Json, PeerId, PluginId, SettingDecl, Warn } from './types.ts';

export type SettingValue<D extends SettingDecl> = D['type'] extends 'bool'
  ? boolean
  : D['type'] extends 'int'
    ? number
    : D['type'] extends 'enum'
      ? D['values'] extends readonly (infer V)[]
        ? V
        : string
      : D['type'] extends 'string'
        ? string
        : Json;

type DeclOf<D extends readonly SettingDecl[], K> = Extract<D[number], { key: K }>;

export interface TypedSettings<D extends readonly SettingDecl[]> {
  get<K extends D[number]['key']>(key: K): Readable<SettingValue<DeclOf<D, K>>>;
  lockedBy(key: D[number]['key']): Readable<PluginId | undefined>;
  set<K extends D[number]['key']>(key: K, value: SettingValue<DeclOf<D, K>>): Promise<void>;
}

export interface Settings {
  /** declares `plugin`'s settings while `scope` lives and hands back typed accessors */
  register<const D extends readonly SettingDecl[]>(plugin: string, scope: Scope, decls: D): TypedSettings<D>;
  /** a plugin's `setSettings` for another plugin's overridable device key */
  lock(key: string, value: Json, by: PluginId, scope: Scope): void;
  get(key: string): Readable<Json | undefined>;
  lockedBy(key: string): Readable<PluginId | undefined>;
  set(key: string, value: Json): Promise<void>;
  load(): Promise<void>;
}

/** A server setting row: `setting(key, value, locked_by)` (plan §4.1). */
export interface SettingRow {
  key: string;
  value: Json;
  locked_by?: string | null;
}

export const setSetting = defineCommand<{ peer: PeerId; key: string; value: Json }>({
  id: 'settings.set',
  owner: (a) => a.peer,
  optimistic: (base, a) => {
    const id = entityKey(a.peer, a.key);
    const row = base.peek<SettingRow>('setting', id);
    return [{ e: 'setting', id, op: 'upsert', v: { ...row, key: a.key, value: a.value } }];
  },
});

export function validateSetting(d: SettingDecl, v: unknown): string | undefined {
  switch (d.type) {
    case 'bool':
      return typeof v === 'boolean' ? undefined : `${d.key} is true or false`;
    case 'int':
      if (typeof v !== 'number' || !Number.isInteger(v)) return `${d.key} is a whole number`;
      if (d.min !== undefined && v < d.min) return `${d.key} is at least ${d.min}`;
      if (d.max !== undefined && v > d.max) return `${d.key} is at most ${d.max}`;
      return undefined;
    case 'enum':
      return typeof v === 'string' && (d.values ?? []).includes(v) ? undefined : `${d.key} is one of ${(d.values ?? []).join(', ')}`;
    case 'string':
      return typeof v === 'string' ? undefined : `${d.key} is text`;
    case 'json':
      return undefined;
  }
}

export interface SettingsOptions {
  reader: EntityReader;
  commands: Commands;
  /** the peer whose `setting` rows hold server-scoped values: this client's own wisp */
  home: PeerId;
  persist?: Persist;
  warn?: Warn;
}

const NS = 'settings';

// size-ok: a factory; its body is small closures over shared private state, each under the cap
export function createSettings(o: SettingsOptions): Settings {
  const decls = new Map<string, SettingDecl>();
  const declared = signal(0); // bumped when declarations change, so values read before one update
  const device = new Map<string, WritableSignal<Json | undefined>>();
  const locks = new Map<string, WritableSignal<{ value: Json; by: PluginId } | undefined>>();
  const lazy = <V>(m: Map<string, WritableSignal<V | undefined>>, k: string): WritableSignal<V | undefined> => {
    let s = m.get(k);
    if (!s) m.set(k, (s = signal<V | undefined>(undefined)));
    return s;
  };
  const row = (key: string): Readable<SettingRow | undefined> => o.reader.row<SettingRow>('setting', entityKey(o.home, key)) as Readable<SettingRow | undefined>;
  const isServer = (d: SettingDecl | undefined): boolean => (d?.scope ?? 'server') === 'server';

  const memo = new Map<string, Readable<unknown>>();
  const once = <V>(id: string, make: () => Readable<V>): Readable<V> => {
    let r = memo.get(id);
    if (!r) memo.set(id, (r = make()));
    return r as Readable<V>;
  };

  const lockedBy = (key: string): Readable<PluginId | undefined> =>
    once(`lock:${key}`, () => computed(() => {
      declared();
      if (isServer(decls.get(key))) return (row(key)()?.locked_by ?? undefined) as PluginId | undefined;
      return lazy(locks, key)()?.by;
    }));

  const get = (key: string): Readable<Json | undefined> =>
    once(`get:${key}`, () => computed(() => {
      declared();
      const d = decls.get(key);
      if (isServer(d)) return row(key)()?.value ?? d?.default;
      return lazy(locks, key)()?.value ?? lazy(device, key)() ?? d?.default;
    }));

  async function set(key: string, value: Json): Promise<void> {
    const d = decls.get(key);
    if (!d) throw new CommandError({ code: 'not_found', message: `no setting ${key}` });
    const bad = validateSetting(d, value);
    if (bad) throw new CommandError({ code: 'invalid', message: bad });
    const by = lockedBy(key)();
    if (by) throw new CommandError({ code: 'forbidden', message: `${key} is set by ${by}` });
    if (isServer(d)) {
      await o.commands.run(setSetting, { peer: o.home, key, value });
      return;
    }
    lazy(device, key)(value);
    await o.persist?.write([{ ns: NS, key, value }]);
  }

  return {
    register<const D extends readonly SettingDecl[]>(plugin: string, scope: Scope, list: D): TypedSettings<D> {
      for (const d of list) {
        if (!d.key.startsWith(`${plugin}.`)) throw new Error(`${plugin} can't declare the setting ${d.key}`);
        if (decls.has(d.key)) throw new Error(`setting ${d.key} is declared twice`);
        decls.set(d.key, d);
        scope.add(() => {
          decls.delete(d.key);
          declared(untracked(declared) + 1);
        });
      }
      declared(untracked(declared) + 1);
      return {
        get: (key) => get(key) as Readable<never>,
        lockedBy: (key) => lockedBy(key),
        set: (key, value) => set(key, value as Json),
      };
    },
    lock(key, value, by, scope) {
      const d = decls.get(key);
      if (d && !d.overridable) return o.warn?.(`${by} can't lock ${key}: it isn't overridable`);
      lazy(locks, key)({ value, by });
      scope.add(() => lazy(locks, key)(undefined));
    },
    get,
    lockedBy,
    set,
    async load() {
      for (const [key, v] of (await o.persist?.entries(NS)) ?? []) lazy(device, key)(v as Json);
    },
  };
}
