// A row's right-click and More menu: the list's own actions, in v1's order and words (actions.js
// taskMenu), with the ones other plugins attach to `shell.row:menu` (Rerun, Fork, Ship it, Changes…)
// between Open and the list's triage actions. Pure: which items show and what they say.

import type { MenuEntry } from '@wisp/ui';
import type { SessionRow } from '../types.ts';
import { busy } from './row.ts';
import { isForLater } from './sections.ts';

export type RowAction = 'open' | 'rename' | 'copy-id' | 'later' | 'pin' | 'read' | 'done' | 'archive' | 'delete';

/** Can it be saved for later: finished, and not archived (actions.js canSaveForLater). */
export const canSaveForLater = (s: SessionRow): boolean => !s.pending && !s.archived && (s.state === 'review' || s.state === 'done');

export interface MenuInput {
  readonly s: SessionRow;
  readonly t: (key: string) => string;
  /** items other plugins attached to shell.row:menu, already translated, in their order (v1: Rerun, Fork, Side
   *  discussion, Share, Ship it, Changes, Shell, Run app, Save as recipe, Add to crew, Set goal) */
  readonly plugins: readonly MenuEntry[];
  /** the ones placed after Save for later (`bar.place: 'end'`: v1's Keep worktree) */
  readonly end?: readonly MenuEntry[];
  /** keyboard hints are left out on touch screens */
  readonly keys: boolean;
}

export function rowMenu(m: MenuInput): MenuEntry[] {
  const { s, t } = m;
  const k = (key: string): { keys?: string } => (m.keys ? { keys: key } : {});
  const out: MenuEntry[] = [
    { value: 'open', label: t('shell-list.menu.open'), icon: 'expand', ...k('O') },
    { value: 'rename', label: t('shell-list.menu.rename'), icon: 'pen', ...k('M') },
    { value: 'copy-id', label: t('shell-list.menu.copy-id'), icon: 'copy' },
  ];
  // v1 actions.js taskMenu: one list, no separators
  out.push(...m.plugins);
  if (isForLater(s)) out.push({ value: 'later', label: t('shell-list.menu.unsave'), icon: 'bookmark', ...k('L') });
  else if (canSaveForLater(s)) out.push({ value: 'later', label: t('shell-list.menu.save'), icon: 'bookmark', ...k('L') });
  out.push(...(m.end ?? []));
  if (!busy(s) && !s.archived) out.push({ value: 'done', label: t(s.state === 'done' ? 'shell-list.menu.reopen' : 'shell-list.menu.done'), icon: s.state === 'done' ? 'replay' : 'done', ...k('E') });
  if (s.archived) out.push({ value: 'archive', label: t('shell-list.menu.unarchive'), icon: 'archive', ...k('A') });
  else if (!busy(s)) out.push({ value: 'archive', label: t('shell-list.menu.archive'), icon: 'archive', ...k('A') });
  out.push({ value: 'delete', label: t('shell-list.menu.delete'), icon: 'trash', danger: true, ...k('⌫') });
  // v2's own, after every v1 entry (the owner, round 30: design/v1-reference/allowed.md §5)
  out.push({ value: 'pin', label: t(s.pinned ? 'shell-list.menu.unpin' : 'shell-list.menu.pin'), icon: 'pin' });
  if (!busy(s)) out.push({ value: 'read', label: t(s.unread ? 'shell-list.menu.mark-read' : 'shell-list.menu.mark-unread'), icon: 'eye' });
  return out;
}
