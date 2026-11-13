// A task's menu (v1 #786 actions.js taskMenuHtml, design/ux.md → Task menus): the row's right-click menu and the open
// task's More build it here, so both say the same things in the same groups. Sections go from the task itself to
// where to look, what to keep and, last, Delete; views, the goal, copies and files fold into submenus, so the menu
// stays about a dozen rows. v2's own Pin and Mark read come after every v1 entry (the owner, round 30). Pure.
import { menuSections, type MenuEntry, type MenuItem, type MenuSeparator, type MenuGroup, type IconName } from '@wisp/ui/pure';
import type { ExtensionProps, ResolvedExtension, TaskMenuSection, TaskMenuSub } from './contract.ts';

/** One entry of a task's menu and where it goes: the shell's, the list's or a plugin's (`bar.section`, `bar.sub`). */
export interface TaskMenuEntry {
  readonly entry: MenuItem | MenuGroup;
  readonly section?: TaskMenuSection;
  readonly sub?: TaskMenuSub;
  /** within its section (or submenu); a plugin's `order` */
  readonly order: number;
}

const SECTIONS: readonly TaskMenuSection[] = ['open', 'task', 'waiting', 'look', 'keep', 'place'];
const SUB_SECTION: Record<TaskMenuSub, TaskMenuSection> = { view: 'look', goal: 'look', copy: 'keep', files: 'keep' };
/** where each submenu's row sits in its section: View before the crew (order 100) and Goal after the view items'
 *  orders; Copy first in its section, Files last (v1 #786) */
const SUB_ORDER: Record<TaskMenuSub, number> = { view: 55, goal: 95, copy: -1000, files: 1000 };
const SUB_ICON: Record<TaskMenuSub, IconName> = { view: 'panel', goal: 'target', copy: 'copy', files: 'folder' };

export interface TaskMenuInput {
  readonly entries: readonly TaskMenuEntry[];
  /** Delete task, alone in the last section */
  readonly danger: readonly MenuItem[];
  /** v2's own, after every v1 entry (Pin, Mark read) */
  readonly after?: readonly MenuItem[];
  /** a submenu's name ('shell.menu.view' …) */
  readonly t: (key: string) => string;
}

const sectionOf = (e: TaskMenuEntry): TaskMenuSection => (e.sub ? SUB_SECTION[e.sub] : (e.section ?? 'place'));
const byOrder = <T extends { readonly order: number }>(xs: readonly T[]): T[] => [...xs].sort((a, b) => a.order - b.order); // stable

export function taskMenu(m: TaskMenuInput): MenuEntry[] {
  const groups = SECTIONS.map((section) => {
    const mine = m.entries.filter((e) => sectionOf(e) === section);
    const rows: { order: number; entry: MenuEntry }[] = mine.filter((e) => !e.sub).map((e) => ({ order: e.order, entry: e.entry }));
    for (const sub of Object.keys(SUB_ORDER) as TaskMenuSub[]) {
      if (SUB_SECTION[sub] !== section) continue;
      const items: (MenuItem | MenuSeparator | MenuGroup)[] = byOrder(mine.filter((e) => e.sub === sub)).map((e) => e.entry);
      if (items.length) rows.push({ order: SUB_ORDER[sub], entry: { kind: 'submenu', value: `sub:${sub}`, label: m.t(`shell.menu.${sub}`), icon: SUB_ICON[sub], items } });
    }
    return byOrder(rows).map((r) => r.entry);
  });
  return menuSections([...groups, m.danger, m.after ?? []]);
}

/** A plugin's `shell.row:menu` entry as a task's menu shows it: its words for this task, its icon and key, and where it
 *  goes. `place: 'end'` (before sections) still means just after Save for later. */
export function menuEntryOf(x: ResolvedExtension, p: ExtensionProps, t: (key: string) => string, keys = true): TaskMenuEntry {
  const bar = x.def.bar;
  const entry: MenuItem = { value: `x:${x.id}`, label: bar?.text?.(p) ?? t(bar?.label ?? x.id), icon: (bar?.icon ?? 'dots') as IconName, ...(keys && bar?.keys ? { keys: bar.keys } : {}) };
  const at = bar?.sub ? { sub: bar.sub } : bar?.section ? { section: bar.section } : bar?.place === 'end' ? { section: 'place' as const } : {};
  return { entry, ...at, order: bar?.place === 'end' && !bar.section && !bar.sub ? -15 : x.order };
}
