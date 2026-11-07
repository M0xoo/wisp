// The connectors themselves: rows in the store, secret values in the secrets service, what Settings
// sees, testing one, importing the harnesses' own, and the servers a turn gets (v1 routes/connectors.js
// and connectors.js turnServers). Reads for a turn come from memory: the list is cached until the
// change feed says it changed, and the harnesses' configs are re-read only when their mtime moves.

import type { Json, ProcService, Scope, SecretsService } from '@wisp/kernel';
import type { Store } from '@wisp/store';
import { REACH } from '@wisp-plugin/connectors-api';
import type { Connector, ConnectorBridge, ConnectorsView, McpServers, ProbeResult, ProxySpec } from '@wisp-plugin/connectors-api';
import { ConnectorAuth } from './auth.ts';
import { ConfigFiles, foundServers, foundWithValues, ownNames, type Where } from './harness-config.ts';
import { bad, connectorView, keptKeys, normalizeConnector, secretKey, secretPrefix, type Body } from './model.ts';
import { probe } from './probe.ts';
import { CONNECTOR, DISMISSED, toRow } from './store.ts';

const OWN_FRESH_MS = 1000; // how stale a turn's view of the harnesses' own configs may be
const NONE: ReadonlySet<string> = new Set();

export interface ServiceDeps {
  store: Store;
  secrets: SecretsService;
  fetch(url: string, init?: RequestInit & { timeoutMs?: number }): Promise<Response>;
  proc: Pick<ProcService, 'spawn' | 'which'>;
  now(): number;
  scope: Scope;
  version: string;
  /** where the harnesses keep their configs */
  where: Where;
  /** wisp's home (WISP_HOME), handed to the proxy */
  home: string;
  /** the env a local connector starts from when wisp tests it */
  env: Readonly<Record<string, string | undefined>>;
  emit(type: string, data: Json): void;
  bridge(): ConnectorBridge | undefined;
  /** the bin when nobody provides connectors.bridge */
  launcher: { command: string; args: string[] };
}

export class Connectors {
  readonly #d: ServiceDeps;
  readonly #keys = new Set<string>();
  readonly #files = new ConfigFiles();
  readonly #own = new Map<string, { at: number; names: Record<string, Set<string>>; refreshing?: Promise<void> }>();
  #cache: Connector[] | null = null;
  readonly probing = new Set<string>();
  readonly auth: ConnectorAuth;

  constructor(d: ServiceDeps) {
    this.#d = d;
    this.auth = new ConnectorAuth({
      fetch: d.fetch,
      now: d.now,
      version: d.version,
      secret: (id, k) => this.secret(id, k),
      setSecret: (id, k, v) => this.#set(id, k, v),
      dropSecret: (id, k) => this.#drop(id, k),
      find: (id) => this.find(id),
      save: (c) => this.save(c),
    });
    // The change feed says when the list changed; the next turn reads it again.
    d.scope.add(d.store.onCommit((changes) => {
      if (changes.some((c) => c.entity === CONNECTOR.kind)) this.#cache = null;
    }));
  }

  async init(): Promise<void> {
    for (const k of await this.#d.secrets.keys('connector:')) this.#keys.add(k);
    await this.refreshOwn(null);
  }

  // ---------- rows ----------

  /** fresh from the store (prepared statement), for anything that changes them */
  list(): Connector[] {
    return this.#d.store.query(CONNECTOR, { order: [['added_at', 'asc']] }).map((r) => r.body as Connector);
  }

  /** the cached list, for the per-turn path */
  cached(): readonly Connector[] {
    return (this.#cache ??= this.list());
  }

  find(id: string): Connector | undefined {
    return this.#d.store.get(CONNECTOR, id)?.body;
  }

  must(id: unknown): Connector {
    const c = typeof id === 'string' ? this.find(id) : undefined;
    if (!c) throw bad('no such connector', 404);
    return c;
  }

  save(c: Connector): void {
    this.#d.store.tx((w) => w.upsert(CONNECTOR, toRow(c)));
  }

  dismissed(): string[] {
    return this.#d.store.query(DISMISSED).map((r) => String(r.name));
  }

  dismiss(names: readonly string[]): void {
    this.#d.store.tx((w) => {
      for (const name of names) w.upsert(DISMISSED, { name });
    });
  }

