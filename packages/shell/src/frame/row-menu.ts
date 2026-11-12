// The shell's own entries in a task's row menu (v1 actions.js taskMenu), on `shell.row:menu` like any plugin's:
// Rerun… and Fork… (a new task from this one, its row and page at once, as the task's More does), Changes and Shell
// (the panel beside it), Compare runs (the runs of one ask side by side). Which show, by v1's rules (forkable, a side discussion has no Rerun, a pending row no panel).
import { entityKey, uuidv7, type PeerId } from '@wisp/client';
import type { ExtensionDef, ExtensionProps, ShellContext } from '../contract.ts';
import { defineExtension } from '../define.ts';
import { fork, rerun } from './commands.ts';

/** The row as the list lends it: its key in `id`, the list's flattened fields. */
export interface MenuRow {
  readonly id: string;
  readonly agent?: string;
  readonly pending?: boolean;
  readonly parentId?: string;
  readonly kind?: string;
  readonly delegated?: unknown;
  readonly sideOf?: unknown;
  readonly machine?: unknown;
  /** the runs of one ask share it (wisp --compare): Compare runs */
  readonly groupId?: string;
}

export const rowOf = (p: ExtensionProps): MenuRow | undefined => p.session?.() as MenuRow | undefined;

/** v1 forkable: a task of yours, not a subagent, a reminder, a delegated job or a side discussion */
export const forkable = (s: MenuRow | undefined): boolean => !!s && s.agent !== 'wisp' && !s.parentId && !s.kind && !s.pending && !s.delegated && !s.sideOf;

/** v1 sideable: a side discussion runs beside a task of yours on this computer */
export const sideable = (s: MenuRow | undefined): boolean => !!s && s.agent !== 'wisp' && !s.parentId && !s.pending && !s.delegated && !s.sideOf && s.kind !== 'reminder' && !s.machine;

const peerOf = (key: string): PeerId => key.slice(0, key.indexOf(':')) as PeerId;
const none = (): null => null;

export function rowMenuItems(ctx: ShellContext): ExtensionDef[] {
  const copy = (cmd: typeof rerun, key: string): void => {
    const newId = entityKey(peerOf(key), uuidv7());
    void ctx.client.commands.run(cmd, { id: key, newId, at: Date.now() }).catch(() => undefined);
    ctx.navigate({ t: 'openTask', id: newId as never });
  };
  const side = (kind: 'changes' | 'shell', key: string): void => {
    ctx.navigate({ t: 'openTask', id: key as never });
    ctx.navigate({ t: 'openSide', side: { kind, id: key as never } });
  };
  // v1 side.js sideDraft: open the task, its reply box starting with /side (a draft there becomes the opening message)
  const sideDraft = (key: string): void => {
    ctx.navigate({ t: 'openTask', id: key as never });
    let tries = 0;
    const go = (): void => {
      const box = ctx.prompts?.get('reply');
      if (!box) return void (++tries < 30 && requestAnimationFrame(go));
      const v = box.text().trim();
      if (!/^\/side\b/.test(v)) box.set(`/side ${v}`);
      box.focus();
    };
    requestAnimationFrame(go);
  };
  const item = (id: string, label: string, icon: string, order: number, run: (key: string) => void, show: (s: MenuRow | undefined) => boolean, keys?: string): ExtensionDef =>
    defineExtension({
      id,
      attachTo: { id: 'shell.row:menu' },
      component: none,
      order,
      if: (p) => show(rowOf(p)),
      bar: { icon, label, priority: order, ...(keys && { keys }), select: (p) => run(rowOf(p)?.id ?? '') },
    });
  return [
    item(
      'shell.row.rerun',
      'shell.task.rerun',
      'rerun',
      10,
      (k) => copy(rerun, k),
      (s) => !!s && !s.sideOf && !s.pending,
      '⇧R',
    ),
    item('shell.row.fork', 'shell.row.fork', 'fork', 20, (k) => copy(fork, k), forkable, '⇧F'),
    item('shell.row.side', 'shell.row.side', 'discuss', 30, sideDraft, sideable),
    item(
      'shell.row.changes',
      'shell.task.changes',
      'file',
      60,
      (k) => side('changes', k),
      (s) => !!s && !s.pending,
    ),
    item(
      'shell.row.shell',
      'shell.task.shell',
      'terminal',
      70,
      (k) => side('shell', k),
      (s) => !!s && !s.pending,
    ),
    // v1: after Run app and Watch, before Save as recipe
    item(
      'shell.row.compare',
      'shell.compare.menu',
      'agent',
      86,
      (k) => ctx.navigate({ t: 'openOverlay', overlay: { kind: 'dialog', id: 'shell.compare' as never, params: { id: k } } }),
      (s) => !!s?.groupId,
    ),
  ];
}
