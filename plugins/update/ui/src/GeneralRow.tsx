// Updates at the end of Settings → General, where v1 kept it (settings.js .sx-updates): the channel, with what it means.
// The Updates pane keeps the version and Update now.
import type { JSX } from 'solid-js';
import { entityKey } from '@wisp/client';
import type { ExtensionProps } from '@wisp/shell/contract';
import { SettingsGroup, useSignal } from '@wisp/ui';
import { t } from './i18n.ts';
import { useTopic } from './live.ts';
import { Channel } from './panes/Updates.tsx';
import { KIND, ROW_ID, TOPIC, type UpdateState } from './types.ts';

export default function GeneralRow(props: ExtensionProps): JSX.Element {
  useTopic(props.client, TOPIC);
  const row = useSignal(props.client.entities.row<UpdateState>(KIND, entityKey(props.client.home, ROW_ID)));
  return (
    <SettingsGroup part="settings.updates">
      <Channel client={props.client} row={row()} title={t('update.pane.updates')} part="settings.update.general" />
    </SettingsGroup>
  );
}
