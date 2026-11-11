// The project filter above the list (v1 sidebar chips: All, then each project in your order, dragged to change it).
// One line that never wraps: a Toolbar, so on a narrow sidebar the least recent projects fold into
// More (design/layout.md). The pick is the list's view store (`setFilter`), so it persists.

import { createMemo, Show, type JSX } from 'solid-js';
import { Toolbar, useSignal, type ToolbarItem } from '@wisp/ui';
import { useEnv } from './env.ts';

export function ProjectChips(): JSX.Element {
  const env = useEnv();
  const t = env.shell.t;
  const projects = useSignal(env.model.projects);
  const view = useSignal(env.model.view.value);
  const items = createMemo<ToolbarItem[]>(() => {
    const on = view().filter;
    const list = projects();
    const all: ToolbarItem = { id: 'all', label: t('shell-list.projects.all'), icon: 'grid', priority: 'pin', pressed: on === 'all', variant: 'ghost', onSelect: () => env.model.setFilter('all') };
    // in your order (v1 #772): the last ones fold into More first
    return [
      all,
      ...list.map((p, i): ToolbarItem => ({ id: p.id, label: p.name, icon: 'folder', priority: list.length - i, pressed: on === p.id, variant: 'ghost', onSelect: () => env.model.setFilter(p.id) })),
    ];
  });
  return (
    <Show when={projects().length > 0}>
      <Toolbar aria-label={t('shell-list.projects.label')} items={items()} compact gap="1" part="list.projects" t={t} onReorder={env.model.reorderProjects} />
    </Show>
  );
}
