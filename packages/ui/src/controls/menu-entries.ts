// Menu entries and menuSections, plain (no component): the shape both Menu and ContextMenu take, importable from
// `@wisp/ui/pure` so a module that builds a menu (the shell's task menu) and its test skip the kit.
import type { PartName } from '../core/props.ts';
import type { IconName } from '../content/icons.ts';

export interface MenuItem {
  readonly kind?: 'item';
  readonly value: string;
  /** its own part name (a v1 part such as `topbar.settings`), instead of the menu's `<part>.item` */
  readonly part?: PartName;
  readonly label: string;
  readonly icon?: IconName;
  /** A second line under the label. */
  readonly hint?: string;
  /** The shortcut, shown at the end (hidden on touch). */
  readonly keys?: string;
  /** Red on hover: a destructive action. */
  readonly danger?: boolean;
  readonly disabled?: boolean;
  /** A toggle that is on shows a check at the end. */
  readonly checked?: boolean;
}

export interface MenuSeparator {
  readonly kind: 'separator';
}

export interface MenuGroup {
  readonly kind: 'group';
  readonly id: string;
  readonly label: string;
  readonly items: readonly MenuItem[];
}

/** A row that drills into its own items (one level: no submenu in a submenu). */
export interface MenuSubmenu {
  readonly kind: 'submenu';
  /** names the row (its `data-value`); never passed to `onSelect` */
  readonly value: string;
  readonly label: string;
  readonly icon?: IconName;
  readonly part?: PartName;
  readonly items: readonly (MenuItem | MenuSeparator | MenuGroup)[];
}

export type MenuEntry = MenuItem | MenuSeparator | MenuGroup | MenuSubmenu;

/** A long menu in sections (v1 #786 sectionsHtml / subHtml): a line between groups, empty groups
 *  dropped, and a submenu of one item left inline (none of zero), so no drill-in holds a single row. */
export function menuSections(groups: readonly (readonly (MenuEntry | false | null | undefined)[])[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const g of groups) {
    const xs = g.flatMap((e): MenuEntry[] => {
      if (!e) return [];
      if (e.kind !== 'submenu') return [e];
      return e.items.length < 2 ? [...e.items] : [e];
    });
    if (!xs.length) continue;
    if (out.length) out.push({ kind: 'separator' });
    out.push(...xs);
  }
  return out;
}
