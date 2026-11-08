// A ShellContext for the dev page and the tests (the shell builds the real one): the client, its
// navigation, English strings from the plugin's catalogue, a toaster and a null platform. Dev-only.
import type { Client } from '@wisp/client';
import type { ShellContext } from '@wisp/shell/contract';
import { nullPlatform } from '@wisp/shell/platform';
import { createToaster, type Toaster } from '@wisp/ui';
import { CATALOGUE } from '../src/i18n/index.ts';

const fill = (text: string, vars?: Readonly<Record<string, string | number>>): string =>
  vars ? text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole)) : text;

export function devShell(client: Client, toaster: Toaster = createToaster()): ShellContext {
  let selected: string | undefined;
  return {
    client,
    nav: () => client.nav.nav(),
    navigate: (intent) => client.nav.navigate(intent),
    t: (key, vars) => fill((CATALOGUE as Record<string, string>)[key] ?? key, vars),
    toast: toaster,
    platform: nullPlatform(),
    theme: { pref: () => 'system', resolved: () => 'light', set: async () => {} },
    selection: { get: () => selected, set: (k) => (selected = k) },
    sidebar: { open: () => true, toggle: () => {}, width: () => 320, setWidth: () => {} },
    focusTargets: { provide: () => () => {}, focus: () => false },
    palette: { open: () => {} },
    extensions: () => () => [],
    settingsPanes: () => () => [],
    harnesses: () => () => [],
    block: () => undefined,
    view: () => undefined,
  };
}
