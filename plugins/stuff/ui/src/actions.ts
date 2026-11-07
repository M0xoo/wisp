// What can be done to an item, in the order its More menu, its right-click menu and ⌘K list them
// (v1 stuff.js itemMenu). Same action, same name, everywhere (design/README.md rule 6). Pure: the
// page runs them (run.ts), the tests check which show when.

import type { IconName } from '@wisp/ui';
import { behind, canCopy, canDownload } from './model.ts';
import type { Item } from './types.ts';

export type ActionId =
  | 'open' | 'stop' | 'publish' | 'pubcopy' | 'pubopen' | 'update' | 'unpublish' | 'resetdata'
  | 'pin-task' | 'unpin-task' | 'pin-home' | 'unpin-home' | 'revoke' | 'mention' | 'copy' | 'download'
  | 'star' | 'edit' | 'restore' | 'task' | 'folder' | 'remove';

export interface Action {
  readonly id: ActionId;
  readonly icon: IconName;
  /** i18n key */
  readonly label: string;
  readonly vars?: Readonly<Record<string, string>>;
  readonly danger?: boolean;
}

export interface ActionContext {
  /** the first wisp Grid an app can be published to, if any */
  readonly publishTo?: string;
  readonly pinnedTask: boolean;
  readonly pinnedHome: boolean;
  /** the task it came from is still there */
  readonly task: boolean;
  readonly mobile: boolean;
  /** a date of the version before, as words */
  readonly prevWhen?: string;
}

const a = (id: ActionId, icon: IconName, label: string, more: Partial<Action> = {}): Action => ({ id, icon, label, ...more });

function appActions(it: Item, c: ActionContext): Action[] {
  const out: Action[] = [];
  if (it.running) out.push(a('stop', 'stop', 'stuff.act.stop'));
  if (!it.published && c.publishTo) out.push(a('publish', 'web', 'stuff.act.publish', { vars: { host: c.publishTo } }));
  if (it.published) out.push(a('pubcopy', 'copy', 'stuff.act.pubcopy'), a('pubopen', 'external', 'stuff.act.pubopen'));
  if (behind(it)) out.push(a('update', 'update', 'stuff.act.update'));
  if (it.published) out.push(a('unpublish', 'x', 'stuff.act.unpublish'));
  if (it.db && it.data) out.push(a('resetdata', 'rerun', 'stuff.act.resetdata'));
  // Panes: beside the open task, or on home. Pinning asks first what it may use.
  out.push(c.pinnedTask ? a('unpin-task', 'panel', 'stuff.act.unpinTask') : a('pin-task', 'panel', 'stuff.act.pinTask'));
  out.push(c.pinnedHome ? a('unpin-home', 'pin', 'stuff.act.unpinHome') : a('pin-home', 'pin', 'stuff.act.pinHome'));
  if (it.allowed?.length || it.changed) out.push(a('revoke', 'lock', 'stuff.act.revoke'));
  return out;
}

export function itemActions(it: Item, c: ActionContext): Action[] {
  const app = it.kind === 'app';
  const open = app
    ? a('open', 'play', it.running ? 'stuff.act.openAgain' : 'stuff.act.launch')
    : a('open', it.kind === 'link' ? 'external' : 'expand', it.kind === 'link' ? 'stuff.act.openLink' : 'stuff.act.open');
  const out: Action[] = [open, ...(app ? appActions(it, c) : []), a('mention', 'agent', 'stuff.act.mention')];
  if (canCopy(it)) out.push(a('copy', 'copy', it.kind === 'link' ? 'stuff.act.copyLink' : 'stuff.act.copy'));
  if (canDownload(it)) out.push(a('download', 'download', 'stuff.act.download'));
  out.push(a('star', 'star', it.starred ? 'stuff.act.unstar' : 'stuff.act.star'));
  out.push(a('edit', 'pen', 'stuff.act.edit'));
  if (it.prev) out.push(a('restore', 'rerun', 'stuff.act.restore', { vars: { when: c.prevWhen ?? '' } }));
  if (c.task) out.push(a('task', 'arrow', 'stuff.act.task'));
  if (it.kind !== 'link' && !c.mobile) out.push(a('folder', 'folder', 'stuff.act.folder'));
  out.push(a('remove', 'trash', 'stuff.act.remove', { danger: true }));
  return out;
}
