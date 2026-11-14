import { createSignal, type JSX } from 'solid-js';
import { Box, Button, Meter, Select, SettingsFrame, SettingsGroup, SettingsRow, Stack, Switch, Tabs, Text, type SettingsNavGroup } from '../../src/index.ts';
import { Area, Specimen, State } from '../frame.tsx';

const GROUPS: readonly SettingsNavGroup[] = [
  { id: 'general', items: [{ id: 'general', label: 'General', icon: 'settings' }, { id: 'appearance', label: 'Appearance', icon: 'sun' }] },
  { id: 'agents', label: 'Agents', items: [{ id: 'accounts', label: 'Accounts', icon: 'user', alert: 'bad', alertLabel: '1 not found' }, { id: 'connectors', label: 'Connectors', icon: 'plug' }] },
  { id: 'usage', label: 'Usage', items: [{ id: 'budget', label: 'Plan budget with a very long pane name that truncates', icon: 'stats' }] },
];

function Frame(props: { readonly view: 'list' | 'pane' }): JSX.Element {
  const [pane, setPane] = createSignal('general');
  const [on, setOn] = createSignal(true);
  const [theme, setTheme] = createSignal('system');
  return (
    <Box part="gallery.settings-frame" border="line" radius="lg">
      <SettingsFrame
        title="Settings"
        groups={GROUPS}
        current={pane()}
        onPick={setPane}
        paneTitle={GROUPS.flatMap((g) => g.items).find((i) => i.id === pane())?.label ?? ''}
        lede="Where files open, where you take over, and how tasks start."
        view={props.view}
        onUp={() => {}}
        upLabel="All settings"
        onClose={() => {}}
        closeLabel="Close settings"
      >
        <SettingsGroup>
          <SettingsRow title="Worktree per task" description="Each task gets its own branch from origin/main, in git repos" control={<Switch checked={on()} onChange={setOn} aria-label="Worktree per task" />} />
          <SettingsRow
            title="Theme"
            description="System follows your computer’s light or dark setting"
            control={<Tabs variant="pill" aria-label="Theme" value={theme()} onChange={setTheme} items={[{ value: 'system', label: 'System', icon: 'laptop' }, { value: 'light', label: 'Light', icon: 'sun' }, { value: 'dark', label: 'Dark', icon: 'moon' }]} />}
          />
        </SettingsGroup>
        <SettingsGroup title="Plan budget" description="Your plans’ usage windows, as Claude Code and Codex report them" actions={<Button size="sm" variant="ghost" icon="rerun">Re-check</Button>}>
          <SettingsRow title="Open files in" description="File links in cards and diffs" wideControl control={<Select aria-label="Open files in" value="vscode" onChange={() => {}} items={[{ value: 'vscode', label: 'VS Code' }, { value: 'zed', label: 'Zed' }]} />} />
        </SettingsGroup>
      </SettingsFrame>
    </Box>
  );
}

export function SettingsGallery(): JSX.Element {
  return (
    <Area id="settings" title="Settings">
      <Specimen title="SettingsFrame" note="A list of panes and one pane. Under 640px of its own width: the list, or the pane with Back.">
        <State label="list and pane">
          <Frame view="pane" />
        </State>
      </Specimen>
      <Specimen title="Meter" note="A usage window: the share used, and the stop line.">
        <Stack gap="4">
          <Meter label="5-hour window" value={0.42} mark={0.8} markLabel="Automations stop at 80%" />
          <Meter label="Weekly window" value={0.86} mark={0.8} tone="warn" />
          <Meter label="Over" value={1.2} tone="bad" />
          <Text size="sm" tone="muted">Values clamp to 0–100%.</Text>
        </Stack>
      </Specimen>
    </Area>
  );
}
