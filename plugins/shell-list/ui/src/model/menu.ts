// A row's right-click menu (v1 #786 actions.js taskMenuHtml): the list's own entries in v1's sections and words, with
// the ones other plugins attach to `shell.row:menu` placed by their `bar.section` / `bar.sub` (Rerun with Open, Fork…
// with Rename, View ›, Goal ›, Copy ›, Files ›). The shell's taskMenu lays it out, as it does the open task's More.
// Pure: which items show and what they say.

import { taskMenu, type TaskMenuEntry } from '@wisp/shell';
import type { MenuEntry, MenuItem } from '@wisp/ui';
import type { SessionRow } from '../types.ts';
import { busy } from './row.ts';
import { isForLater } from './sections.ts';

export type RowAction = 'open' | 'rename' | 'copy-id' | 'later' | 'pin' | 'read' | 'done' | 'archive' | 'delete';

/** Can it be saved for later: finished, and not archived (actions.js canSaveForLater). */
export const canSaveForLater = (s: SessionRow): boolean => !s.pending && !s.archived && (s.state === 'review' || s.state === 'done');

export interface MenuInput {
  readonly s: SessionRow;
  readonly t: (key: string) => string;
  /** items other plugins attached to shell.row:menu, already translated, each with its section, submenu and order */
  readonly plugins: readonly TaskMenuEntry[];
  /** keyboard hints are left out on touch screens */
  readonly keys: boolean;
}

export function rowMenu(m: MenuInput): MenuEntry[] {
  const { s, t } = m;
  const k = (key: string): { keys?: string } => (m.keys ? { keys: key } : {});
  const own: TaskMenuEntry[] = [
    { section: 'open', order: -10, entry: { value: 'open', label: t('shell-list.menu.open'), icon: 'expand', ...k('O') } },
    { section: 'task', order: -10, entry: { value: 'rename', label: t('shell-list.menu.rename'), icon: 'pen', ...k('M') } },
    { sub: 'copy', order: -20, entry: { value: 'copy-id', label: t('shell-list.menu.copy-id'), icon: 'copy' } },
  ];
  // where it sits (v1): Mark done, Save for later, Archive, then the plugins' own ('place', the default)
  if (!busy(s) && !s.archived) own.push({ section: 'place', order: -30, entry: { value: 'done', label: t(s.state === 'done' ? 'shell-list.menu.reopen' : 'shell-list.menu.done'), icon: s.state === 'done' ? 'replay' : 'done', ...k('E') } });
  if (isForLater(s)) own.push({ section: 'place', order: -20, entry: { value: 'later', label: t('shell-list.menu.unsave'), icon: 'bookmark', ...k('L') } });
  else if (canSaveForLater(s)) own.push({ section: 'place', order: -20, entry: { value: 'later', label: t('shell-list.menu.save'), icon: 'bookmark', ...k('L') } });
  if (s.archived) own.push({ section: 'place', order: -10, entry: { value: 'archive', label: t('shell-list.menu.unarchive'), icon: 'archive', ...k('A') } });
  else if (!busy(s)) own.push({ section: 'place', order: -10, entry: { value: 'archive', label: t('shell-list.menu.archive'), icon: 'archive', ...k('A') } });
  // v2's own, after every v1 entry (the owner, round 30: design/v1-reference/allowed.md §5)
  const after: MenuItem[] = [{ value: 'pin', label: t(s.pinned ? 'shell-list.menu.unpin' : 'shell-list.menu.pin'), icon: 'pin' }];
  if (!busy(s)) after.push({ value: 'read', label: t(s.unread ? 'shell-list.menu.mark-read' : 'shell-list.menu.mark-unread'), icon: 'eye' });
  return taskMenu({
    entries: [...own, ...m.plugins],
    danger: [{ value: 'delete', label: t('shell-list.menu.delete'), icon: 'trash', danger: true, ...k('⌫') }],
    after,
    t,
  });
}
