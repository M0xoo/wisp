// @wisp-plugin/history-ui: wisp.history's UI (ADR-0033): the Repo view, reached from ⌘K and from the project chips'
// + menu (it was a Tasks · Repo tab row over the list, which put the list 24 px lower than v1's). Loads on first show.
import { lazy } from 'solid-js';
import { definePalette, definePluginUi, defineView } from '@wisp/shell';
import { catalogue, t } from './i18n.ts';
import { REPO_VIEW } from './views.ts';

export default definePluginUi({
  id: 'wisp.history',
  catalogue,
  palette: [
    definePalette({
      id: 'history.palette',
      items: (ctx) => [{ id: 'history.repo', group: 'shell.palette.go', label: t('history.tab.repo'), icon: 'branch', keywords: 'history git commits agents committed', run: () => ctx.client.navigate({ t: 'openView', id: REPO_VIEW as never, params: {} }) }],
    }),
  ],
  views: [
    defineView<{ project?: string }>({
      kind: REPO_VIEW,
      slot: 'main',
      parse: (p) => {
        const id = (p as { project?: unknown } | null)?.project;
        return typeof id === 'string' ? { project: id } : {};
      },
      title: () => t('history.repo.title'),
      component: lazy(() => import('./Repo.tsx')),
    }),
  ],
});
