// Settings → Appearance: the theme (system, light or dark). A theme a plugin set reads as theirs.

import type { JSX } from 'solid-js';
import type { PluginClient } from '@wisp/client';
import { RadioGroup, Section, useSignal } from '@wisp/ui';
import type { ThemePref } from '../contract.ts';
import { useShell } from '../context.tsx';
import { THEMES } from '../theme.ts';

export default function Appearance(_p: { readonly client: PluginClient }): JSX.Element {
  const shell = useShell();
  const pref = useSignal(() => shell.theme.pref());
  return (
    <Section title={shell.t('shell.settings.theme')} part="shell.appearance">
      <RadioGroup
        label={shell.t('shell.settings.theme')}
        hideLabel
        orientation="horizontal"
        options={THEMES.map((v) => ({ value: v, label: shell.t(`shell.settings.theme.${v}`) }))}
        value={pref()}
        onChange={(v) => void shell.theme.set(v as ThemePref)}
      />
    </Section>
  );
}
