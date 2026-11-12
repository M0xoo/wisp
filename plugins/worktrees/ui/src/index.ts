// wisp.worktrees' UI: the Settings → Worktrees pane, and Keep worktree in a task's row menu.
import { lazy } from 'solid-js';
import { entityKey, type EntityKey, type PeerId, type PluginClient } from '@wisp/client';
import { defineExtension, type PluginUiDef } from '@wisp/shell';
import { catalogue } from './i18n.ts';
import { keep } from './commands.ts';
import { KIND } from './types.ts';

interface RowLike {
  readonly id: string;
  readonly branch?: string;
  readonly foreign?: unknown;
  readonly keepWorktree?: boolean;
}

const peerOf = (key: string): PeerId => key.slice(0, key.indexOf(':')) as PeerId;
const bare = (key: string): string => key.slice(key.indexOf(':') + 1);

const ui: PluginUiDef = {
  id: 'wisp.worktrees',
  settings: [{ id: 'worktrees', group: 'computers', title: 'worktrees.pane.worktrees', icon: 'branch', order: 40, component: lazy(() => import('./panes/Worktrees.tsx')) }],
  // Keep worktree / Stop keeping worktree (v1 actions.js keepItem): a task with a branch of its own, after Save for later
  extensions: [
    defineExtension({
      id: 'wisp.worktrees.rowKeep',
      attachTo: { id: 'shell.row:menu' },
      component: () => null,
      order: 120,
      if: (p) => {
        const s = p.session?.() as RowLike | undefined;
        return !!s?.branch && !s.foreign;
      },
      bar: {
        icon: 'pin',
        label: 'worktrees.keep',
        priority: 120,
        place: 'end',
        text: (p) => (kept(p.client, p.session?.() as RowLike | undefined) ? catalogue['worktrees.unkeep'] : catalogue['worktrees.keep']) ?? '',
        select: (p) => {
          const s = p.session?.() as RowLike | undefined;
          if (s) void p.client.run(keep, { peer: peerOf(s.id), id: bare(s.id), keep: !kept(p.client, s) }).catch(() => undefined);
        },
      },
    }),
  ],
  catalogue,
};
export default ui;

/** kept: the row says so, or the worktree's own row (its status) does */
function kept(c: PluginClient, s: RowLike | undefined): boolean {
  if (!s) return false;
  if (s.keepWorktree !== undefined) return s.keepWorktree;
  return (c.entities.peek<{ status?: string }>(KIND.item, entityKey(peerOf(s.id), bare(s.id)) as EntityKey) as { status?: string } | undefined)?.status === 'kept';
}
