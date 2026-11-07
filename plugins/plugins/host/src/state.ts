// What v1 kept in ~/.wisp/spells.json (which are on, where each came from, how often a hook fired
// per task) as wisp.plugins' own tables, written only through store.tx. For one release spells.json
// is written too, so going back to v1 keeps the user's spells on (ADR-0004, the downgrade path).

import fs from 'node:fs/promises';
import type { Source, StateRow } from '@wisp-plugin/plugins-api';
import { JsonFile, type Store } from '@wisp/store';
import type { EntityDef, Migration } from '@wisp/store';

export const OWNER = 'wisp.plugins';

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE plugins_state (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, enabled INTEGER NOT NULL, source TEXT,
        at INTEGER NOT NULL, on_at INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE plugins_hook (
        id TEXT PRIMARY KEY, plugin TEXT NOT NULL, hook TEXT NOT NULL, session TEXT NOT NULL,
        n INTEGER NOT NULL, at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX plugins_hook_by ON plugins_hook (plugin, hook, at);
    `,
  },
];

export interface Row extends StateRow {
  /** when it was last switched on: of two that set one setting, the later wins (v1's list order) */
  on_at: number;
}

export interface HookRow {
  [k: string]: unknown;
  id: string;
  plugin: string;
  hook: string;
  session: string;
  n: number;
  at: number;
}

/** Hook counts kept per hook: the newest sessions only (v1 kept 200). */
const HOOK_SESSIONS = 200;

interface V1State {
  enabled?: unknown;
  sources?: Record<string, Source>;
  hooks?: Record<string, Record<string, Record<string, number>>>;
}

export class State {
  readonly #store: Store;
  readonly #now: () => number;
  readonly #file: JsonFile<V1State>;
  readonly STATE: EntityDef<Row>;
  readonly HOOK: EntityDef<HookRow>;

  constructor(store: Store, home: string, now: () => number) {
    this.#store = store;
    this.#now = now;
    this.#file = new JsonFile<V1State>(`${home}/spells.json`, { space: 2, mode: 0o644 });
    store.migrate(OWNER, MIGRATIONS);
    this.STATE = store.defineEntity<Row>({ kind: 'plugins.state', table: 'plugins_state', key: 'id', columns: { id: 'text', kind: 'text', enabled: 'bool', source: 'text', at: 'int', on_at: 'int' }, json: ['source'], topics: () => ['config'] });
    this.HOOK = store.defineEntity<HookRow>({ kind: 'plugins.hook', table: 'plugins_hook', key: 'id', columns: { id: 'text', plugin: 'text', hook: 'text', session: 'text', n: 'int', at: 'int' }, topics: () => ['config'] });
  }

  get(id: string): Row | undefined {
    return this.#store.get(this.STATE, id);
  }

  /** On, in the order they were switched on. */
  enabled(): Row[] {
    return this.#store.query(this.STATE, { where: { enabled: true }, order: [['on_at', 'asc'], ['id', 'asc']] });
  }

  all(): Row[] {
    return this.#store.query(this.STATE);
  }

  /** A new or updated plugin: its source (when known) and, when asked, on. */
  put(id: string, kind: Row['kind'], o: { source?: Source | null; enable?: boolean }): Row {
    return this.#store.tx((w) => {
      const was = this.get(id);
      const now = this.#now();
      const on = o.enable === true || (was?.enabled ?? false);
      const source = o.source ? { ...o.source, at: o.source.at || now } : (was?.source ?? { kind: 'local', at: now });
      return w.upsert(this.STATE, { id, kind, enabled: on, source, at: was?.at ?? now, on_at: on && !was?.enabled ? now : (was?.on_at ?? 0) });
    });
  }

  setEnabled(id: string, kind: Row['kind'], on: boolean): Row {
    return this.#store.tx((w) => {
      const was = this.get(id);
      const now = this.#now();
      const row: Row = was ?? { id, kind, enabled: false, source: { kind: 'local', at: now }, at: now, on_at: 0 };
      return w.upsert(this.STATE, { ...row, enabled: on, on_at: on && !row.enabled ? now : row.on_at });
    });
  }

  remove(id: string): void {
    this.#store.tx((w) => {
      w.del(this.STATE, id);
      for (const h of this.#store.query(this.HOOK, { where: { plugin: id } })) w.del(this.HOOK, h.id);
    });
  }

  hookCount(plugin: string, hook: string, session: string): number {
    return this.#store.get(this.HOOK, `${plugin}:${hook}:${session}`)?.n ?? 0;
  }

  countHook(plugin: string, hook: string, session: string): void {
    const id = `${plugin}:${hook}:${session}`;
    this.#store.tx((w) => {
      w.upsert(this.HOOK, { id, plugin, hook, session, n: this.hookCount(plugin, hook, session) + 1, at: this.#now() });
      const old = this.#store.query(this.HOOK, { where: { plugin, hook }, order: [['at', 'desc'], ['id', 'desc']], limit: 1000, offset: HOOK_SESSIONS });
      for (const h of old) w.del(this.HOOK, h.id);
    });
  }

  /** v1's spells.json, read once into the tables (the store's meta remembers it was). */
  async importV1(): Promise<number> {
    if (this.#store.getMeta(`${OWNER}:imported`)) return 0;
    let raw: V1State | undefined;
    try {
      raw = JSON.parse(await fs.readFile(this.#file.path, 'utf8')) as V1State;
    } catch {
      raw = undefined; // none, or unreadable: v1 started empty then too
    }
    const enabled = Array.isArray(raw?.enabled) ? raw.enabled.filter((x): x is string => typeof x === 'string') : [];
    const sources = raw?.sources && typeof raw.sources === 'object' ? raw.sources : {};
    const ids = new Set([...enabled, ...Object.keys(sources)]);
    const now = this.#now();
    this.#store.tx((w) => {
      for (const id of ids) w.upsert(this.STATE, { id, kind: 'spell', enabled: enabled.includes(id), source: sources[id] ?? null, at: sources[id]?.at ?? now, on_at: enabled.indexOf(id) + 1 });
      for (const [plugin, byHook] of Object.entries(raw?.hooks ?? {}))
        for (const [hook, bySession] of Object.entries(byHook ?? {}))
          for (const [session, n] of Object.entries(bySession ?? {})) w.upsert(this.HOOK, { id: `${plugin}:${hook}:${session}`, plugin, hook, session, n: Number(n) || 0, at: now });
    });
    this.#store.setMeta(`${OWNER}:imported`, String(now));
    return ids.size;
  }

  /** The downgrade path: spells.json as v1 reads it, from the tables. */
  async writeV1(): Promise<void> {
    const spells = this.all().filter((r) => r.kind === 'spell');
    const hooks: Record<string, Record<string, Record<string, number>>> = {};
    for (const h of this.#store.query(this.HOOK)) ((hooks[h.plugin] ??= {})[h.hook] ??= {})[h.session] = h.n;
    const sources = Object.fromEntries(spells.filter((r) => r.source).map((r) => [r.id, r.source]));
    await this.#file.save({ enabled: this.enabled().filter((r) => r.kind === 'spell').map((r) => r.id), sources: sources as Record<string, Source>, hooks });
  }
}
