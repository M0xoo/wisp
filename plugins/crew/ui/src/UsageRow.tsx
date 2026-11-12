// Settings → Usage's Crew track record row (v1 settings.js #openRecord): shown once there's a crew, it opens the
// crew's track record.
import { Show, type JSX } from 'solid-js';
import type { ExtensionProps } from '@wisp/shell/contract';
import { viewIntent } from '@wisp/shell';
import { Button, SettingsRow, useSignal } from '@wisp/ui';
import { crewData } from './data.ts';
import { t } from './i18n.ts';
import { VIEW } from './views.ts';

export default function UsageRow(props: ExtensionProps): JSX.Element {
  const members = useSignal(crewData(props.client).members);
  return (
    <Show when={members().length > 0}>
      <SettingsRow
        part="crew.record.open"
        title={t('wisp.crew.record.title')}
        description={t('wisp.crew.record.line')}
        control={
          <Button size="sm" variant="ghost" onClick={() => props.client.navigate(viewIntent({ kind: VIEW.record, slot: 'overlay', overlay: 'dialog' }, null))}>
            {t('wisp.crew.record.open')}
          </Button>
        }
      />
    </Show>
  );
}
