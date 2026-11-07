// wisp.machine's UI: This Mac (This PC, This computer) as a Settings pane and a page, the top-bar
// chip that opens it when it matters, the RAM column on heavy task rows, and ⌘K's "What's using
// my computer". Each component loads on first show.

import { defineExtension, definePalette, definePluginUi, defineSettingsPane, defineView } from './define.ts';
import { lazy } from 'solid-js';
import catalogue from './i18n/en.json' with { type: 'json' };
import { openSettings } from './host.ts';

const Pane = lazy(() => import('./MachinePane.tsx'));
const Chip = lazy(() => import('./Chip.tsx'));
const Ram = lazy(() => import('./RamCell.tsx'));
const Page = lazy(() => import('./MachinePage.tsx'));

export default definePluginUi({
  id: 'wisp.machine',
  catalogue,
  settings: [defineSettingsPane({ id: 'machine', group: 'computers', title: 'machine.name.mac', icon: 'laptop', component: Pane, order: 50 })],
  views: [
    defineView<{ peer?: string }>({
      kind: 'machine.this',
      slot: 'main',
      parse: (p) => (p && typeof p === 'object' && typeof (p as { peer?: unknown }).peer === 'string' ? { peer: (p as { peer: string }).peer } : {}),
      component: Page,
    }),
  ],
  extensions: [
    defineExtension({ id: 'machine.chip', attachTo: { id: 'shell.topbar:machines' }, component: Chip, bar: { icon: 'laptop', label: 'machine.name.mac', priority: 40 }, order: -1 }),
    defineExtension({ id: 'machine.ram', attachTo: { id: 'shell.row:head' }, component: Ram, if: (p) => (p.session?.() as { res?: unknown } | undefined)?.res !== undefined }),
  ],
  palette: [
    definePalette({
      id: 'machine.palette',
      items: (ctx) => [{ id: 'machine.open', group: 'shell.palette.go', label: ctx.client.t('machine.palette'), icon: 'laptop', keywords: 'memory ram cpu disk this mac pc computer', run: () => openSettings((i) => ctx.client.navigate(i), 'machine') }],
    }),
  ],
});
