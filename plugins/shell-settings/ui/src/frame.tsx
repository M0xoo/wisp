// The Settings overlay (v1 openSettings): every plugin's SettingsPaneDef in one frame, grouped and
// ordered, one pane at a time. What's open is navigation: `params.pane` (so a toast's "Settings"
// link, Back and a reload land on the same pane); on a phone no pane means the list, and an
// explicit pane opens straight to it, as in v1. Each pane renders with its own plugin's client and
// inside an ErrorBoundary, so one broken pane never takes Settings down.

import { ErrorBoundary, Show, createMemo, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import type { PluginClient, Vars } from '@wisp/client';
import { usePluginClient, useShell, type SettingsPaneDef } from '@wisp/shell';
import { Callout, EmptyState, SettingsFrame, useSignal } from '@wisp/ui';
import { t as own } from './i18n.ts';
import { VIEW_ID, type SettingsParams } from './types.ts';
import { groupPanes, pickPane, settingsIntent, type PaneEntry } from './nav.ts';

/** What the frame reads: every registered pane and a translator (titles are other plugins' keys). */
export interface FrameDeps {
  readonly panes: () => readonly PaneEntry[];
  readonly t: (key: string, vars?: Vars) => string;
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
      rootPart={'settings.frame' as `${string}.${string}`}
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
          <ErrorBoundary
            fallback={() => (
              <Callout tone="bad" icon="warn">
                {own('shell-settings.pane-failed')}
              </Callout>
            )}
          >
            <Dynamic component={entry.pane.component} client={entry.client} {...(props.params.filter !== undefined && { filter: props.params.filter })} />
          </ErrorBoundary>
        )}
      </Show>
    </SettingsFrame>
  );
}
