// The kernel's public contract (ADR-0003). Every plugin, built-in or not, sees only this file's
// types plus other plugins' `api` packages. Implementations live next to it; nothing here runs.
//
// Rule of thumb (plan §6.11): an action is a command, a fact is an event, a no is an interceptor,
// an implementation is an extension point, watching data is a topic, a handle is a service.

// ---------- ids ----------

/** A branded string: `SessionId` is not a `CrewId`, even though both are strings. */
export type Brand<T, B extends string> = T & { readonly __brand: B };
export type PluginId = Brand<string, 'PluginId'>; // 'wisp.runtime', 'wisp.claude', 'acme.thing'
export type PeerId = Brand<string, 'PeerId'>; // stable per install, made once
export type Seq = number; // change-feed sequence, per (peer, epoch)
/** `<peer>:<uuidv7>`: an id made on one peer, unique across all of them. */
export type OriginId = Brand<string, 'OriginId'>;

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type DeepReadonly<T> = T extends (infer U)[] ? readonly DeepReadonly<U>[] : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

// ---------- the manifest (wisp-plugin.json) ----------

export type Activation = 'onStartup' | `onCommand:${string}` | `onTopic:${string}` | `onView:${string}` | `onBlock:${string}` | `onSchedule:${string}`;

export interface Requirement {
  version: string; // semver range
  optional?: boolean;
}

export interface SettingDecl {
  key: string; // owner-prefixed: 'claude.model'
  type: 'string' | 'int' | 'bool' | 'enum' | 'json';
  values?: readonly string[];
  min?: number;
  max?: number;
  default?: Json;
  /** another plugin may set and lock it (`contributes.settings`) */
  overridable?: boolean;
  /** 'server': synced in the store; 'device': this client only */
  scope?: 'server' | 'device';
  secret?: boolean;
}

export interface UiExtensionDecl {
  id: string;
  attachTo: { id: string; input: string };
  /** module specifier inside the plugin's ui package, `./x#Export`; absent for declarative extensions */
  component?: string;
  /** declarative extension made of kit descriptors (buttons, chips, panes) */
  kit?: Json;
  config?: Json;
  if?: string;
  priority?: number;
}

export interface Manifest {
  wispPlugin: 1;
  id: string;
  name?: string;
  version: string;
  api: string; // kernel api range, '^1'
  description?: string;
  author?: string;
  kind?: 'plugin' | 'module';
  /** for a module: the one plugin it extends */
  extends?: string;
  /** plugins or services (by contract id, 'git.service') this one needs */
  requires?: Record<string, string | Requirement>;
  /** services this plugin provides, by contract id → version */
  provides?: Record<string, { version: string }>;
  permissions?: readonly string[];
  /** 'builtin' runs in-process; 'exec' is a subprocess over JSON-RPC (the one external tier) */
  server?: { builtin: string } | { exec: readonly string[] };
  activation?: readonly Activation[];
  /** turn this plugin's extensions off, by id (a plugin with only a manifest can do this) */
  disable?: readonly string[];
  contributes?: {
    commands?: readonly { id: string; title: string; optimistic?: 'none' | 'declared' }[];
    events?: readonly string[];
    topics?: readonly string[];
    points?: readonly { id: string; version: number; kind: 'list' | 'interceptor' | 'subscriber' }[];
    settings?: readonly SettingDecl[];
    /** values for other plugins' overridable settings, locked by this plugin */
    setSettings?: Record<string, Json>;
    ui?: readonly UiExtensionDecl[];
    parts?: readonly string[];
    partStyles?: Record<string, Record<string, string>>;
    icons?: readonly string[];
    blocks?: readonly { type: string; schema?: Json }[];
    recipes?: readonly Json[];
    /** contributions into another plugin's list point, keyed by point id */
    [point: `${string}.${string}`]: unknown;
  };
  migrations?: string;
  trust?: 'declarative' | 'untrusted' | 'trusted';
}

// ---------- calls, traces, errors ----------

/** Every call carries a trace (plan §6.11.2): depth ≤ 8, no re-entering a (plugin, hook) pair. */
export interface Trace {
  readonly root: string; // root command id (uuidv7)
  readonly depth: number;
  readonly stack: readonly string[]; // `${plugin}:${hook}`
  /** the capability set this call speaks for: 'user:full', 'agent:session:<id>', 'agent:capped', … */
  readonly caller: Caller;
  readonly signal: AbortSignal;
  /** true inside an interceptor (and whatever it calls): only readOnly commands and service methods */
  readonly readOnly?: boolean;
}

export interface Caller {
  readonly set: string; // capability set id
  readonly session?: string;
  readonly plugin?: PluginId;
}

export type WispErrorCode =
  | 'not_found' | 'invalid' | 'forbidden' | 'conflict' | 'unavailable'
  | 'depth_exceeded' | 'reentrant_hook' | 'timeout' | 'service_gone' | 'vetoed'
  | 'plugin_off' | 'internal';

/** The one wire error: `{code, message, retry}` (plan §3.1 rule 8). */
export interface WireError {
  code: WispErrorCode | (string & {});
  message: string;
  retry?: boolean;
  details?: Json;
}

