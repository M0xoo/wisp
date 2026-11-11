// The shell's own pieces, registered like any plugin's (plan §6.0.3: built-ins get no private API):
// (the frame draws the brand and Search itself: a plugin overrides them on shell.topbar:brand/search) the command palette, the shortcuts sheet and the
// diagnostics inspector as overlay views, the Appearance and Diagnostics settings panes, the
// palette's app commands and task list, and the keys the shell answers itself (v1 keys.js: ⌘K, ⌘L,
// N, Esc, ?, [, ⌃Tab). Any plugin can override one by id or switch it off through `tree`.

import { lazy } from 'solid-js';
import type { ExtensionId, Json } from '@wisp/client';
import type { PaletteItem, PluginUiDef, ShellContext, ShortcutDef } from './contract.ts';
import { defineExtension, defineView } from './define.ts';
import { THEMES } from './theme.ts';
import { SESSION, type SessionRow } from './rows.ts';
import { archive, markRead, remove, setState } from './frame/commands.ts';
import { TASK_KEY, type TaskKey } from './frame/task-keys.ts';

export const SHELL_SETTINGS = [
  { key: 'shell.theme', type: 'enum', values: THEMES, default: 'system', scope: 'server', overridable: true },
  { key: 'shell.sidebar.width', type: 'int', min: 220, max: 640, default: 320, scope: 'device' },
  { key: 'shell.sidebar.open', type: 'bool', default: true, scope: 'device' },
  /** the project the list shows (the top bar's chips): a project's id, or 'all' (v1 wisp.filter) */
  { key: 'shell.projectFilter', type: 'string', default: 'all', scope: 'device' },
  /** other wisps this device connects to: [{ peer, name, base }] */
  { key: 'shell.peers', type: 'json', default: [] as Json[], scope: 'device' },
] as const;

const Palette = lazy(() => import('./palette/Palette.tsx'));
const Shortcuts = lazy(() => import('./frame/Shortcuts.tsx'));
const Inspector = lazy(() => import('./devtools/Inspector.tsx'));
const Appearance = lazy(() => import('./frame/Appearance.tsx'));

const overlay = (id: string): { t: 'openOverlay'; overlay: { kind: 'dialog'; id: ExtensionId; params: null } } => ({
  t: 'openOverlay',
  overlay: { kind: 'dialog', id: id as ExtensionId, params: null },
});
const none = (p: unknown): null | undefined => (p === null || p === undefined ? null : undefined);

function appItems(ctx: ShellContext): PaletteItem[] {
  const g = ctx.t('shell.palette.group.app');
  const theme = (pref: 'light' | 'dark' | 'system', label: string, icon: string): PaletteItem => ({
    id: `shell.theme.${pref}`,
    group: g,
    label: ctx.t(label),
    icon,
    keywords: 'theme appearance colour color mode',
    run: () => void ctx.theme.set(pref),
  });
  return [
    { id: 'shell.home', group: g, label: ctx.t('shell.cmd.home'), icon: 'back', keywords: 'new task launcher start', run: () => ctx.navigate({ t: 'home' }) },
    theme('light', 'shell.cmd.theme.light', 'sun'),
    theme('dark', 'shell.cmd.theme.dark', 'moon'),
    theme('system', 'shell.cmd.theme.system', 'settings'),
    { id: 'shell.sidebar', group: g, label: ctx.t('shell.cmd.sidebar'), icon: 'panel', kbd: '[', keywords: 'sidebar list fold', run: () => ctx.sidebar.toggle() },
    { id: 'shell.shortcuts', group: g, label: ctx.t('shell.cmd.shortcuts'), icon: 'info', kbd: '?', keywords: 'keys keyboard help', run: () => ctx.navigate(overlay('shell.shortcuts')) },
    {
      id: 'shell.diagnostics',
      group: g,
      label: ctx.t('shell.cmd.diagnostics'),
      icon: 'bug',
      keywords: 'devtools debug inspector log state report',
      run: () => ctx.navigate(overlay('shell.devtools')),
    },
  ];
}

