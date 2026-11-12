// @wisp-plugin/ship-ui: wisp.ship's UI (v1 ship.js). A task row's PR pill, the PR strip over the open task's
// turns, and Ship it's dialog (an overlay view). Each component loads on first show.
import { lazy } from 'solid-js';
import { defineExtension, definePluginUi, defineView } from '@wisp/shell';
import { catalogue } from './i18n.ts';
import { parseShipParams } from './ShipDialog.tsx';
import { SHIP_VIEW } from './use.ts';
import { prOf, shipLabel, shippable } from './model/pr.ts';
import { guessShip } from './model/ship.ts';
import { t } from './i18n.ts';
import type { ShipSession } from './types.ts';

export default definePluginUi({
  id: 'wisp.ship',
  catalogue: { ...catalogue },
  extensions: [
    // `● #412` on a task's row, in the PR's tone
    // only on a row with a PR or a ship in flight: the rest get no pill's box at all (v1)
    defineExtension({
      id: 'wisp.ship.pill',
      attachTo: { id: 'shell.row:head' },
      component: lazy(() => import('./PrPill.tsx')),
      if: (p) => {
        const s = p.session?.() as ShipSession | undefined;
        return !!s?.shipping || prOf(s) !== undefined;
      },
    }),
    // Ship it… in a task's row menu (v1 taskMenu: shippable, its words by the PRs it has), S
    defineExtension({
      id: 'wisp.ship.rowShip',
      attachTo: { id: 'shell.row:menu' },
      component: () => null,
      order: 50,
      if: (p) => shippable(p.session?.() as ShipSession | undefined),
      bar: {
        icon: 'send',
        label: 'wisp.ship.action.ship',
        priority: 50,
        keys: 'S',
        rowOnly: true, // the open task's bar has Ship it
        text: (p) => shipLabel(t, p.session?.() as ShipSession),
        select: (p) => {
          const s = p.session?.() as ShipSession | undefined;
          if (s) p.client.navigate({ t: 'openOverlay', overlay: { kind: 'dialog', id: SHIP_VIEW as never, params: { key: s.id, guess: guessShip(s) } as never } });
        },
      },
    }),
    // the PR row over the open task: its line and what to do next (Merge, Fix conflicts)
    defineExtension({ id: 'wisp.ship.strip', attachTo: { id: 'shell.task:band' }, component: lazy(() => import('./PrStrip.tsx')) }),
  ],
  views: [defineView({ kind: SHIP_VIEW, slot: 'overlay', overlay: 'dialog', parse: parseShipParams, component: lazy(() => import('./ShipDialog.tsx')) })],
});
