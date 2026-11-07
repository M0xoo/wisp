// Shared type vocabulary. These mirror @wisp/kernel's contract (Brand, Json, DeepReadonly, Scope,
// SettingDecl) structurally: the kernel's public entry (src/index.ts) doesn't exist yet, and the
// client must not reach into another package's src/. Switch to `import type … from '@wisp/kernel'`
// once it exports them; the shapes are identical, so nothing else changes.

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
