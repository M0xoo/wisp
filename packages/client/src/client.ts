// The client: the six kinds of state wired together (plan §4.6.2). The entity writer stays in
// here, held by the peer manager (sync) and the command runner; everything the app and plugins
// get reads. `plugin(id)` hands a plugin the same APIs a built-in uses, all owned by its scope, so
// switching it off drops its stores, views, strings, settings, machines and subscriptions.

import { createCommands, type CommandDef, type CommandError, type Commands } from './commands.ts';
import { createStoreHost, type PluginStore, type StoreDecl } from './define-store.ts';
import { createDevtools, type Devtools } from './devtools.ts';
import { createDrafts, type Drafts } from './drafts.ts';
import { createEntityStore, type EntityReader } from './entities.ts';
import { loadFirstPaint, persistEntities, restoreFirstPaint } from './first-paint.ts';
import { createI18n, type Catalogue, type I18n } from './i18n.ts';
import { interpret, type Machine, type MachineDef } from './machine.ts';
import { createNavigation, decodeNav, type HistoryAdapter, type Navigation } from './nav-url.ts';
import type { Intent } from './nav.ts';
import { createPeers, type PeerConfig, type Peers } from './peers.ts';
import { memoryPersist, type Persist } from './persist.ts';
import { createScope, type Scope } from './scope.ts';
import { createSettings, type Settings, type TypedSettings } from './settings.ts';
import type { Timers } from './clock.ts';
import type { Json, PeerId, SettingDecl, Warn } from './types.ts';
import { createTranscripts, type Transcript, type Transcripts } from './transcript.ts';
import { createViews, type ViewDecl, type ViewHandle, type ViewRegistry } from './views.ts';

export interface ClientOptions {
  clientId: string;
  build: string;
  /** this client's own wisp: where server-scoped settings live */
  home: PeerId;
  width: number;
  persist?: Persist;
  timers?: Timers;
  history?: HistoryAdapter;
  dev?: boolean;
  warn?: Warn;
  /** a command was refused: show the toast */
  onError?: (err: CommandError, cmd: string) => void;
}

export interface PluginClient {
  readonly id: string;
  readonly scope: Scope;
  readonly entities: EntityReader;
  defineStore<T extends Json>(decl: StoreDecl<T>): PluginStore<T>;
  registerView<P extends Json>(decl: ViewDecl<P>): ViewHandle<P>;
  strings(catalogue: Catalogue): void;
  settings<const D extends readonly SettingDecl[]>(decls: D): TypedSettings<D>;
  machine<S extends string, E extends string, C>(def: MachineDef<S, E, C>, ctx: C, owner?: Scope): Machine<S, E>;
  run<A, R>(cmd: CommandDef<A, R>, args: A): Promise<R>;
  navigate(intent: Intent): void;
  /** a task's events, tail first, paged backwards; owned by `owner` (the task view) */
  transcript<T = unknown>(peer: PeerId, sessionId: string, owner?: Scope): Transcript<T>;
}

export interface Client {
  readonly scope: Scope;
  readonly entities: EntityReader;
  readonly peers: Omit<Peers, 'add' | 'remove'>;
  readonly nav: Navigation;
  readonly views: ViewRegistry;
  readonly commands: Pick<Commands, 'run' | 'pending'>;
  readonly drafts: Drafts;
  readonly transcripts: Transcripts;
  readonly settings: Settings;
  readonly i18n: I18n;
  readonly devtools: Devtools;
  /** paints from disk, then connects to every peer */
  start(peers: readonly PeerConfig[]): Promise<void>;
  addPeer(cfg: PeerConfig): void;
  removePeer(peer: PeerId): void;
  plugin(id: string): PluginClient;
  /** writes what's waiting (rows, drafts) now: before the page hides */
  flush(): Promise<void>;
  dispose(): void;
}

// size-ok: a factory; its body is small closures over shared private state, each under the cap
export function createClient(o: ClientOptions): Client {
  const scope = createScope('client', o.timers);
  const devtools = createDevtools(() => scope.timers.now());
  const warn: Warn = (msg, data) => {
    devtools.record({ kind: 'warn', message: msg });
    o.warn?.(msg, data);
  };
  const persist = o.persist ?? memoryPersist();
  const { reader, writer } = createEntityStore(warn);
  const peers = createPeers({ scope, writer, clientId: o.clientId, build: o.build, warn, devtools });
  const commands = createCommands({ reader, writer, peers, persist, devtools, warn, now: () => scope.timers.now(), ...(o.onError && { onError: o.onError }) });
  const views = createViews();
  const transcripts = createTranscripts({ reader, writer, peers });
  const drafts = createDrafts({ scope, persist, warn });
  const settings = createSettings({ reader, commands, home: o.home, persist, warn });
  const i18n = createI18n({ dev: o.dev === true, warn });
  const stores = createStoreHost({ persist, warn });
  const saveNav = (url: string): void => {
    persist.write([{ ns: 'nav', key: 'last', value: url }]).catch(() => {});
  };
  const nav = createNavigation({ scope, width: o.width, views, warn, onChange: saveNav, ...(o.history && { history: o.history }) });
  const rows = persistEntities({ writer, persist, scope, warn, linkOf: (p) => peers.save(p) });

  const client: Client = {
    scope,
    entities: reader,
    peers,
    nav,
    views,
    commands,
    drafts,
    transcripts,
    settings,
    i18n,
    devtools,
    async start(list) {
      const saved = await loadFirstPaint(persist);
      restoreFirstPaint(writer, saved);
      await Promise.all([drafts.load(), settings.load()]);
      const last = await persist.get('nav', 'last');
      // plugins registered their views by now, so the URL may name one; when it says nothing
      // (`/`), the app goes back where it was
      const url = o.history?.read() ?? '/';
      nav.navigate({ t: 'restore', to: decodeNav(url === '/' && typeof last === 'string' ? last : url) });
      for (const cfg of list) {
        const link = saved.get(cfg.peer)?.link;
        peers.add(link && !cfg.saved ? { ...cfg, saved: link } : cfg);
      }
      await commands.restore();
    },
    addPeer: (cfg) => peers.add(cfg),
    removePeer: (peer) => peers.remove(peer),
    plugin: (id) => pluginClient(id),
    async flush() {
      await Promise.all([rows.flush(), drafts.flush()]);
    },
    dispose: () => scope.dispose(),
  };

  function pluginClient(id: string): PluginClient {
    const ps = scope.child(`plugin:${id}`);
    return {
      id,
      scope: ps,
      entities: reader,
      defineStore: (decl) => stores.define(id, ps, decl),
      registerView: (decl) => {
        if (!decl.id.startsWith(`${id}.`)) throw new Error(`${id} can't register the view ${decl.id}`);
        return views.register(ps, decl);
      },
      strings: (catalogue) => i18n.register(id, catalogue, ps),
      settings: (decls) => settings.register(id, ps, decls),
      machine(def, ctx, owner = ps) {
        const m = interpret(def, owner, ctx, {
          warn,
          onTransition: (machine, from, via, to) => devtools.record({ kind: 'transition', machine, from, via, to }),
        });
        owner.add(devtools.machine(def.id, m.state));
        return m;
      },
      run: (cmd, args) => commands.run(cmd, args),
      navigate: (intent) => nav.navigate(intent),
      transcript: (peer, sessionId, owner = ps) => transcripts.open(peer, sessionId, owner),
    };
  }

  return client;
}
