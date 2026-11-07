// The kernel's own entity kinds, on the kernel tables: settings and installed plugins. Both are
// configuration, so both are published on the 'config' topic.

import { defineEntity } from './entity.ts';
import type { EntityDef } from './types.ts';

export interface SettingRow {
  [k: string]: unknown;
  key: string;
  value: unknown;
  /** the plugin whose `setSettings` pins this value, or null */
  locked_by: string | null;
}

export interface PluginRow {
  [k: string]: unknown;
  id: string;
  version: string;
  enabled: boolean;
  config: unknown;
  grants: unknown;
}

export const SETTING: EntityDef<SettingRow> = defineEntity<SettingRow>({
  kind: 'setting',
  table: 'setting',
  key: 'key',
  columns: { key: 'text', value: 'text', locked_by: 'text' },
  json: ['value'],
  topics: () => ['config'],
});

export const PLUGIN: EntityDef<PluginRow> = defineEntity<PluginRow>({
  kind: 'plugin',
  table: 'plugin',
  key: 'id',
  columns: { id: 'text', version: 'text', enabled: 'bool', config: 'text', grants: 'text' },
  json: ['config', 'grants'],
  topics: () => ['config'],
});

export const BUILTIN_ENTITIES: readonly EntityDef[] = [SETTING, PLUGIN];
