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
  return {
    ...base,
    kind: 'desktop',
    mobile: false,
    standalone: true,
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
