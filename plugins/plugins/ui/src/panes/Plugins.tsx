// Settings → Plugins (v1's Spells, ADR-0031: a change to wisp is a plugin now): every plugin this wisp runs,
// built-in or yours, with its state (on, off, refused and why) and its switch. A switch shows at once and
// the list is read again after it; switching off frees everything the plugin made (its scope).
import { createResource, createSignal, For, Show, type JSX } from 'solid-js';
import type { PluginClient } from '@wisp/client';
import { Pill, SettingsGroup, SettingsRow, Switch, Text } from '@wisp/ui';
import { list, setEnabled, type PluginRow } from '../commands.ts';
import { t } from '../i18n.ts';

const TONE: Record<string, 'good' | 'neutral' | 'bad'> = { active: 'good', resolved: 'good', off: 'neutral', refused: 'bad' };

export default function Plugins(props: { readonly client: PluginClient }): JSX.Element {
  const c = props.client;
  const peer = c.home;
  const [rows, { refetch, mutate }] = createResource(() => c.run(list, { peer }).catch((): PluginRow[] => []));
  const [busy, setBusy] = createSignal<string | undefined>();
  const flip = (p: PluginRow, on: boolean): void => {
    mutate((rs) => (rs ?? []).map((x) => (x.id === p.id ? { ...x, enabled: on, state: on ? 'active' : 'off' } : x)));
    setBusy(p.id);
    c.run(setEnabled, { peer, id: p.id, enabled: on })
      .catch(() => {})
      .finally(() => {
        setBusy(undefined);
        void refetch();
      });
  };
  const yours = (): PluginRow[] => (rows() ?? []).filter((p) => !p.builtin);
  const builtins = (): PluginRow[] => (rows() ?? []).filter((p) => p.builtin).sort((a, b) => a.id.localeCompare(b.id));
  const row = (p: PluginRow): JSX.Element => (
    <SettingsRow
      part="plugins.row"
      title={p.id.replace(/^wisp\./, '')}
      description={p.reason ?? t('plugins.version', { version: p.version })}
      control={
        <>
          <Pill tone={TONE[p.state] ?? 'neutral'} dot variant="outline">
            {t(`plugins.state.${(TONE[p.state] ? p.state : 'off') as 'active'}`)}
          </Pill>
          <Switch aria-label={t('plugins.on', { name: p.id })} checked={p.enabled} disabled={busy() === p.id} onChange={(on) => flip(p, on)} />
        </>
      }
    />
  );
  return (
    <>
      <Text as="p" tone="muted" part="plugins.lede">
        {t('plugins.lede')}
      </Text>
      <SettingsGroup part="plugins.yours" title={t('plugins.yours')}>
        <Show when={yours().length > 0} fallback={<SettingsRow part="plugins.none" title={t('plugins.none')} description={t('plugins.none.description')} control={<span />} />}>
          <For each={yours()}>{row}</For>
        </Show>
      </SettingsGroup>
      <SettingsGroup part="plugins.builtin" title={t('plugins.builtin')} description={t('plugins.builtin.description')}>
        <For each={builtins()}>{row}</For>
      </SettingsGroup>
    </>
  );
}
