// The Settings overlay (v1 openSettings): every plugin's SettingsPaneDef in one frame, grouped and
// ordered, one pane at a time. What's open is navigation: `params.pane` (so a toast's "Settings"
// link, Back and a reload land on the same pane); on a phone no pane means the list, and an
// explicit pane opens straight to it, as in v1. Each pane renders with its own plugin's client and
// inside an ErrorBoundary, so one broken pane never takes Settings down.

import { ErrorBoundary, Show, createMemo, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import type { PluginClient, Vars } from '@wisp/client';
import { usePluginClient, useShell, type SettingsPaneDef } from '@wisp/shell';
import { Callout, EmptyState, SettingsFrame, useSignal, type SettingsNavGroup } from '@wisp/ui';
import { t as own } from './i18n.ts';
import { VIEW_ID, type SettingsParams } from './types.ts';

/** A pane and the client of the plugin that registered it. */
export interface PaneEntry {
  readonly pane: SettingsPaneDef;
  readonly client: PluginClient;
}

/** What the frame reads: every registered pane and a translator (titles are other plugins' keys). */
export interface FrameDeps {
  readonly panes: () => readonly PaneEntry[];
  readonly t: (key: string, vars?: Vars) => string;
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

/** Inside the shell: its panes (each with its plugin's client) and its translator. */
export function shellDeps(): FrameDeps {
  const shell = useShell();
  const panes = useSignal(shell.settingsPanes());
  const clientOf = (plugin: string): PluginClient => usePluginClient(plugin);
  const entries = createMemo(() => panes().map((pane) => ({ pane, client: clientOf((pane as SettingsPaneDef & { plugin?: string }).plugin ?? 'shell') })));
  return { panes: entries, t: (k, v) => shell.t(k, v) };
}

export function SettingsView(props: { readonly client: PluginClient; readonly params: SettingsParams; readonly deps?: FrameDeps }): JSX.Element {
  const deps = props.deps ?? shellDeps();
  const groupLabel = (id: string): string => {
    const key = `shell-settings.group.${id}`;
    const s = deps.t(key);
    return s === key ? id : s;
  };
  const groups = createMemo(() => groupPanes(deps.panes(), (k) => deps.t(k), groupLabel));
  const order = createMemo(() => groups().flatMap((g) => g.items.map((i) => i.id)));
  const current = createMemo(() => pickPane(deps.panes(), order(), props.params.pane));
  const close = (): void => props.client.navigate({ t: 'closeOverlay', id: VIEW_ID });
  const lede = (): string | undefined => {
    const c = current();
    if (!c) return undefined;
    const key = `${c.pane.title}.lede`;
    const s = deps.t(key);
    return s === key ? undefined : s;
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && !e.defaultPrevented) close();
  };
  return (
    <SettingsFrame
      // v1's own name for the whole sheet (.modal.sx), without a namespace: parity measures it by this
      part={'settings' as `${string}.${string}`}
      title={own('shell-settings.title')}
      groups={groups()}
      current={current()?.pane.id ?? ''}
      onPick={(id) => props.client.navigate(settingsIntent(id))}
      paneTitle={current() ? deps.t(current()?.pane.title ?? '') : own('shell-settings.title')}
      lede={lede()}
      view={props.params.pane === undefined ? 'list' : 'pane'}
      onUp={() => props.client.navigate(settingsIntent())}
      upLabel={own('shell-settings.up')}
      onClose={close}
      closeLabel={own('shell-settings.close')}
      onKeyDown={onKey}
    >
      <Show when={current()} keyed fallback={<EmptyState compact icon="settings" title={own('shell-settings.empty')} />}>
        {(entry) => (
          <ErrorBoundary fallback={() => <Callout tone="bad" icon="warn">{own('shell-settings.pane-failed')}</Callout>}>
            <Dynamic component={entry.pane.component} client={entry.client} {...(props.params.filter !== undefined && { filter: props.params.filter })} />
          </ErrorBoundary>
        )}
      </Show>
    </SettingsFrame>
  );
}
