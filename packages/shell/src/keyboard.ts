// The page-wide key listener: the IME guard in the capture phase (before any text box sees the
// Enter that only picked a word), then the shortcut dispatch once the event has bubbled past
// whatever had focus. A popover or a dialog that handled Escape itself (Zag does) called
// preventDefault, so its Escape never also goes Back.

import type { PluginClient } from '@wisp/client';
import type { ShellContext } from './contract.ts';
import { candidates, imeArtifact } from './keys.ts';
import type { Registry } from './registry.ts';
import type { ShellWindow } from './shell.tsx';

const TYPING = 'input, textarea, select, [contenteditable="true"], [contenteditable=""]';

export function isTyping(target: EventTarget | null): boolean {
  const el = target as Element | null;
  return typeof el?.closest === 'function' && el.closest(TYPING) !== null;
}

export function installKeys(w: ShellWindow, ctx: ShellContext, registry: Registry, clientOf: (plugin: string) => PluginClient): () => void {
  const guard = (e: Event): void => {
    if (imeArtifact(e as KeyboardEvent)) e.stopImmediatePropagation();
  };
  const dispatch = (ev: Event): void => {
    const e = ev as KeyboardEvent;
    if (e.defaultPrevented || e.repeat && e.key === 'Escape') return;
    const nav = ctx.nav();
    const st = { typing: isTyping(e.target), overlay: nav.overlays.length > 0, focused: ctx.selection.get(), apple: ctx.platform.apple };
    for (const s of candidates(registry.shortcuts(), e, st)) {
      const handled = s.run({ client: clientOf(s.plugin), nav, focused: st.focused, event: e });
      if (handled !== false) {
        e.preventDefault();
        return;
      }
    }
  };
  w.addEventListener('keydown', guard, true);
  w.addEventListener('keydown', dispatch);
  return () => {
    w.removeEventListener('keydown', guard, true);
    w.removeEventListener('keydown', dispatch);
  };
}
