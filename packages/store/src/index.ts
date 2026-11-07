// @wisp/store (ADR-0004, plan §4): node:sqlite with WAL, migrations per owner, one write path that
// records every row in the change feed, idempotent mutations, content-addressed blobs, retention,
// write coalescing, atomic JSON files, and the v1 import mechanism.

export { openStore, Store, DEFAULT_RETENTION } from './store.ts';
export type { StoreOptions } from './store.ts';
export { defineEntity } from './entity.ts';
export { StoreError } from './errors.ts';
export type { StoreErrorCode } from './errors.ts';
export { KERNEL_OWNER } from './schema.ts';
export type { MigrateReport } from './migrate.ts';
export { Blobs, INLINE_MAX, hashOf } from './blob.ts';
export type { BlobInfo, Codec, GcResult } from './blob.ts';
export { toMatch } from './search.ts';
export { Coalescer, timerScheduler } from './coalescer.ts';
export type { Buffered, CoalescerOptions, Scheduler } from './coalescer.ts';
export { JsonFile } from './json-file.ts';
export type { JsonFileOptions } from './json-file.ts';
export { importFiles } from './import.ts';
export type { ImportFile, ImportOptions, ImportReport } from './import.ts';
export { PLUGIN, SETTING } from './builtins.ts';
export type { PluginRow, SettingRow } from './builtins.ts';
export type * from './types.ts';
