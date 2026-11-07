// Where channels keeps what v1 kept in config.json's `remote` and in each session's `remote`:
// - channels_config: one row per channel (senders, link codes, the ntfy cursor, away threads, …);
// - channels_thread: one row per task a channel started or follows (v1 s.remote);
// - the tokens, in the secrets file (each transport names its secret fields), never in a row;
// - each integration's on switch, as the setting `channels.<name>.enabled` (off by default).
// A save writes only what changed, in one transaction; the hub keeps the live copy in memory.

import type { Json, PluginContext, SecretsService } from '@wisp/kernel';
import type { Migration, Store } from '@wisp/store';
import { defineEntity } from '@wisp/store';
import { type ChannelConfig, type Remote, type TransportDef, TOPIC, switchOf } from '@wisp-plugin/channels-api';
import type { HubState } from '@wisp-plugin/channels-api/kit';
import { OTHERS } from './wisp.ts';

export const OWNER = 'wisp.channels';
const HUB_ROW = '_hub';
const SECRET = 'channels.secret';

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: `CREATE TABLE channels_config (channel TEXT PRIMARY KEY, data TEXT NOT NULL);
         CREATE TABLE channels_thread (session_id TEXT PRIMARY KEY, data TEXT NOT NULL, at INTEGER NOT NULL);`,
  },
];

interface ConfigRow {
  [k: string]: unknown;
  channel: string;
  data: unknown;
}
interface ThreadRow {
  [k: string]: unknown;
  session_id: string;
  data: unknown;
  at: number;
}

export const CONFIG = defineEntity<ConfigRow>({ kind: 'channels.config', table: 'channels_config', key: 'channel', columns: { channel: 'text', data: 'text' }, json: ['data'], topics: () => [TOPIC] });
export const THREAD = defineEntity<ThreadRow>({ kind: 'channels.thread', table: 'channels_thread', key: 'session_id', columns: { session_id: 'text', data: 'text', at: 'int' }, json: ['data'], topics: () => [TOPIC] });

const secretKey = (channel: string, field: string): string => `channels.${channel}.${field}`;

function getPath(o: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((x, k) => (x && typeof x === 'object' ? (x as Record<string, unknown>)[k] : undefined), o);
}
function setPath(o: Record<string, unknown>, path: string, v: unknown): void {
  const keys = path.split('.');
  const last = keys.pop() ?? '';
  let x = o;
  for (const k of keys) x = (x[k] && typeof x[k] === 'object' ? x[k] : (x[k] = {})) as Record<string, unknown>;
  if (v === undefined) delete x[last];
  else x[last] = v;
}

export class ChannelState {
  readonly #store: Store;
  readonly #secrets: SecretsService;
  readonly #ctx: PluginContext;
  readonly #defs: () => readonly TransportDef[];
  readonly #rows = new Map<string, string>(); // channel → the JSON last written
  readonly #secretVals = new Map<string, string>(); // secret key → value last written
  #chain: Promise<unknown> = Promise.resolve(); // secrets and settings writes, in order

  constructor(ctx: PluginContext, store: Store, secrets: SecretsService, defs: () => readonly TransportDef[]) {
    this.#ctx = ctx;
    this.#store = store;
    this.#secrets = secrets;
    this.#defs = defs;
  }

  async load(): Promise<HubState> {
    const cfg: Record<string, ChannelConfig> = {};
    let events: string[] | undefined;
    for (const r of this.#store.query(CONFIG) as ConfigRow[]) {
      this.#rows.set(r.channel, JSON.stringify(r.data));
      if (r.channel === HUB_ROW) events = (r.data as { events?: string[] }).events;
      else cfg[r.channel] = { ...(r.data as ChannelConfig) };
    }
    const secret = await this.#secrets.get(SECRET);
    if (secret) this.#secretVals.set(SECRET, secret);
    const remotes: Record<string, Remote> = {};
    for (const r of this.#store.query(THREAD) as ThreadRow[]) remotes[r.session_id] = r.data as Remote;
    return { cfg, remotes, ...(events && { events }), ...(secret && { secret }) };
  }

  /** A transport came on: its secrets into its config, and its switch. */
  async adopt(d: TransportDef, cfg: Record<string, ChannelConfig>): Promise<void> {
    const c = (cfg[d.name] ||= {});
    c.enabled = this.#ctx.settings.get<boolean>(switchOf(d)) === true;
    for (const field of d.secrets ?? []) {
      const key = secretKey(d.name, field);
      const v = await this.#secrets.get(key);
      if (v !== undefined && getPath(c, field) === undefined) (this.#secretVals.set(key, v), setPath(c, field, v));
    }
  }

  /** The secret-free row of a channel, and its secrets and switch apart. */
  #split(name: string, c: ChannelConfig): { row: Record<string, unknown>; secrets: Map<string, string | undefined>; enabled: boolean } {
    const row = structuredClone(c) as Record<string, unknown>;
    const enabled = row['enabled'] === true;
    delete row['enabled'];
    const secrets = new Map<string, string | undefined>();
    for (const field of this.#defs().find((d) => d.name === name)?.secrets ?? []) {
      const v = getPath(row, field);
      secrets.set(secretKey(name, field), typeof v === 'string' && v ? v : undefined);
      setPath(row, field, undefined);
    }
    return { row, secrets, enabled };
  }

  persist({ cfg, events, secret }: { cfg: Record<string, ChannelConfig>; events: string[]; secret: string }): void {
    const rows: ConfigRow[] = [];
    const secrets = new Map<string, string | undefined>(secret ? [[SECRET, secret]] : []);
    const switches: [string, boolean][] = [];
    const hub = JSON.stringify({ events });
    if (this.#rows.get(HUB_ROW) !== hub) rows.push({ channel: HUB_ROW, data: { events } });
    for (const [name, c] of Object.entries(cfg)) {
      const s = this.#split(name, c);
      const json = JSON.stringify(s.row);
      if (this.#rows.get(name) !== json) rows.push({ channel: name, data: s.row as Json });
      for (const [k, v] of s.secrets) secrets.set(k, v);
      const def = this.#defs().find((d) => d.name === name);
      if (def && (this.#ctx.settings.get<boolean>(switchOf(def)) === true) !== s.enabled) switches.push([switchOf(def), s.enabled]);
    }
    if (rows.length) {
      this.#store.tx((w) => {
        for (const r of rows) w.upsert(CONFIG, r);
      });
      for (const r of rows) this.#rows.set(r.channel, JSON.stringify(r.data));
    }
    for (const [k, v] of secrets) if ((this.#secretVals.get(k) ?? undefined) !== v) this.#later(k, v);
    for (const [key, value] of switches) this.#queue(() => this.#ctx.run(OTHERS.settingsSet, { key, value }));
  }

  #later(key: string, v: string | undefined): void {
    if (v === undefined) this.#secretVals.delete(key);
    else this.#secretVals.set(key, v);
    this.#queue(() => (v === undefined ? this.#secrets.delete(key) : this.#secrets.set(key, v)));
  }

  #queue(fn: () => Promise<unknown>): void {
    this.#chain = this.#chain.then(fn).catch((err: unknown) => this.#ctx.log.warn(`channels: couldn’t save: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** Secrets and switches still being written (tests, and shutdown). */
  flushed(): Promise<unknown> {
    return this.#chain;
  }

  persistRemote(id: string, remote: Remote): void {
    this.#store.tx((w) => void w.upsert(THREAD, { session_id: id, data: remote as Json, at: this.#ctx.clock.now() }));
  }

  dropRemote(id: string): void {
    this.#store.tx((w) => void w.del(THREAD, id));
  }
}
