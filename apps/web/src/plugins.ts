// Every plugin UI package in this checkout (plugins/*/ui), registered at start (docs/v2-ui-brief.md).
// Their index modules are small definitions: each extension's component is lazy, so a plugin costs
// its code only once it shows. A module without a default definePluginUi(...) is skipped.

import type { PluginUiDef } from '@wisp/shell';

const found = import.meta.glob<{ default?: PluginUiDef }>(['../../../plugins/*/ui/src/index.ts', '../../../plugins/*/ui/src/index.tsx'], { eager: true });

export function pluginUis(): { path: string; def: PluginUiDef | undefined }[] {
  return Object.entries(found)
    .map(([path, mod]) => ({ path, def: mod.default }))
    .sort((a, b) => a.path.localeCompare(b.path));
}
