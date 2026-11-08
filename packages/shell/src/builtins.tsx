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

export const SHELL_SETTINGS = [
  { key: 'shell.theme', type: 'enum', values: THEMES, default: 'system', scope: 'server', overridable: true },
  { key: 'shell.sidebar.width', type: 'int', min: 220, max: 640, default: 320, scope: 'device' },
  { key: 'shell.sidebar.open', type: 'bool', default: true, scope: 'device' },
  /** other wisps this device connects to: [{ peer, name, base }] */
  { key: 'shell.peers', type: 'json', default: [] as Json[], scope: 'device' },
] as const;

const Palette = lazy(() => import('./palette/Palette.tsx'));
const Shortcuts = lazy(() => import('./frame/Shortcuts.tsx'));
const Inspector = lazy(() => import('./devtools/Inspector.tsx'));
const Appearance = lazy(() => import('./frame/Appearance.tsx'));

const overlay = (id: string): { t: 'openOverlay'; overlay: { kind: 'dialog'; id: ExtensionId; params: null } } => ({ t: 'openOverlay', overlay: { kind: 'dialog', id: id as ExtensionId, params: null } });
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
    { id: 'shell.diagnostics', group: g, label: ctx.t('shell.cmd.diagnostics'), icon: 'bug', keywords: 'devtools debug inspector log state report', run: () => ctx.navigate(overlay('shell.devtools')) },
  ];
}

function taskItems(ctx: ShellContext): PaletteItem[] {
  const g = ctx.t('shell.palette.group.tasks');
  const rows = ctx.client.entities.list<SessionRow>(SESSION)();
  const out: PaletteItem[] = [];
  for (const s of rows) {
    if (s.archived) continue;
    out.push({ id: `task:${s.id}`, group: g, label: s.title, sub: ctx.t(`shell.state.${s.state}`), icon: s.state === 'running' ? 'spark' : 'feed', at: s.updated_at, run: () => ctx.navigate({ t: 'openTask', id: s.id as never }) });
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

function launcher(ctx: ShellContext): void {
  if (ctx.nav().overlays.length > 0) ctx.navigate({ t: 'closeOverlay', id: ctx.nav().overlays[0]?.id as ExtensionId });
  if (!ctx.focusTargets.focus('launcher')) ctx.navigate({ t: 'home' });
}

function shortcuts(ctx: ShellContext): ShortcutDef[] {
  return [
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
    extensions: [
    ],
    views: [
      defineView({ kind: 'shell.palette', slot: 'overlay', overlay: 'dialog', parse: none, component: Palette }),
      defineView({ kind: 'shell.shortcuts', slot: 'overlay', overlay: 'dialog', parse: none, component: Shortcuts, title: () => ctx.t('shell.shortcuts.title') }),
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
