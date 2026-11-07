// @wisp/shell: the extension host and the app frame (plan §4.6, §6.6, §7). A plugin's UI package
// imports definePluginUi and the define* helpers, renders its inputs with <Slot>, and reads the
// shell's state through useShell(). apps/web creates the shell and renders it.

export * from './contract.ts';
export { definePluginUi, defineExtension, defineView, defineSettingsPane, defineBlock, definePalette, defineShortcut, namespaceOf, viewIntent } from './define.ts';
export { createShell, type Shell, type ShellOptions, type ShellWindow } from './shell.tsx';
export { useShell, useT } from './context.tsx';
export { Slot, Area, ExtView, useExtensions, usePluginClient } from './slot.tsx';
export { BUILT_IN_KEYS, displayCombo, matches, parseCombo } from './keys.ts';
export { rank as rankPalette, fuzzy, splitQuery } from './palette/match.ts';
export { commandErrorToast } from './toasts.ts';
export { PREPAINT_THEME, THEME_KEY, THEMES } from './theme.ts';
export { CORE_TOPICS } from './watch.ts';
export { useNow } from './clock.ts';
export { detectPlatform, nullPlatform, browserPlatform, desktopPlatform, androidPlatform } from './platform/index.ts';
export type * from './platform/types.ts';
