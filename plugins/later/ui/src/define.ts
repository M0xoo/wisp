// The typed builders the shell contract names (packages/shell/src/contract.ts: "built with
// defineExtension()/defineView()"). @wisp/shell doesn't export them yet, so they live here: each
// checks its generic once and erases it, as the contract asks. Switch to @wisp/shell's when it ships.

import type { ExtensionDef, PluginUiDef, ViewDef } from '@wisp/shell/contract';

export function defineExtension<C>(def: ExtensionDef<C>): ExtensionDef {
  return def as unknown as ExtensionDef;
}

export function defineView<P>(def: ViewDef<P>): ViewDef {
  return def as unknown as ViewDef;
}

export function definePluginUi(def: PluginUiDef): PluginUiDef {
  return def;
}
