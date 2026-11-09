// The page-wide shortcuts (v1 ui/kbd.js shortcuts()), as data: the Keyboard shortcuts pane lists
// them, grouped. Chords read as on this OS: ⌘K on a Mac, Ctrl+K elsewhere.

import type { Key } from './i18n.ts';

export interface Shortcut {
  readonly keys: readonly string[];
  readonly label: Key;
  /** only in the desktop app (Chrome never hands ⌃Tab to a page) */
  readonly desktopOnly?: boolean;
}

export interface ShortcutGroup {
  readonly title: Key;
  readonly items: readonly Shortcut[];
}

export function shortcutGroups(mac: boolean): readonly ShortcutGroup[] {
  const mod = (k: string): string => (mac ? `⌘${k}` : `Ctrl+${k}`);
  return [
    {
      title: 'shell-settings.keys.tasks',
      items: [
        { keys: [mod('K')], label: 'shell-settings.keys.palette' },
        { keys: ['N', mod('L')], label: 'shell-settings.keys.new' },
        { keys: ['J', 'K'], label: 'shell-settings.keys.next' },
        { keys: [mac ? '⌃⇥' : 'Ctrl+Tab'], label: 'shell-settings.keys.last', desktopOnly: true },
        { keys: ['O', '↵'], label: 'shell-settings.keys.expand' },
        { keys: ['/'], label: 'shell-settings.keys.follow' },
        { keys: ['E'], label: 'shell-settings.keys.done' },
        { keys: ['A'], label: 'shell-settings.keys.archive' },
        { keys: ['L'], label: 'shell-settings.keys.later' },
        { keys: ['M'], label: 'shell-settings.keys.rename' },
        { keys: ['⌫'], label: 'shell-settings.keys.delete' },
        { keys: ['T'], label: 'shell-settings.keys.openIn' },
        { keys: ['⌃`'], label: 'shell-settings.keys.shell' },
        { keys: ['P'], label: 'shell-settings.keys.pr' },
        { keys: ['D'], label: 'shell-settings.keys.changes' },
        { keys: ['V'], label: 'shell-settings.keys.transcript' },
        { keys: ['⇧R'], label: 'shell-settings.keys.rerun' },
        { keys: ['⇧F'], label: 'shell-settings.keys.fork' },
        { keys: ['S'], label: 'shell-settings.keys.ship' },
        { keys: ['1–9'], label: 'shell-settings.keys.answer' },
      ],
    },
    {
      title: 'shell-settings.keys.boxes',
      items: [
        { keys: ['↵'], label: 'shell-settings.keys.send' },
        { keys: ['⇧↵'], label: 'shell-settings.keys.newline' },
        { keys: ['↑', '↓'], label: 'shell-settings.keys.history' },
        { keys: ['/feedback'], label: 'shell-settings.keys.feedback' },
        { keys: ['/bug'], label: 'shell-settings.keys.bug' },
      ],
    },
    {
      title: 'shell-settings.keys.view',
      items: [
        { keys: ['C'], label: 'shell-settings.keys.collapse' },
        { keys: ['U'], label: 'shell-settings.keys.top' },
        { keys: ['['], label: 'shell-settings.keys.list' },
        { keys: [']'], label: 'shell-settings.keys.side' },
        { keys: ['Esc'], label: 'shell-settings.keys.escape' },
      ],
    },
  ];
}

export const isMac = (platform: string): boolean => /Mac|iPhone|iPad/.test(platform);
