// The kernel's settings backend on the store: server-scoped values are `setting` rows (topic 'config', so
// every client hears a change), device-scoped ones never reach the server. On the first start over a v1
// home, config.json's `defaults` become values under the same keys (the manifests kept v1's names), once.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Json, SettingsBackend } from '@wisp/kernel';
import { SETTING, type Store } from '@wisp/store';

const IMPORTED = 'import:v1-config-defaults';

function v1Defaults(home: string): Record<string, Json> {
  try {
    // startup only: one read of a small file
    const config: unknown = JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf8'));
    const d = typeof config === 'object' && config !== null ? (config as Record<string, unknown>)['defaults'] : undefined;
    return typeof d === 'object' && d !== null && !Array.isArray(d) ? (d as Record<string, Json>) : {};
  } catch {
    return {};
  }
}

export function storeSettings(store: Store, home: string): SettingsBackend {
  return {
    load(scope) {
      if (scope !== 'server') return {};
      if (store.getMeta(IMPORTED) === undefined) {
        const defaults = v1Defaults(home);
        store.tx((w) => {
          for (const [key, value] of Object.entries(defaults)) if (!store.get(SETTING, key)) w.upsert(SETTING, { key, value, locked_by: null });
        });
        store.setMeta(IMPORTED, String(Date.now()));
      }
      const out: Record<string, Json> = {};
      for (const row of store.query(SETTING)) out[String(row.key)] = row.value as Json;
      return out;
    },
    save(key, value, scope) {
      if (scope !== 'server') return;
      store.tx((w) => {
        if (value === undefined) w.del(SETTING, key);
        else w.upsert(SETTING, { key, value, locked_by: null });
      });
    },
  };
}
