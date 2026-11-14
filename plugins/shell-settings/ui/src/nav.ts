// The Settings overlay's nav and params (frame.tsx): plain, so their tests needn't compile the frame.
import type { PluginClient } from '@wisp/client';
import type { SettingsPaneDef } from '@wisp/shell';
import type { SettingsNavGroup } from '@wisp/ui';
import { VIEW_ID, type SettingsParams } from './types.ts';

/** A pane and the client of the plugin that registered it. */
export interface PaneEntry {
  readonly pane: SettingsPaneDef;
  readonly client: PluginClient;
}

/** The contract's groups, in the order they show. Unknown groups follow, alphabetically. */
export const GROUP_ORDER = ['general', 'agents', 'usage', 'integrations', 'computers', 'advanced'] as const;

const rank = (g: string): number => {
  const i = (GROUP_ORDER as readonly string[]).indexOf(g);
  return i < 0 ? GROUP_ORDER.length : i;
};

/** v1's Settings, in its order (v1 web/js/features/settings.js SECTIONS): one flat list, no headings. A pane v1
 * didn't have follows them, by its group and `order` (Theme, Keyboard shortcuts, Updates, All settings, …). */
export const V1_ORDER = ['general', 'notifications', 'agents', 'connectors', 'auto', 'machines', 'cloud', 'memory', 'automations', 'plugins', 'machine', 'worktrees', 'usage', 'privacy'] as const;

const v1Rank = (id: string): number => {
  const i = (V1_ORDER as readonly string[]).indexOf(id);
  return i < 0 ? V1_ORDER.length : i;
};

/** The nav: one group without a heading (v1's flat list), v1's panes first in its order. Pure, for tests. */
export function groupPanes(entries: readonly PaneEntry[], title: (key: string) => string, _groupLabel?: (id: string) => string): SettingsNavGroup[] {
  const sorted = [...entries].sort(
    (a, b) =>
      v1Rank(a.pane.id) - v1Rank(b.pane.id) ||
      rank(a.pane.group) - rank(b.pane.group) ||
      a.pane.group.localeCompare(b.pane.group) ||
      (a.pane.order ?? 100) - (b.pane.order ?? 100) ||
      title(a.pane.title).localeCompare(title(b.pane.title)),
  );
  if (sorted.length === 0) return [];
  return [{ id: 'all', items: sorted.map((e) => ({ id: e.pane.id, label: title(e.pane.title), icon: e.pane.icon as SettingsNavGroup['items'][number]['icon'] })) }];
}

/** The pane to show: the one asked for if it's there, else the first in nav order. */
export function pickPane(entries: readonly PaneEntry[], order: readonly string[], asked: string | undefined): PaneEntry | undefined {
  const found = asked === undefined ? undefined : entries.find((e) => e.pane.id === asked);
  return found ?? entries.find((e) => e.pane.id === order[0]);
}

export function parseParams(p: unknown): SettingsParams {
  const o = p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
  const pane = typeof o['pane'] === 'string' && o['pane'] !== '' ? o['pane'] : undefined;
  const filter = typeof o['filter'] === 'string' && o['filter'] !== '' ? o['filter'] : undefined;
  return { ...(pane !== undefined && { pane }), ...(filter !== undefined && { filter }) };
}

/** The intent that opens Settings on `pane` (or, on a phone, on the list). */
export function settingsIntent(pane?: string, filter?: string) {
  const params = { ...(pane !== undefined && { pane }), ...(filter !== undefined && { filter }) };
  return { t: 'openOverlay' as const, overlay: { kind: 'viewer' as const, id: VIEW_ID, params } };
}
