// Settings → Keyboard shortcuts (v1's "?" dialog): every page-wide key, grouped, in this OS's words.
// Labels are content (they wrap on a phone); the keys sit at the end of the line, never cut.
import { For, type JSX } from 'solid-js';
import type { PluginClient } from '@wisp/client';
import { Box, Inline, Kbd, SettingsGroup, Text } from '@wisp/ui';
import { t } from '../i18n.ts';
import { isMac, shortcutGroups } from '../keys.ts';

export default function Keys(_props: { readonly client: PluginClient }): JSX.Element {
  const mac = isMac(globalThis.navigator?.platform ?? '');
  const desktop = 'wispDesktop' in globalThis;
  return (
    <For each={shortcutGroups(mac)}>
      {(g) => (
        <SettingsGroup part="settings.keys" title={t(g.title)}>
          <For each={g.items.filter((s) => desktop || !s.desktopOnly)}>
            {(s) => (
              <Box part="settings.key" padY="4">
                <Inline gap="6" justify="between">
                  <Text size="md">{t(s.label)}</Text>
                  <Inline gap="2">
                    <For each={s.keys}>{(k) => <Kbd keys={[k]} />}</For>
                  </Inline>
                </Inline>
              </Box>
            )}
          </For>
        </SettingsGroup>
      )}
    </For>
  );
}
