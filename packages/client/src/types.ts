// Shared type vocabulary: branded ids, Json, DeepReadonly, the setting declaration and the wire
// error. These were the TypeScript kernel's contract shapes; the kernel moved to the Rust backend,
// so the client owns its copies. The manifest JSON a peer sends stays the source of truth for
// `SettingDecl`.

export type Brand<T, B extends string> = T & { readonly __brand: B };
export type PeerId = Brand<string, 'PeerId'>;
export type PluginId = Brand<string, 'PluginId'>;
export type SessionId = Brand<string, 'SessionId'>;
export type CrewId = Brand<string, 'CrewId'>;
export type ExtensionId = Brand<string, 'ExtensionId'>;
/** `<peer>:<id>`: an entity's origin-prefixed key (plan §7.2.1). */
export type EntityKey = Brand<string, 'EntityKey'>;

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type DeepReadonly<T> = T extends (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends readonly (infer V)[]
    ? readonly DeepReadonly<V>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

export interface Disposable {
  dispose(): void;
}

/** The one wire error (plan §3.1 rule 8). */
export interface WireError {
  code: string;
  message: string;
  retry?: boolean;
}

/** A manifest setting declaration (kernel `SettingDecl`). */
export interface SettingDecl {
  readonly key: string;
  readonly type: 'string' | 'int' | 'bool' | 'enum' | 'json';
  readonly values?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly default?: Json;
  readonly overridable?: boolean;
  readonly scope?: 'server' | 'device';
  readonly secret?: boolean;
}

/** Warnings go through an injected sink, never straight to console, so tests can see them. */
export type Warn = (msg: string, data?: unknown) => void;

export function assertNever(x: never, what: string): never {
  throw new Error(`unhandled ${what}: ${JSON.stringify(x)}`);
}
