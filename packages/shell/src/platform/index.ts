// Picks the platform the page runs on: Tauri's internals mean the desktop app, a native Capacitor
// bridge the Android app, anything else the browser. Features take a `Platform`; nothing else in
// the UI asks which one it is.

import { androidPlatform } from './android.ts';
import { browserPlatform } from './browser.ts';
import { desktopPlatform } from './desktop.ts';
import type { Platform, PlatformWindow } from './types.ts';

export function detectPlatform(w: PlatformWindow): Platform {
  if (w.__TAURI_INTERNALS__) return desktopPlatform(w);
  if (w.Capacitor?.isNativePlatform?.() === true) return androidPlatform(w);
  return browserPlatform(w);
}

/** For tests and server-side checks: every call answers 'unsupported' and nothing happens. */
export function nullPlatform(over: Partial<Platform> = {}): Platform {
  return {
    kind: 'browser',
    mobile: false,
    standalone: false,
    apple: true,
    titlebar: 'none',
    dragRegions: () => () => {},
    notifyPermission: async () => 'unsupported',
    requestNotify: async () => 'unsupported',
    notify: async () => 'unsupported',
    badge: async () => 'unsupported',
    share: async () => 'unsupported',
    pickFiles: async () => [],
    haptic: () => {},
    copy: async () => false,
    openExternal: () => {},
    onResume: () => () => {},
    onOpen: () => () => {},
    reload: () => {},
    ...over,
  };
}

export { androidPlatform, browserPlatform, desktopPlatform };
export type * from './types.ts';
