// Keyboard shortcuts as they read on this OS, how they're matched, and the dialog that lists them.

import { el } from '../core/dom.js';
import { overlay } from './overlay.js';

// The keyboard shortcut for a menu item, shown at its right edge. Menus act on the
// focused card, so the key does the same thing as the click.
export const keyHint = (k) => `<kbd class="menu-kbd">${k}</kbd>`;

export function shortcuts() {
  const rows = [
    [combo('K'), 'Search & commands'],
    [`N · ${combo('L')}`, 'New task (focus the prompt box)'],
    ['J / K', 'Next / previous item'],
    ['O / ↵', 'Expand / collapse item'],
    ['/', 'Follow up on item'],
    ['E', 'Mark done & go to next'],
    ['A', 'Archive / unarchive'],
    ['M', 'Rename item'],
    ['⌫', 'Delete item'],
    ['T', 'Take over in terminal'],
    ['V', 'Full transcript / presentation'],
    ['⇧R', 'Rerun with another harness, model or thinking level'],
    ['S', 'Ship it: commit, push and open a PR (worktree tasks)'],
    ['1–9', 'Pick an answer when asked'],
    ['↵', 'Launch / send'],
    ['⇧↵', 'New line'],
    ['↑ / ↓', 'Earlier prompts (in an empty prompt box)'],
    ['/feedback', 'Send feedback to the wisp team (in any prompt box)'],
    ['C', 'Collapse all'],
    ['U', 'Back to top'],
    ['\\', 'Feed view / split view (tasks in a sidebar)'],
    ['Esc', 'Close / collapse'],
  ];
  const node = el(`<div class="modal keys-modal"><header><h2>Shortcuts</h2></header>${rows.map(([k, l]) => `<div class="krow"><kbd>${k}</kbd><span>${l}</span></div>`).join('')}</div>`);
  overlay(node);
}

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);

// How a modifier shortcut reads on this OS: "⌘L" on macOS, "Ctrl+L" on Windows/Linux.
export const combo = (k) => (IS_MAC ? `⌘${k}` : `Ctrl+${k}`);

// ⌘ on macOS, Ctrl elsewhere (AltGr on Windows reports Ctrl+Alt, so Alt is excluded). Falls back to
// the physical key on non-Latin layouts, where e.key is e.g. "д" for the L key.
export const modKey = (e, k) =>
  (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey &&
  (e.key.toLowerCase() === k || (!/^[a-z]$/i.test(e.key) && e.code === `Key${k.toUpperCase()}`));
