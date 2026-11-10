// Settings → Privacy (v1 settings.js, design/v1-reference/settings.privacy): what wisp sends about itself
// (never prompts, paths or code), and the repo-trust question before a repo's own programs run.
import { onCleanup, type JSX } from 'solid-js';
import { entityKey, type PluginClient } from '@wisp/client';
import { SettingsGroup, SettingsRow, Switch, SwitchSetting, Text, useSignal } from '@wisp/ui';
import { KIND, setStats, TOPIC, type StateRow } from '../commands.ts';
import { t } from '../i18n.ts';
import { fromRow, onOff } from '../source.ts';

export default function Privacy(props: { readonly client: PluginClient }): JSX.Element {
  const c = props.client;
  const peer = c.home;
  const scope = c.scope.child('privacy-pane');
  onCleanup(() => scope.dispose());
  c.watch(peer, TOPIC, scope);
  const row = useSignal(c.entities.row<StateRow>(KIND, entityKey(peer, 'this')));
  const stats = (): StateRow | undefined => row() as StateRow | undefined;
  return (
    <>
      <Text as="p" tone="muted" part="telemetry.privacy.lede">
        {t('telemetry.privacy.lede')}
      </Text>
      <SettingsGroup part="telemetry.privacy.stats" description={t('telemetry.privacy.stats.what')}>
        <SettingsRow
          part="telemetry.privacy.stats.row"
          title={t('telemetry.privacy.stats.title')}
          description={stats()?.blocked ? t('telemetry.privacy.stats.blocked') : stats()?.on ? t('telemetry.privacy.stats.on') : t('telemetry.privacy.stats.off')}
          control={<Switch aria-label={t('telemetry.privacy.stats.title')} checked={stats()?.on ?? false} disabled={stats()?.blocked ?? true} onChange={(on) => void c.run(setStats, { peer, on }).catch(() => {})} />}
        />
      </SettingsGroup>
      <SettingsGroup part="telemetry.privacy.trust">
        <SwitchSetting part="telemetry.privacy.trust.row" title={t('telemetry.privacy.trust.title')} description={t('telemetry.privacy.trust.description')} source={onOff(fromRow(c, 'worktrees.projectAsk'), true)} locked={(by) => t('telemetry.privacy.locked', { by })} />
      </SettingsGroup>
    </>
  );
}
