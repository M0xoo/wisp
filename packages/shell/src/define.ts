// The helpers a plugin's src/index.ts uses (docs/v2-ui-brief.md):
//
//   export default definePluginUi({ id: 'wisp.crew', extensions: [defineExtension({...})], views: [...] });
//
// defineExtension and defineView check the typed config and params, then erase them, so one
// plugin's list can hold extensions of different config types. All of it is plain data: nothing
// runs until the shell registers the plugin.

import type { ExtensionId, Intent, Json } from '@wisp/client';
import type { BlockRendererDef, ExtensionDef, PaletteSourceDef, PluginUiDef, SettingsPaneDef, ShortcutDef, ViewDef } from './contract.ts';

export function definePluginUi(def: PluginUiDef): PluginUiDef {
  return def;
}

export function defineExtension<C extends Record<string, unknown> = Record<string, unknown>>(def: ExtensionDef<C>): ExtensionDef {
  return def as unknown as ExtensionDef;
}

export function defineView<P>(def: ViewDef<P>): ViewDef {
  return def as unknown as ViewDef;
}

export const defineSettingsPane = (def: SettingsPaneDef): SettingsPaneDef => def;
export const defineBlock = (def: BlockRendererDef): BlockRendererDef => def;
export const definePalette = (def: PaletteSourceDef): PaletteSourceDef => def;
export const defineShortcut = (def: ShortcutDef): ShortcutDef => def;

/**
 * The client namespace of a plugin: its strings, settings, stores and views are prefixed with it.
 * Built-ins are `wisp.<name>` and use `<name>` ('wisp.crew' → 'crew.title'); anyone else's id is
 * its own namespace.
 */
export function namespaceOf(pluginId: string): string {
  return pluginId.startsWith('wisp.') ? pluginId.slice('wisp.'.length) : pluginId;
}

/** The intent that opens a view with these params, from its definition alone. */
export function viewIntent<P>(def: Pick<ViewDef<P>, 'kind' | 'slot' | 'overlay'>, params: P): Intent {
  const id = def.kind as ExtensionId;
  switch (def.slot) {
    case 'main':
      return { t: 'openView', id, params: (params ?? null) as Json };
    case 'side':
      return { t: 'openSide', side: { kind: 'view', id } };
    case 'overlay':
      return { t: 'openOverlay', overlay: { kind: def.overlay ?? 'dialog', id, params: (params ?? null) as Json } };
  }
}
