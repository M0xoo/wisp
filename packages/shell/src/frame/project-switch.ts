// Switching project (owner, 2026-11-12): one selector in the top bar instead of a row of chips, and a switcher you reach
// from anywhere, as fast tools do it (Linear's workspace switcher, Slack's ⌘K, VS Code's Open Recent, JetBrains'
// project switcher):
//   - ⌘P (Ctrl+P) opens the palette on projects only: type to filter, ↑↓ and Enter, recent first;
//   - ⌘1…⌘9 go straight to your first nine projects in your own order (v1 #772's order), ⌘0 to All projects;
//   - ⌘K lists them too, under Projects, so one palette finds everything.
// Each row says how many of its tasks need you, so the switcher doubles as "where am I needed".

import type { PaletteItem, ShellContext, ShortcutDef } from '../contract.ts';
import { SESSION, type SessionRow } from '../rows.ts';
import { displayCombo } from '../keys.ts';
import { PROJECT_ORDER, projectList, projectOf, sectionOf, type ProjectView } from './rows-view.ts';

/** The palette source's id: the switcher opens the palette on it alone. */
export const PROJECT_SOURCE = 'shell.projects';
/** ⌘K's Actions head (New task, Add project…, Manage projects): the switcher lists it under its projects. */
export const PROJECT_ACTIONS = 'shell.actions';

/** The projects in your order, from the store as it is now. */
export function projectsNow(ctx: ShellContext): readonly ProjectView[] {
  const rows = ctx.client.entities.list<unknown>('project')();
  const order = ctx.client.entities
    .list<{ key: string; value: unknown }>('setting')()
    .find((s) => s.key === PROJECT_ORDER)?.value;
  return projectList(rows, order);
}

/** How many tasks in each project need you, and in all of them. */
export function needCounts(ctx: ShellContext, projects: readonly ProjectView[]): { all: number; by: ReadonlyMap<string, number> } {
  const by = new Map<string, number>();
  let all = 0;
  for (const s of ctx.client.entities.list<SessionRow>(SESSION)()) {
    if (s.archived || sectionOf(s) !== 'needs') continue;
    all++;
    const p = projectOf(String((s.summary as Record<string, unknown> | undefined)?.['cwd'] ?? ''), projects);
    if (p) by.set(p.id, (by.get(p.id) ?? 0) + 1);
  }
  return { all, by };
}

/** The project the list shows now ('all' for every project). */
export function currentProject(ctx: ShellContext): string {
  return ctx.projectFilter?.value() ?? 'all';
}

/** Show `id` ('all' for every project) in the list. */
export function switchTo(ctx: ShellContext, id: string): void {
  ctx.projectFilter?.set(id);
}

/** The switcher: the palette on projects alone. */
export function openSwitcher(ctx: ShellContext): void {
  ctx.navigate({
    t: 'openOverlay',
    overlay: {
      kind: 'dialog',
      id: 'shell.palette' as never,
      params: { only: [PROJECT_SOURCE, PROJECT_ACTIONS], placeholder: ctx.t('shell.projects.switchPlaceholder'), title: ctx.t('shell.projects.switch') },
    },
  });
}

/** The palette's Projects group: All projects, then yours in your order, then add and manage. */
export function projectItems(ctx: ShellContext): PaletteItem[] {
  const projects = projectsNow(ctx);
  const { all, by } = needCounts(ctx, projects);
  const on = currentProject(ctx);
  const g = ctx.t('shell.palette.group.projects');
  const apple = ctx.platform.apple;
  const need = (n: number): string | undefined => (n > 0 ? ctx.t(n === 1 ? 'shell.side.need.one' : 'shell.side.need.other', { count: n }) : undefined);
  const subOf = (n: number, current: boolean, path?: string): string | undefined => {
    const parts = [current ? ctx.t('shell.projects.current') : undefined, need(n), path].filter((x): x is string => !!x);
    return parts.length > 0 ? parts.join(' · ') : undefined;
  };
  const allSub = subOf(all, on === 'all');
  const out: PaletteItem[] = [
    {
      id: 'project:all',
      group: g,
      label: ctx.t('shell.side.all'),
      icon: 'feed',
      ...(allSub !== undefined && { sub: allSub }),
      kbd: displayCombo('mod+0', apple).join(' '),
      keywords: 'all every projects',
      run: () => switchTo(ctx, 'all'),
    },
  ];
  projects.forEach((p, i) => {
    const sub = subOf(by.get(p.id) ?? 0, on === p.id, p.path);
    out.push({
      id: `project:${p.id}`,
      group: g,
      label: p.name,
      color: p.color || 'slate',
      ...(sub !== undefined && { sub }),
      ...(i < 9 && { kbd: displayCombo(`mod+${i + 1}`, apple).join(' ') }),
      keywords: `project ${p.path}`,
      run: () => switchTo(ctx, p.id),
    });
  });
  return out; // adding and managing them are Actions (v1), which the switcher lists too
}

/** ⌘P opens the switcher; ⌘1…⌘9 go to your first nine projects, ⌘0 to All projects. */
export function projectShortcuts(ctx: ShellContext): ShortcutDef[] {
  const go = (n: number): boolean => {
    if (n === 0) {
      switchTo(ctx, 'all');
      return true;
    }
    const p = projectsNow(ctx)[n - 1];
    if (!p) return false;
    switchTo(ctx, p.id);
    return true;
  };
  return [
    { id: 'shell.projects.switch', keys: 'mod+p', label: 'shell.key.projects', group: 'general', when: 'always', run: () => openSwitcher(ctx) },
    ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n): ShortcutDef => ({
      id: `shell.projects.go${n}`,
      keys: `mod+${n}`,
      label: n === 0 ? 'shell.key.projectAll' : 'shell.key.projectN',
      group: 'general',
      when: 'always',
      run: () => go(n),
    })),
  ];
}
