// The shortcuts sheet (?): every shortcut the shell and the plugins registered, by group, as the
// keys read on this computer (⌘ on a Mac, Ctrl elsewhere). One row per label: N and ⌘L are both
// "New task" and show together.

import { For, createMemo, type JSX } from 'solid-js';
import type { PluginClient } from '@wisp/client';
import { Kbd, Section, SettingsRow, Stack, Inline, useSignal } from '@wisp/ui';
import { useShell } from '../context.tsx';
import { useClients } from '../slot.tsx';
import { allowed, displayCombo } from '../keys.ts';

export default function Shortcuts(_p: { readonly client: PluginClient; readonly params: unknown }): JSX.Element {
  const shell = useShell();
  const all = useSignal(useClients().shortcuts);
  const groups = createMemo(() => {
    const out = new Map<string, Map<string, string[][]>>();
    for (const s of all()) {
      if (!allowed(s)) continue;
      const g = s.group ?? 'general';
      const rows = out.get(g) ?? new Map<string, string[][]>();
      const keys = rows.get(s.label) ?? [];
      keys.push(displayCombo(s.keys, shell.platform.apple));
      rows.set(s.label, keys);
      out.set(g, rows);
    }
    return [...out].map(([g, rows]) => ({ g, rows: [...rows] }));
  });
  const groupTitle = (g: string): string => {
    const key = `shell.shortcuts.group.${g}`;
    return shell.client.i18n.has(key) ? shell.t(key) : g;
  };
  return (
    <Stack gap="6" part="shell.shortcuts">
      <For each={groups()}>
        {(group) => (
          <Section title={groupTitle(group.g)} level={3}>
            <For each={group.rows}>
              {([label, combos]) => (
                <SettingsRow
                  title={shell.t(label)}
                  control={
                    <Inline gap="2">
                      <For each={combos}>{(keys) => <Kbd keys={keys} />}</For>
                    </Inline>
                  }
                />
              )}
            </For>
          </Section>
        )}
      </For>
    </Stack>
  );
}
