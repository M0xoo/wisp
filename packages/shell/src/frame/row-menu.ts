// The shell's own entries in a task's row menu (v1 actions.js taskMenu), on `shell.row:menu` like any plugin's:
// Rerun… and Fork… (a new task from this one, its row and page at once, as the task's More does), Changes and Shell
// (the panel beside it), Compare runs (the runs of one ask side by side); v1 #786 sections: Rerun with Open, Fork and
// Side discussion with the task itself, Changes, Shell and Compare under View ›. Which show, by v1's rules (forkable, a side discussion has no Rerun, a pending row no panel).
import { entityKey, uuidv7, type PeerId } from '@wisp/client';
import type { ExtensionDef, ExtensionProps, ShellContext, TaskMenuSection, TaskMenuSub } from '../contract.ts';
import { defineExtension } from '../define.ts';
import { editorUrl } from '../editor.ts';
import { fork, rerun, resumeCommand } from './commands.ts';

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
  /** the harness's own session: Copy resume command */
  readonly resumeId?: string;
  readonly cwd?: string;
}

export const rowOf = (p: ExtensionProps): MenuRow | undefined => p.session?.() as MenuRow | undefined;

/** v1 forkable: a task of yours, not a subagent, a reminder, a delegated job or a side discussion */
export const forkable = (s: MenuRow | undefined): boolean => !!s && s.agent !== 'wisp' && !s.parentId && !s.kind && !s.pending && !s.delegated && !s.sideOf;

/** v1 sideable: a side discussion runs beside a task of yours on this computer */
export const sideable = (s: MenuRow | undefined): boolean => !!s && s.agent !== 'wisp' && !s.parentId && !s.pending && !s.delegated && !s.sideOf && s.kind !== 'reminder' && !s.machine;

const peerOf = (key: string): PeerId => key.slice(0, key.indexOf(':')) as PeerId;
const none = (): null => null;

/** v1 #786's Copy › and Files › entries that need the shell: Copy resume command, Open project in editor */
function copyAndFiles(ctx: ShellContext): ExtensionDef[] {
  // v1 #786 Copy ›: the command that resumes it in its harness
  const copyResume = (key: string): void =>
    void ctx.client.commands
      .run(resumeCommand, { id: key })
      .then((r) => ctx.platform.copy(r.command))
      .then((ok) => ok && ctx.toast.show(ctx.t('shell.more.copiedResume')))
      .catch(() => undefined);
  // v1 #786 Files ›: the project in the editor Settings names, else its path copied
  const editor = (key: string, s: MenuRow | undefined): void => {
    const dir = String(s?.cwd ?? '');
    const url = editorUrl(String(ctx.client.entities.peek<{ value?: unknown }>('setting', entityKey(peerOf(key), 'settings.editor'))?.value ?? ''), dir);
    if (url) ctx.platform.openExternal(url);
    else if (dir) void ctx.platform.copy(dir).then((ok) => ok && ctx.toast.show(ctx.t('shell.more.copiedPath', { path: dir })));
  };
  const withRow = (id: string, label: string, icon: string, order: number, run: (s: MenuRow | undefined) => void, show: (s: MenuRow | undefined) => boolean, at: { sub: TaskMenuSub }): ExtensionDef =>
    defineExtension({ id, attachTo: { id: 'shell.row:menu' }, component: none, order, if: (p) => show(rowOf(p)), bar: { icon, label, priority: order, ...at, select: (p) => run(rowOf(p)) } });
  return [
    withRow('shell.row.copyResume', 'shell.more.copyResume', 'copy', -10, (s) => s && copyResume(s.id), (s) => !!s?.resumeId, { sub: 'copy' }),
    withRow('shell.row.editor', 'shell.more.editor', 'folder', 110, (s) => s && editor(s.id, s), (s) => !!s && !ctx.platform.mobile, { sub: 'files' }),
  ];
}

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
  const item = (
    id: string,
    label: string,
    icon: string,
    order: number,
    run: (key: string) => void,
    show: (s: MenuRow | undefined) => boolean,
    keys?: string,
    at: { section?: TaskMenuSection; sub?: TaskMenuSub } = {},
  ): ExtensionDef =>
    defineExtension({
      id,
      attachTo: { id: 'shell.row:menu' },
      component: none,
      order,
      if: (p) => show(rowOf(p)),
      bar: { icon, label, priority: order, ...(keys && { keys }), ...at, select: (p) => run(rowOf(p)?.id ?? '') },
    });
  return [
    ...copyAndFiles(ctx),
    item(
      'shell.row.rerun',
      'shell.task.rerun',
      'rerun',
      10,
      (k) => ctx.navigate({ t: 'openOverlay', overlay: { kind: 'dialog', id: 'shell.rerun' as never, params: { id: k } } }),
      (s) => !!s && !s.sideOf && !s.pending,
      '⇧R',
      { section: 'open' },
    ),
    item('shell.row.fork', 'shell.row.fork', 'fork', 20, (k) => copy(fork, k), forkable, '⇧F', { section: 'task' }),
    item('shell.row.side', 'shell.row.side', 'discuss', 30, sideDraft, sideable, undefined, { section: 'task' }),
    item(
      'shell.row.changes',
      'shell.task.changes',
      'file',
      60,
      (k) => side('changes', k),
      (s) => !!s && !s.pending,
      undefined,
      { sub: 'view' },
    ),
    item(
      'shell.row.shell',
      'shell.task.shell',
      'terminal',
      70,
      (k) => side('shell', k),
      (s) => !!s && !s.pending,
      undefined,
      { sub: 'view' },
    ),
    // v1: after Run app and Watch, before Save as recipe
    item(
      'shell.row.compare',
      'shell.compare.menu',
      'agent',
      86,
      (k) => ctx.navigate({ t: 'openOverlay', overlay: { kind: 'dialog', id: 'shell.compare' as never, params: { id: k } } }),
      (s) => !!s?.groupId,
      undefined,
      { sub: 'view' },
    ),
  ];
}
