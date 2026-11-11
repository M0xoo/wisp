// Settings → Privacy (v1 settings.js, design/v1-reference/settings.privacy): what wisp sends about itself
// (never prompts, paths or code), and the repo-trust question before a repo's own programs run.
import { onCleanup, type JSX } from 'solid-js';
import { entityKey, type PluginClient } from '@wisp/client';
import { SettingsGroup, SettingsRow, Switch, SwitchSetting, Text, useSignal, type SettingSource } from '@wisp/ui';
import { KIND, setStats, TOPIC, type StateRow } from '../commands.ts';
import { t } from '../i18n.ts';
import { fromRow, onOff } from '../source.ts';

/** `git.maskEnvFiles` is a bool setting (wisp.git's manifest): read 'off' or false as off, write a bool. */
function maskEnv(c: PluginClient): SettingSource<boolean> {
  const s = fromRow(c, 'git.maskEnvFiles', true);
  return {
    value: () => {
      const v = (s.value as () => unknown)();
      return !(v === false || v === 'off');
    },
    ...(s.lockedBy && { lockedBy: s.lockedBy }),
    set: (on) => s.set(on),
  };
}

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
      <SettingsGroup part="telemetry.privacy.stats">
        <SettingsRow
          part="telemetry.privacy.stats.row"
          title={t('telemetry.privacy.stats.title')}
          description={stats()?.blocked ? t('telemetry.privacy.stats.blocked') : stats()?.on ? t('telemetry.privacy.stats.on') : t('telemetry.privacy.stats.off')}
          control={<Switch aria-label={t('telemetry.privacy.stats.title')} checked={stats()?.on ?? false} disabled={stats()?.blocked ?? true} onChange={(on) => void c.run(setStats, { peer, on }).catch(() => {})} />}
        />
      </SettingsGroup>
      <Text as="p" size="sm" tone="muted" part="telemetry.privacy.stats.what">
        {t('telemetry.privacy.stats.what')}
      </Text>
      <SettingsGroup part="telemetry.privacy.trust">
        <SwitchSetting part="telemetry.privacy.trust.row" title={t('telemetry.privacy.trust.title')} description={t('telemetry.privacy.trust.description')} source={onOff(fromRow(c, 'worktrees.projectAsk'), true)} locked={(by) => t('telemetry.privacy.locked', { by })} />
      </SettingsGroup>
      {/* v1 Hide .env values: wisp.git masks them (KEY=••••) in Changes and diffs unless this is off */}
      <SettingsGroup part="telemetry.privacy.env">
        <SwitchSetting part="settings.maskEnv" title={t('telemetry.privacy.env.title')} description={t('telemetry.privacy.env.description')} source={maskEnv(c)} locked={(by) => t('telemetry.privacy.locked', { by })} />
      </SettingsGroup>
    </>
  );
}