function taskItems(ctx: ShellContext): PaletteItem[] {
  const g = ctx.t('shell.palette.group.tasks');
  const rows = ctx.client.entities.list<SessionRow>(SESSION)();
  const out: PaletteItem[] = [];
  for (const s of rows) {
    if (s.archived) continue;
    out.push({
      id: `task:${s.id}`,
      group: g,
      label: s.title,
      sub: ctx.t(`shell.state.${s.state}`),
      icon: s.state === 'running' ? 'spark' : 'feed',
      at: s.updated_at,
      run: () => ctx.navigate({ t: 'openTask', id: s.id as never }),
    });
  }
  return out.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

/** Esc (v1 keys.js): the overlay first, then out of a text box, then Back (side, then the task). */
function escape(ctx: ShellContext, e: KeyboardEvent): boolean {
  const target = e.target as Element | null;
  if (target?.closest?.('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')) return false; // it closes itself
  const nav = ctx.nav();
  if (nav.overlays.length > 0) {
    ctx.navigate({ t: 'closeOverlay' });
    return true;
  }
  if (target?.closest?.('input, textarea, select, [contenteditable="true"]')) {
    (target as HTMLElement).blur();
    return true;
  }
  if (nav.side.kind === 'none' && nav.main.kind === 'home') return false;
  ctx.navigate({ t: 'back' });
  return true;
}

/** O / Enter on the picked row: open it (or, open already, back to the list's place) */
function open(ctx: ShellContext): boolean {
  // a focused control keeps its own Enter (a button, a link, a menu item)
  const f = document.activeElement;
  if (f && f !== document.body && !f.closest('[data-part="card"]')) return false;
  const id = ctx.selection.get();
  if (!id || (ctx.nav().main.kind === 'task' && String((ctx.nav().main as { id?: unknown }).id) === id)) return false;
  void ctx.client.commands.run(markRead, { id, unread: false }).catch(() => undefined);
  ctx.navigate({ t: 'openTask', id: id as never });
  return true;
}

function launcher(ctx: ShellContext): void {
  if (ctx.nav().overlays.length > 0) ctx.navigate({ t: 'closeOverlay', id: ctx.nav().overlays[0]?.id as ExtensionId });
  if (!ctx.focusTargets.focus('launcher')) ctx.navigate({ t: 'home' });
}

/** The list's rows in their order on screen (the list and Home's feed draw a `card` per task with its key). */
const rowIds = (): string[] => [...document.querySelectorAll<HTMLElement>('[data-part="card"][data-id]')].map((e) => e.dataset['id'] ?? '').filter((id, i, all) => id !== '' && all.indexOf(id) === i);

/** The task the keys act on: the open one, else the row picked with J/K. */
function target(ctx: ShellContext): string | undefined {
  const main = ctx.nav().main;
  return main.kind === 'task' ? String(main.id) : ctx.selection.get();
}

/** An action of the open task's page (its Transcript, Ship it, …): handled there, as the button would. */
function taskKey(ctx: ShellContext, act: TaskKey): boolean {
  if (ctx.nav().main.kind !== 'task') return false;
  return !document.dispatchEvent(new CustomEvent(TASK_KEY, { detail: act, cancelable: true }));
}

/** J/K (v1 kbd.js): the next or previous row; with a task open, that task opens (the split follows). */
function step(ctx: ShellContext, by: 1 | -1): boolean {
  const ids = rowIds();
  if (!ids.length) return false;
  const cur = target(ctx);
  const i = cur === undefined ? -1 : ids.indexOf(cur);
  const next = ids[Math.min(ids.length - 1, Math.max(0, i < 0 ? (by > 0 ? 0 : ids.length - 1) : i + by))];
  if (!next) return false;
  ctx.selection.set(next);
  document.querySelector<HTMLElement>(`[data-part="card"][data-id="${CSS.escape(next)}"]`)?.scrollIntoView({ block: 'nearest' });
  if (ctx.nav().main.kind === 'task') ctx.navigate({ t: 'openTask', id: next as never });
  return true;
}

/** E, A, Delete on the open task or the picked row: as its button or menu item does. */
function rowAct(ctx: ShellContext, act: 'done' | 'archive' | 'delete'): boolean {
  if (taskKey(ctx, act)) return true;
  const id = target(ctx);
  if (!id) return false;
  const run = ctx.client.commands.run;
  if (act === 'done') {
    void run(setState, { id, state: 'done' }).catch(() => undefined);
    ctx.navigate({ t: 'markDone', id: id as never });
  } else if (act === 'archive') {
    void run(archive, { id, archived: true }).catch(() => undefined);
    ctx.navigate({ t: 'archive', id: id as never });
  } else {
    void run(remove, { id }).catch(() => undefined);
    ctx.navigate({ t: 'delete', id: id as never });
  }
  return true;
}

function shortcuts(ctx: ShellContext): ShortcutDef[] {
  const k = (id: string, keys: string, label: string, act: TaskKey, group: ShortcutDef['group'] = 'task'): ShortcutDef => ({
    id: `shell.task.${id}`,
    keys,
    label,
    group,
    run: () => taskKey(ctx, act),
  });
  return [
    // the list (v1 kbd.js): J/K, O/Enter, and the row's own keys on the picked row
    { id: 'shell.next', keys: 'j', label: 'shell.key.next', group: 'list', run: () => step(ctx, 1) },
    { id: 'shell.prev', keys: 'k', label: 'shell.key.next', group: 'list', run: () => step(ctx, -1) },
    { id: 'shell.open', keys: 'o', label: 'shell.key.open', group: 'list', run: () => open(ctx) },
    { id: 'shell.open.enter', keys: 'enter', label: 'shell.key.open', group: 'list', run: () => open(ctx) },
    { id: 'shell.done', keys: 'e', label: 'shell.key.done', group: 'task', run: () => rowAct(ctx, 'done') },
    { id: 'shell.archive', keys: 'a', label: 'shell.key.archive', group: 'task', run: () => rowAct(ctx, 'archive') },
    { id: 'shell.delete', keys: 'delete', label: 'shell.key.delete', group: 'task', run: () => rowAct(ctx, 'delete') },
    { id: 'shell.delete.back', keys: 'backspace', label: 'shell.key.delete', group: 'task', run: () => rowAct(ctx, 'delete') },
    // the open task's page: what its buttons and More menu do
    k('follow', '/', 'shell.key.follow', 'reply'),
    k('later', 'l', 'shell.key.later', 'later'),
    k('rename', 'm', 'shell.key.rename', 'rename'),
    k('openIn', 't', 'shell.key.openIn', 'openIn'),
    k('shell', 'ctrl+`', 'shell.key.shell', 'shell'),
    k('pr', 'p', 'shell.key.pr', 'pr'),
    k('changes', 'd', 'shell.key.changes', 'changes'),
    k('transcript', 'v', 'shell.key.transcript', 'transcript'),
    k('rerun', 'shift+r', 'shell.key.rerun', 'rerun'),
    k('fork', 'shift+f', 'shell.key.fork', 'fork'),
    k('ship', 's', 'shell.key.ship', 'ship'),
    k('collapse', 'c', 'shell.key.collapse', 'collapse', 'general'),
    k('top', 'u', 'shell.key.top', 'top', 'general'),
    k('panel', ']', 'shell.key.panel', 'panel', 'general'),
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => k(`answer${n}`, String(n), 'shell.key.answer', `answer:${n}` as TaskKey)),

    { id: 'shell.palette', keys: 'mod+k', label: 'shell.key.palette', group: 'general', when: 'always', run: () => ctx.palette.open() },
    { id: 'shell.launcher', keys: 'mod+l', label: 'shell.key.launcher', group: 'general', when: 'always', run: () => launcher(ctx) },
    { id: 'shell.new', keys: 'n', label: 'shell.key.launcher', group: 'general', run: () => launcher(ctx) },
    { id: 'shell.escape', keys: 'escape', label: 'shell.key.back', group: 'general', when: 'always', run: ({ event }) => escape(ctx, event) },
    { id: 'shell.help', keys: '?', label: 'shell.key.shortcuts', group: 'general', run: () => ctx.navigate(overlay('shell.shortcuts')) },
    { id: 'shell.sidebar', keys: '[', label: 'shell.key.sidebar', group: 'general', run: () => (ctx.nav().layout === 'split' ? ctx.sidebar.toggle() : false) },
  ];
}

