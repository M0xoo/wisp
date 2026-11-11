// @wisp-plugin/history-ui: wisp.history's UI (ADR-0033): the Repo tab over the list and its view. Each loads on
// first show.
import { lazy } from 'solid-js';
import { defineExtension, definePluginUi, defineView } from '@wisp/shell';
import { catalogue, t } from './i18n.ts';
import { REPO_VIEW } from './views.ts';

export default definePluginUi({
  id: 'wisp.history',
  catalogue,
  extensions: [defineExtension({ id: 'history.tabs', attachTo: { id: 'shell.list:top' }, component: lazy(() => import('./RepoTabs.tsx')) })],
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
