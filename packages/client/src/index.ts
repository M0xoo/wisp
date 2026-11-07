// @wisp/client: the client's six kinds of state (plan §4.6, ADR-0006), peers and transports
// (§7.2.1, §7.3). Framework-independent TypeScript on alien-signals; Solid binds natively, React
// through `subscribe`. The entity writer is not exported: only the sync layer and the command
// runner inside this package write rows.

export { batch, computed, effect, effectScope, readonly, signal, subscribe, untracked } from './signals.ts';
export type { Readable, WritableSignal } from './signals.ts';
export { createScope } from './scope.ts';
export type { Scope } from './scope.ts';
export { realTimers } from './clock.ts';
export type { TimerHandle, Timers } from './clock.ts';
export { entityKey, ownerOf, peerId, uuidv7 } from './ids.ts';
export type * from './types.ts';
export { assertNever } from './types.ts';

// kind 1: entities
export type { ChangedRow, EntityReader, PendingInfo, StoredRow } from './entities.ts';
export type { EntityOps, LocalOp } from './ops.ts';
// kind 2: derived
export { byKeys, count, family, filterBy, groupBy, mapTo, some, sortBy } from './selectors.ts';
export type { Family } from './selectors.ts';
// kind 3: navigation
export { HOME, NO_SIDE, SPLIT_MIN_WIDTH, initialNav, layoutFor, navigate, pushes, sameNav } from './nav.ts';
export type { Intent, Layout, Main, Nav, Overlay, Side, Target } from './nav.ts';
export { browserHistory, createNavigation, decodeNav, encodeNav, memoryHistory } from './nav-url.ts';
export type { HistoryAdapter, Navigation, NavigationOptions, WindowLike } from './nav-url.ts';
export { createViews } from './views.ts';
export type { Slot, ViewDecl, ViewHandle, ViewRegistry } from './views.ts';
// kind 4: flows
export { interpret, machine, paths, transitionsOf } from './machine.ts';
export type { Machine, MachineDef, MachineHooks, MachinePaths, StateNode, Step, Transition } from './machine.ts';
// writes
export { CommandError, defineCommand, stableJson } from './commands.ts';
export type { CommandDef, Commands, PendingRecord, PendingView } from './commands.ts';
export type { Paging, Transcript, Transcripts } from './transcript.ts'; // opened through createClient: the loader holds the writer
// kind 5: drafts
export type { Drafts } from './drafts.ts';
// kind 6: preferences
export { setSetting, validateSetting } from './settings.ts';
export type { SettingRow, Settings, SettingValue, TypedSettings } from './settings.ts';
export type { PluginStore, StoreDecl } from './define-store.ts';
// persistence
export { memoryPersist } from './persist.ts';
export type { Persist, PersistWrite } from './persist.ts';
export { indexedDBPersist } from './persist-idb.ts';
export type { IdbFactory, IdbKeyRangeStatic } from './persist-idb.ts';
// peers and transports
export type { PeerConfig, PeerStatus, Peers } from './peers.ts';
export type { LinkSaved, PeerLink } from './peer.ts';
export { PeerDown } from './transport.ts';
export type { Frame, Transport } from './transport.ts';
export { httpTransport } from './http.ts';
export type { FetchLike, FetchResponse, HttpTransportOptions } from './http.ts';
export { compareVersions, hasFeature, updateReason } from './features.ts';
export type { FeatureAnswer, FeatureNeed } from './features.ts';
// i18n, devtools
export type { Catalogue, I18n, Vars } from './i18n.ts';
export type { DevEntry, Devtools } from './devtools.ts';
// the whole client
export { createClient } from './client.ts';
export type { Client, ClientOptions, PluginClient } from './client.ts';
