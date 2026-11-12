// Settings → Usage → Machine load (v1 settings.js .sx-load): what this computer's guard reads now, and the three
// limits automations wait on (memory floor, CPU ceiling, runs at once). What you start always runs. The machine
// page's Change comes here.
import { type JSX } from 'solid-js';
import { computed, entityKey, setSetting, type Json, type PluginClient, type SettingRow } from '@wisp/client';
import type { ExtensionProps } from '@wisp/shell/contract';
import { SelectSetting, SettingsGroup, SettingsRow, type SettingSource } from '@wisp/ui';
import { useLoad } from './data.ts';
import type { MachineLoad } from './types.ts';

/** A setting of this computer's wisp, as a Settings row reads it (a refused write rolls back with a toast). */
function fromRow(client: PluginClient, key: string, fallback: string): SettingSource<string> {
  const row = client.entities.row<SettingRow>('setting', entityKey(client.home, key));
  return {
    value: computed(() => String((row()?.value as Json | undefined) ?? fallback)),
    lockedBy: computed(() => row()?.locked_by ?? undefined),
    set: (value) => void client.run(setSetting, { peer: client.home, key, value }).catch(() => {}),
  };
}

/** "62% memory free · 2 runs going", and why automations wait, if they do (v1 paintLoad). */
export function nowLine(l: MachineLoad | undefined, t: PluginClient['t']): string {
  if (!l) return t('machine.load.reading');
  const bits = [l.mem_free_pct === null ? '' : t('machine.load.free', { n: Math.round(l.mem_free_pct) }), t('machine.load.runs', { count: l.runs })].filter(Boolean);
  return l.held ? `${bits.join(' · ')}. ${l.held.why}` : bits.join(' · ');
}

export default function LoadGroup(props: ExtensionProps): JSX.Element {
  const c = props.client;
  const t = c.t;
  const { load } = useLoad(c, c.home);
  return (
    <SettingsGroup part="machine.load" bodyPart="settings.load" title={t('machine.load.title')} description={t('machine.load.description')}>
      <SettingsRow part="machine.load.now" title={t('machine.load.now')} description={nowLine(load(), t)} />
      <SelectSetting
        part="settings.memoryFloor"
        title={t('machine.load.memory')}
        description={t('machine.load.memoryHint')}
        source={fromRow(c, 'machine.memoryFloor', '15')}
        items={['off', '10', '15', '20', '25'].map((v) => ({ value: v, label: v === 'off' ? t('machine.load.off') : t('machine.load.memFree', { n: v }) }))}
      />
      <SelectSetting
        part="settings.cpuCeiling"
        title={t('machine.load.cpu')}
        description={t('machine.load.cpuHint')}
        source={fromRow(c, 'machine.cpuCeiling', '200')}
        items={['off', '100', '150', '200'].map((v) => ({ value: v, label: v === 'off' ? t('machine.load.off') : `${v}%` }))}
      />
      <SelectSetting
        part="settings.maxRuns"
        title={t('machine.load.runsTitle')}
        description={t('machine.load.runsHint')}
        source={fromRow(c, 'machine.maxRuns', 'auto')}
        items={['off', '4', '6', '8', '12', '16', 'auto'].map((v) => ({ value: v, label: v === 'off' ? t('machine.load.off') : v === 'auto' ? t('machine.load.auto') : v }))}
      />
    </SettingsGroup>
  );
}