  // ---------- secrets ----------

  has(id: string, k: string): boolean {
    return this.#keys.has(secretKey(id, k));
  }

  secret(id: string, k: string): Promise<string | undefined> {
    return this.#d.secrets.get(secretKey(id, k));
  }

  async #set(id: string, k: string, v: string): Promise<void> {
    await this.#d.secrets.set(secretKey(id, k), v);
    this.#keys.add(secretKey(id, k));
  }

  async #drop(id: string, k: string): Promise<void> {
    await this.#d.secrets.delete(secretKey(id, k));
    this.#keys.delete(secretKey(id, k));
  }

  /** Write a connector's secrets, and drop the ones it no longer has. */
  async storeSecrets(c: Connector, sets: readonly [string, string][]): Promise<void> {
    for (const [k, v] of sets) await this.#set(c.id, k, v);
    const keep = keptKeys(c);
    const prefix = secretPrefix(c.id);
    for (const full of [...this.#keys]) if (full.startsWith(prefix) && !keep.has(full.slice(prefix.length))) await this.#drop(c.id, full.slice(prefix.length));
  }

  async dropAll(id: string): Promise<void> {
    const prefix = secretPrefix(id);
    for (const full of [...this.#keys]) if (full.startsWith(prefix)) await this.#drop(id, full.slice(prefix.length));
  }

  /** Keys it needs that have no value yet (`env:K`, `header:K`). */
  missing(c: Connector): string[] {
    return [...(c.env || []).map((k) => `env:${k}`), ...(c.headers || []).map((k) => `header:${k}`)].filter((k) => !this.has(c.id, k));
  }

  // ---------- writes ----------

  async add(body: Body): Promise<Connector> {
    const { connector, sets } = normalizeConnector(body, this.list(), null, this.#d.now());
    await this.storeSecrets(connector, sets);
    this.save(connector);
    return connector;
  }

  /** returns the connector and whether anything but the switch changed (its last test then says nothing) */
  async update(id: unknown, body: Body): Promise<{ connector: Connector; edited: boolean }> {
    const was = this.must(id);
    const { connector, sets } = normalizeConnector(body, this.list(), was, this.#d.now());
    const edited = Object.keys(body).some((k) => k !== 'enabled' && k !== 'id');
    if (edited) delete connector.test;
    await this.storeSecrets(connector, sets);
    this.save(connector);
    return { connector, edited };
  }

  async remove(id: unknown): Promise<void> {
    const was = this.must(id);
    this.#d.store.tx((w) => w.del(CONNECTOR, was.id));
    await this.dropAll(was.id);
  }

  /** Import servers found in the harnesses' own configs, by name; their values are read here only. */
  async import(names: readonly string[], dismiss: readonly string[]): Promise<{ added: Connector[]; skipped: { name: string; error: string }[] }> {
    if (dismiss.length) this.dismiss(dismiss);
    const added: Connector[] = [];
    const skipped: { name: string; error: string }[] = [];
    for (const f of (await foundWithValues(this.#files, this.#d.where, this.list())).filter((x) => names.includes(x.name))) {
      try {
        added.push(await this.add({ ...f }));
      } catch (err) {
        skipped.push({ name: f.name, error: (err as Error).message });
      }
    }
    return { added, skipped };
  }

  // ---------- what Settings sees ----------

  async view(): Promise<ConnectorsView> {
    const list = this.list();
    const own = await ownNames(this.#files, this.#d.where, null);
    const dismissed = new Set(this.dismissed());
    return {
      connectors: list.map((c) => ({ ...connectorView(c, (k) => this.has(c.id, k)), own: REACH.filter((a) => own[a]?.has(c.name)), testing: this.probing.has(c.id) })),
      found: (await foundServers(this.#files, this.#d.where, list)).filter((f) => !dismissed.has(f.name)),
      reach: [...REACH],
    };
  }

  // ---------- testing one ----------

  /** The only place secret values are gathered: for the proxy (in-process here, or the bin's). */
  async spec(c: Connector): Promise<ProxySpec> {
    const pick = async (prefix: string, keys: readonly string[]): Promise<Record<string, string>> =>
      Object.fromEntries(await Promise.all(keys.map(async (k) => [k, (await this.secret(c.id, `${prefix}:${k}`)) ?? ''] as const)));
    return { connector: c, env: await pick('env', c.env || []), headers: await pick('header', c.headers || []), access: c.oauth ? ((await this.secret(c.id, 'oauth:access')) ?? null) : null };
  }

  /** Runs it once and keeps the outcome on the row: the tool count, or why it failed. */
  async test(id: string): Promise<ProbeResult | null> {
    const c = this.must(id);
    this.probing.add(c.id);
    this.#d.emit('connectors.changed', {});
    let result: ProbeResult;
    try {
      const d = this.#d;
      const deps = { proc: d.proc, net: { fetch: d.fetch }, env: d.env, home: d.where.home, now: d.now, freshToken: async (force: boolean) => this.auth.token(this.find(c.id) ?? c, { force }) };
      result = await probe(await this.spec(c), deps, d.scope, d.version);
    } finally {
      this.probing.delete(c.id);
    }
    const now = this.find(c.id); // it may have been edited or removed meanwhile
    if (now) {
      now.test = result;
      this.save(now);
    }
    this.#d.emit('connectors.changed', {});
    // It works now: a task waiting on its sign-in or keys (wisp_connector_signin) carries on.
    if (result.ok && now) {
      const n = result.count ?? 0;
      this.#d.emit('connectors.works', { id: now.id, name: now.name, count: n, text: `Done: ${now.name} works (${n} tool${n === 1 ? '' : 's'})` });
    }
    return now ? result : null;
  }

  // ---------- per turn ----------

  /** Re-reads the harnesses' own configs for a folder (and the global ones). */
  refreshOwn(cwd: string | null): Promise<void> {
    const key = cwd ?? '';
    const had = this.#own.get(key);
    if (had?.refreshing) return had.refreshing;
    const refreshing = ownNames(this.#files, this.#d.where, cwd).then(
      (names) => void this.#own.set(key, { at: this.#d.now(), names }),
      () => void this.#own.delete(key),
    );
    this.#own.set(key, { at: had?.at ?? 0, names: had?.names ?? {}, refreshing });
    return refreshing;
  }

  #ownNow(cwd: string | null, agent: string): ReadonlySet<string> {
    const key = cwd ?? '';
    const hit = this.#own.get(key);
    if (!hit || this.#d.now() - hit.at > OWN_FRESH_MS) void this.refreshOwn(cwd);
    // A folder not read yet: the global configs say what's known, and the next turn sees its own.
    return (hit?.names[agent] ?? this.#own.get('')?.names[agent]) ?? NONE;
  }

  /**
   * The connectors one turn gets, as mcpServers entries: each starts the proxy by id. Plan mode gets
   * none (their tools would run outside a read-only sandbox, already approved); a harness that has a
   * server by that name in its own config keeps its own. Sync and from memory: the runner asks per turn.
   */
  turnServers(agent: string, mode: string, cwd: string | null): McpServers {
    if (mode === 'plan' || !(REACH as readonly string[]).includes(agent)) return {};
    const on = this.cached().filter((c) => c.enabled !== false);
    if (!on.length) return {};
    const own = this.#ownNow(cwd, agent);
    const b = this.#d.bridge();
    const launcher = b?.launcher() ?? this.#d.launcher;
    const env: Record<string, string> = { WISP_HOME: this.#d.home, ...(b && { WISP_URL: b.url(), WISP_TOKEN: b.token() }) };
    return Object.fromEntries(on.filter((c) => !own.has(c.name)).map((c) => [c.name, { command: launcher.command, args: [...launcher.args, c.id], env }]));
  }
}
