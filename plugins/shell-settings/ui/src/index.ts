// @wisp-plugin/shell-settings-ui: the Settings frame (an overlay view) and the shell's own panes:
// General, Appearance, Notifications, Keyboard shortcuts and Diagnostics. Every other pane is a
// plugin's SettingsPaneDef; the frame lists whatever the shell collected, so a user's plugin adds a
// pane exactly as a built-in does (plan §6.0.3).
//
// The shell registers it with what only the shell has (ADR-0003: no private API, these are inputs):
//   shell.register(shellSettingsUi({ panes: () => registry.settingsPanes(), t: client.i18n.t, has: client.i18n.has, diagnostics: client }))
// Open it with `openSettings(pane?)` (the intent); a pane's lede is the catalogue key `<title>.lede`.

import { lazy } from 'solid-js';
import type { Intent, PluginClient } from '@wisp/client';
import type { PluginUiDef, SettingsPaneDef, ViewDef } from '@wisp/shell';
import { SettingsView, parseParams, type FrameDeps } from './frame.tsx';
import { catalogue } from './i18n.ts';
import type { DiagnosticsSource } from './panes/Diagnostics.tsx';
import { followTheme } from './theme.ts';
import { VIEW_ID, type SettingsParams } from './types.ts';

export { GROUP_ORDER, groupPanes, pickPane, type FrameDeps, type PaneEntry } from './frame.tsx';
export { VIEW_ID } from './types.ts';

export const PLUGIN_ID = 'wisp.shell-settings';

/** The intent that opens Settings, on `pane` or (on a phone) on the list. */
export function openSettings(pane?: string): Intent {
  return { t: 'openOverlay', overlay: { kind: 'sheet', id: VIEW_ID, params: pane === undefined ? {} : { pane } } };
}

const General = lazy(() => import('./panes/General.tsx'));
const Appearance = lazy(() => import('./panes/Appearance.tsx'));
const Notifications = lazy(() => import('./panes/Notifications.tsx'));
const Keys = lazy(() => import('./panes/Keys.tsx'));
const Diagnostics = lazy(() => import('./panes/Diagnostics.tsx').then((m) => ({ default: m.DiagnosticsPane })));

export interface ShellSettingsDeps extends FrameDeps {
  readonly diagnostics: DiagnosticsSource;
}

export function shellSettingsPanes(diagnostics: DiagnosticsSource): SettingsPaneDef[] {
  return [
    { id: 'general', group: 'general', title: 'shell-settings.pane.general', icon: 'settings', order: 10, component: General },
    { id: 'appearance', group: 'general', title: 'shell-settings.pane.appearance', icon: 'sun', order: 20, component: Appearance },
    { id: 'notifications', group: 'general', title: 'shell-settings.pane.notifications', icon: 'bell', order: 30, component: Notifications },
    { id: 'keys', group: 'general', title: 'shell-settings.pane.keys', icon: 'grid', order: 40, component: Keys },
    { id: 'diagnostics', group: 'advanced', title: 'shell-settings.pane.diagnostics', icon: 'bug', order: 90, component: (p: { client: PluginClient }) => Diagnostics({ client: p.client, src: diagnostics }) },
  ];
}

export function settingsView(deps: FrameDeps): ViewDef<SettingsParams> {
  return {
    kind: VIEW_ID,
    slot: 'overlay',
    parse: parseParams,
    component: (p) => SettingsView({ client: p.client, params: p.params, deps }),
    title: () => catalogue['shell-settings.title'] ?? 'Settings',
  };
}

export function shellSettingsUi(deps: ShellSettingsDeps): PluginUiDef {
  return {
    id: PLUGIN_ID,
    views: [settingsView(deps) as unknown as ViewDef],
    settings: shellSettingsPanes(deps.diagnostics),
    catalogue,
    setup: (client) => followTheme(client),
  };
}
