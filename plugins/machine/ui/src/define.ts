// The typed builders of packages/shell/src/define.ts. @wisp/shell's root entry (src/index.ts) isn't
// there yet, so they're re-declared here with the same signatures: each checks its generic once and
// erases it. Switch the imports to '@wisp/shell' when it exports them.

import type { ExtensionDef, PaletteSourceDef, PluginUiDef, SettingsPaneDef, ViewDef } from '@wisp/shell/contract';

export const definePluginUi = (def: PluginUiDef): PluginUiDef => def;
export const defineExtension = <C extends Record<string, unknown> = Record<string, unknown>>(def: ExtensionDef<C>): ExtensionDef => def as unknown as ExtensionDef;
export const defineView = <P>(def: ViewDef<P>): ViewDef => def as unknown as ViewDef;
export const defineSettingsPane = (def: SettingsPaneDef): SettingsPaneDef => def;
export const definePalette = (def: PaletteSourceDef): PaletteSourceDef => def;
