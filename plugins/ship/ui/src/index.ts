// @wisp-plugin/ship-ui: wisp.ship's UI (v1 ship.js). A task row's PR pill, the PR strip over the open task's
// turns, and Ship it's dialog (an overlay view). Each component loads on first show.
import { lazy } from 'solid-js';
import { defineExtension, definePluginUi, defineView } from '@wisp/shell';
import { catalogue } from './i18n.ts';
import { parseShipParams } from './ShipDialog.tsx';
import { SHIP_VIEW } from './use.ts';
import { openPrs, prOf, prsOf, shipLabel, shippable } from './model/pr.ts';
import { mergeRequest } from './merge-request.ts';
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
        section: 'waiting',
        keys: 'S',
        rowOnly: true, // the open task's bar has Ship it
        text: (p) => shipLabel(t, p.session?.() as ShipSession),
        select: (p) => {
          const s = p.session?.() as ShipSession | undefined;
          if (s) p.client.navigate({ t: 'openOverlay', overlay: { kind: 'dialog', id: SHIP_VIEW as never, params: { key: s.id, guess: guessShip(s) } as never } });
        },
      },
    }),
    // Merge PR #n… (v1 mergeLabel: its open PRs, none in conflict) and Review PR #n (v1 reviewLabel, P: the PR pane)
    defineExtension({
      id: 'wisp.ship.rowMerge',
      attachTo: { id: 'shell.row:menu' },
      component: () => null,
      order: 52,
      if: (p) => openPrs(p.session?.() as ShipSession | undefined).length > 0,
      bar: {
        icon: 'check',
        label: 'wisp.ship.menu.merge',
        priority: 52,
        section: 'waiting',
        text: (p) => {
          const open = openPrs(p.session?.() as ShipSession | undefined);
          return open.length > 1 ? t('wisp.ship.menu.mergeMany', { count: open.length }) : t('wisp.ship.menu.merge', { n: open[0]?.pr.number ?? 0 });
        },
        select: (p) => {
          const s = p.session?.() as ShipSession | undefined;
          if (!s) return;
          mergeRequest(s.id);
          p.client.navigate({ t: 'openTask', id: s.id as never });
        },
      },
    }),
    defineExtension({
      id: 'wisp.ship.rowReview',
      attachTo: { id: 'shell.row:menu' },
      component: () => null,
      order: 75, // v1 #786 View ›: Changes, Shell, Review PR, Run app, Watch
      if: (p) => prsOf(p.session?.() as ShipSession | undefined).length > 0,
      bar: {
        icon: 'merge',
        label: 'wisp.ship.menu.review',
        priority: 75,
        sub: 'view',
        keys: 'P',
        text: (p) => {
          const prs = prsOf(p.session?.() as ShipSession | undefined);
          return prs.length > 1 ? t('wisp.ship.menu.reviewMany') : t('wisp.ship.menu.review', { n: prs[0]?.pr.number ?? 0 });
        },
        select: (p) => {
          const id = (p.session?.() as ShipSession | undefined)?.id;
          if (!id) return;
          p.client.navigate({ t: 'openTask', id: id as never });
          p.client.navigate({ t: 'openSide', side: { kind: 'pr', id: id as never } });
        },
      },
    }),
    // the PR row over the open task: its line and what to do next (Merge, Fix conflicts)
    defineExtension({ id: 'wisp.ship.strip', attachTo: { id: 'shell.task:band' }, component: lazy(() => import('./PrStrip.tsx')) }),
  ],
  views: [defineView({ kind: SHIP_VIEW, slot: 'overlay', overlay: 'dialog', parse: parseShipParams, component: lazy(() => import('./ShipDialog.tsx')) })],
});
