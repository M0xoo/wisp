// wisp.update's UI: Settings → Updates, its row at the end of General, and the top bar's Update pill.
import { lazy } from 'solid-js';
import { defineExtension, type PluginUiDef } from '@wisp/shell';
import type { ExtensionId } from '@wisp/client';
import { catalogue } from './i18n.ts';

const ui: PluginUiDef = {
  id: 'wisp.update',
  settings: [{ id: 'updates', group: 'advanced', title: 'update.pane.updates', icon: 'update', order: 10, component: lazy(() => import('./panes/Updates.tsx')) }],
  // the channel at the end of General too, where v1 had it
  extensions: [
    defineExtension({ id: 'update.general', attachTo: { id: 'shell.settings:general' }, component: lazy(() => import('./GeneralRow.tsx')) }),
    // v1 put the pill first after the projects, before This Mac's chip (machine.chip, order -1)
    defineExtension({
      id: 'update.pill',
      attachTo: { id: 'shell.topbar:machines' },
      component: lazy(() => import('./Pill.tsx')),
      order: -2,
      bar: {
        icon: 'update',
        label: 'update.pill.bar',
        priority: 45,
        select: (p) => p.client.navigate({ t: 'openOverlay', overlay: { kind: 'viewer', id: 'shell-settings.sheet' as ExtensionId, params: { pane: 'updates' } } }),
      },
    }),
  ],
  catalogue,
};
export default ui;