// ---------- commands, events, interceptors ----------

export interface CommandDef<A = unknown, R = unknown> {
  id: string; // 'runtime.start'
  /** permission checked before the handler: defaults to `${owner}:${local id}` */
  permission?: string;
  /** true: a read, allowed inside an interceptor */
  readOnly?: boolean;
  parse?: (args: unknown) => A;
  run(args: A, ctx: CallContext): Promise<R> | R;
}

export type Verdict<C = unknown> =
  | { kind: 'continue' }
  | { kind: 'modify'; ctx: C }
  | { kind: 'veto'; code: string; message: string; then?: readonly { cmd: string; args: unknown }[] };

export interface InterceptorDef<C = unknown> {
  /** the hook: 'before:run', 'before:delegate', 'before:ship', … */
  hook: string;
  priority?: number; // lower runs first
  /** guard = 'closed': a timeout vetoes. Others are skipped with a warning. */
  failure?: 'open' | 'closed';
  timeoutMs?: number; // 200 by default, at most 2000
  run(ctx: C, call: CallContext): Promise<Verdict<C>> | Verdict<C>;
}

export interface EventEnvelope<T = unknown> {
  seq: Seq;
  type: string; // 'turn.finished'
  plugin: PluginId;
  at: number;
  data: T;
}

// ---------- services ----------

/** A typed contract another plugin may provide (plan §6.11.1). */
export interface ServiceRef<T> {
  readonly id: string; // 'git.service'
  readonly major: number;
  /** method → permission. CI checks every method maps to one. */
  readonly permissions: Readonly<Record<string, string>>;
  readonly readOnly?: readonly string[];
  /** phantom, for inference only */
  readonly __type?: T;
}

export interface Disposable {
  dispose(): void;
}

/** Everything a plugin registers belongs to a scope; deactivating is dropping the scope. */
export interface Scope {
  readonly signal: AbortSignal;
  readonly alive: boolean;
  add(d: Disposable | (() => void)): void;
  child(name: string): Scope;
  timeout(ms: number, fn: () => void): void;
  interval(ms: number, fn: () => void): void;
  dispose(): void;
}

// ---------- kernel services (injected; an install may override any of them) ----------

export interface Clock {
  now(): number;
}
export interface Log {
  debug(msg: string, data?: Json): void;
  info(msg: string, data?: Json): void;
  warn(msg: string, data?: Json): void;
  error(msg: string, data?: Json): void;
}

export interface PluginContext {
  readonly id: PluginId;
  readonly manifest: DeepReadonly<Manifest>;
  readonly scope: Scope;
  readonly clock: Clock;
  readonly log: Log;
  /** typed settings declared in manifests; `get` answers locked values first */
  readonly settings: {
    get<T extends Json>(key: string): T | undefined;
    watch(key: string, fn: (v: Json | undefined) => void): Disposable;
  };
  /** kernel services by name ('store', 'proc', 'fs', 'net', 'secrets', 'blob', 'notify', 'http') */
  service<T>(name: string): T;
  /** another plugin's service by contract; throws `service_gone` / `forbidden` */
  use<T>(ref: ServiceRef<T>, opts?: UseOptions): T;
  /** use() for an optional dependency: undefined when nobody provides it */
  tryUse<T>(ref: ServiceRef<T>, opts?: UseOptions): T | undefined;
  provide<T>(ref: ServiceRef<T>, impl: T): void;
  command<A, R>(def: CommandDef<A, R>): void;
  intercept<C>(def: InterceptorDef<C>): void;
  on<T>(type: string, fn: (e: EventEnvelope<T>) => void | Promise<void>): void;
  emit<T extends Json>(type: string, data: T): void;
  /** contribute into a list point owned by some plugin */
  contribute<T>(point: string, item: T): void;
  /** read a list point this plugin owns (or may read) */
  contributions<T>(point: string): readonly T[];
  run<R = unknown>(cmd: string, args?: unknown, call?: Partial<Pick<Trace, 'caller'>>): Promise<R>;
}

export interface UseOptions {
  /** called once when the provider goes off; later calls throw `service_gone` */
  onLost?: (reason: string) => void;
}

export interface CallContext extends PluginContext {
  readonly trace: Trace;
  /** run a command as part of this call (depth + 1, same trace) */
  run<R = unknown>(cmd: string, args?: unknown): Promise<R>;
  /**
   * Run every interceptor of `hook` on `ctx`, in priority order. Resolves to the context after any
   * `modify`; rejects with `vetoed` (details: `{by, reason}`) when one refuses.
   */
  runHook<C>(hook: string, ctx: C): Promise<C>;
}

/** What a plugin's host module exports as default. */
export interface PluginDef {
  id: string;
  setup(ctx: PluginContext): void | Promise<void>;
}

export type PluginState = 'discovered' | 'resolved' | 'active' | 'off' | 'refused';

export interface PluginStatus {
  id: PluginId;
  version: string;
  state: PluginState;
  reason?: string;
  trust: 'declarative' | 'untrusted' | 'trusted';
  builtin: boolean;
  /** its event queue passed the cap: it catches up from the change feed by cursor */
  lagging?: boolean;
}
