// Settings → Notifications (v1 'notifications'). The switch is wisp's own on/off preference; the
// browser's permission can only be granted from here, never revoked, so when it blocks the switch
// it shows as the row's hint (v1 notify.js). Turning it on asks for the permission first.

import { createSignal, type JSX } from 'solid-js';
import type { PluginClient } from '@wisp/client';
import { Button, SettingsGroup, SettingsRow, Switch, SwitchSetting, useSignal } from '@wisp/ui';
import { t } from '../i18n.ts';
import { fromRow, onOff } from '../source.ts';
import { KEYS, VIEW_ID } from '../types.ts';

export type Permission = 'granted' | 'denied' | 'default' | 'unsupported';

/** The page's notification permission, without touching the API when there is none. */
export function permission(g: { Notification?: { permission: string } } = globalThis as never): Permission {
  const p = g.Notification?.permission;
  return p === 'granted' || p === 'denied' || p === 'default' ? p : 'unsupported';
}

/** v1 paint(): the hint under the switch. */
export function notifyHint(perm: Permission, on: boolean): string {
  if (perm === 'denied') return t('shell-settings.notify.blocked');
  if (perm === 'unsupported') return t('shell-settings.notify.unsupported');
  return t(on ? 'shell-settings.notify.on' : 'shell-settings.notify.off');
}

function Desktop(props: { readonly client: PluginClient }): JSX.Element {
  const src = onOff(fromRow(props.client, KEYS.notify), false);
  const on = useSignal(src.value);
  const [perm, setPerm] = createSignal(permission());
  const toggle = async (want: boolean): Promise<void> => {
    if (want && perm() !== 'granted') {
      const asked = await globalThis.Notification?.requestPermission?.().catch(() => 'denied' as const);
      setPerm(permission());
      if (asked !== 'granted') return;
    }
    src.set(want);
  };
  return (
    <SettingsRow
      part="settings.notify"
      title={t('shell-settings.notify')}
      description={notifyHint(perm(), on() && perm() === 'granted')}
      control={<Switch checked={on() && perm() === 'granted'} disabled={perm() === 'denied' || perm() === 'unsupported'} onChange={(v) => void toggle(v)} aria-label={t('shell-settings.notify')} />}
    />
  );
}

export default function Notifications(props: { readonly client: PluginClient }): JSX.Element {
  const openMachines = (): void => props.client.navigate({ t: 'openOverlay', overlay: { kind: 'sheet', id: VIEW_ID, params: { pane: 'machines' } } });
  return (
    <>
      <SettingsGroup part="settings.notifications.here">
        <Desktop client={props.client} />
      </SettingsGroup>
      <SettingsGroup part="settings.notifications.away">
        <SettingsRow title={t('shell-settings.phone')} description={t('shell-settings.phone.hint')} control={<Button size="sm" variant="secondary" icon="phone" onClick={openMachines}>{t('shell-settings.phone.setup')}</Button>} />
        <SwitchSetting title={t('shell-settings.channels')} description={t('shell-settings.channels.hint')} source={onOff(fromRow(props.client, KEYS.acceptChannels), false, KEYS.acceptChannels)} locked={(by) => t('shell-settings.locked', { by })} />
      </SettingsGroup>
    </>
  );
}