export function shellUi(ctx: ShellContext): PluginUiDef {
  return {
    id: 'shell',
    extensions: [],
    views: [
      defineView({ kind: 'shell.palette', slot: 'overlay', overlay: 'dialog', parse: none, component: Palette }),
      defineView({ kind: 'shell.shortcuts', slot: 'overlay', overlay: 'dialog', parse: none, component: Shortcuts, title: () => ctx.t('shell.shortcuts.title') }),
      // add, order, rename and remove projects (v1 features/projects.js); every "Add a project" opens it
      defineView({ kind: 'shell.projects', slot: 'overlay', overlay: 'dialog', parse: none, component: lazy(() => import('./frame/Projects.tsx')), title: () => ctx.t('shell.projects.title') }),
      defineView({ kind: 'shell.devtools', slot: 'overlay', overlay: 'viewer', parse: none, component: Inspector, title: () => ctx.t('shell.diag.title') }),
    ],
    settings: [
      { id: 'shell.appearance', group: 'general', title: 'shell.settings.theme', icon: 'sun', component: Appearance, order: 0 },
      { id: 'shell.diagnostics', group: 'advanced', title: 'shell.diag.title', icon: 'bug', component: Inspector, order: 100 },
    ],
    palette: [
      { id: 'shell.app', order: 100, items: () => appItems(ctx) },
      { id: 'shell.tasks', order: 50, items: () => taskItems(ctx) },
    ],
    shortcuts: shortcuts(ctx),
  };
}
