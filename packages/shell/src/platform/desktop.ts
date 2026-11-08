// The Tauri desktop app (desktop/src-tauri). Its init.js already backs window.Notification with
// tauri-plugin-notification and opens the task on a click, so notifications take the browser's
// road. What differs: links open in the system browser (tauri-plugin-opener), the dock badge is the
// window's, and the app's own focus event is the resume signal. A command the native side hasn't
// wired answers like the browser would.

import { browserPlatform } from './browser.ts';
import type { Platform, PlatformWindow } from './types.ts';

export function desktopPlatform(w: PlatformWindow): Platform {
  const base = browserPlatform(w);
  const invoke = (cmd: string, args?: Record<string, unknown>): Promise<unknown> =>
    w.__TAURI_INTERNALS__ ? w.__TAURI_INTERNALS__.invoke(cmd, args) : Promise.reject(new Error('not in Tauri'));
  const mac = /Mac/.test(w.navigator.platform);
  return {
    ...base,
    kind: 'desktop',
    mobile: false,
    standalone: true,
    titlebar: mac ? 'mac' : 'none',
    // WebKit has no -webkit-app-region: a press on a region the frame marks [data-drag] (the top bar,
    // the rail, a task's head) moves the window, and a double press zooms it, as v1's init.js did; the
    // nearest control (a button, a link, a field, or [data-no-drag]) keeps its press.
    dragRegions(root) {
      if (!mac) return () => {};
      const down = (e: Event): void => {
        const m = e as MouseEvent;
        if (m.button !== 0 || m.ctrlKey || !(m.target instanceof Element)) return;
        const hit = m.target.closest('[data-drag], [data-no-drag], button, a, input, textarea, select, [role="button"], [contenteditable="true"]');
        if (!hit?.hasAttribute('data-drag')) return;
        m.preventDefault();
        invoke(m.detail === 2 ? 'zoom_window' : 'start_drag').catch(() => {});
      };
      root.addEventListener('mousedown', down, true);
      return () => root.removeEventListener('mousedown', down, true);
    },
    async badge(count) {
      try {
        await invoke('plugin:window|set_badge_count', { label: 'main', value: count > 0 ? count : null });
        return 'set';
      } catch {
        return base.badge(count);
      }
    },
    openExternal(url) {
      invoke('plugin:opener|open_url', { url }).catch(() => base.openExternal(url));
    },
  };
}
