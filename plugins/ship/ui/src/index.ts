// @wisp-plugin/ship-ui: wisp.ship's UI (v1 ship.js). A task row's PR pill, the PR strip over the open task's
// turns, and Ship it's dialog (an overlay view). Each component loads on first show.
import { lazy } from 'solid-js';
import { defineExtension, definePluginUi, defineView } from '@wisp/shell';
import { catalogue } from './i18n.ts';
import { parseShipParams } from './ShipDialog.tsx';
import { SHIP_VIEW } from './use.ts';

export default definePluginUi({
  id: 'wisp.ship',
  catalogue: { ...catalogue },
  extensions: [
    // `● #412` on a task's row, in the PR's tone
    defineExtension({ id: 'wisp.ship.pill', attachTo: { id: 'shell.row:head' }, component: lazy(() => import('./PrPill.tsx')) }),
    // the PR row over the open task: its line and what to do next (Merge, Fix conflicts)
    defineExtension({ id: 'wisp.ship.strip', attachTo: { id: 'shell.task:band' }, component: lazy(() => import('./PrStrip.tsx')) }),
  ],
  views: [defineView({ kind: SHIP_VIEW, slot: 'overlay', overlay: 'dialog', parse: parseShipParams, component: lazy(() => import('./ShipDialog.tsx')) })],
});
