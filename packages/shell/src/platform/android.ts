// The Capacitor Android app (mobile/android). Its Java stays as it is (plan §7): WispSsh opens links
// outside, and the stock Capacitor plugins (Share, Haptics, LocalNotifications) are used when the
// build has them. Anything not wired yet falls back to the WebView's own browser APIs, which on
// Android cover share, vibrate and the file picker.

import { browserPlatform } from './browser.ts';
import type { CapacitorGlobal, Haptic, Platform, PlatformWindow } from './types.ts';

type PluginFn = (args?: unknown) => Promise<unknown>;

function pluginFn(cap: CapacitorGlobal | undefined, plugin: string, method: string): PluginFn | undefined {
  return cap?.Plugins?.[plugin]?.[method];
}

const IMPACT: Record<Haptic, string> = { tap: 'LIGHT', select: 'LIGHT', success: 'MEDIUM', warning: 'MEDIUM', error: 'HEAVY' };

export function androidPlatform(w: PlatformWindow): Platform {
  const base = browserPlatform(w);
  const cap = w.Capacitor;
  const call = async (plugin: string, method: string, args?: unknown): Promise<unknown> => {
    const fn = pluginFn(cap, plugin, method);
    if (!fn) throw new Error(`${plugin}.${method} is not in this build`);
    return fn(args);
  };
  return {
    ...base,
    kind: 'android',
    mobile: true,
    standalone: true,
    async notify(n) {
      const fn = pluginFn(cap, 'LocalNotifications', 'schedule');
      if (!fn) return base.notify(n);
      await fn({ notifications: [{ id: Math.floor(Math.random() * 2 ** 31), title: n.title, body: n.body ?? '', extra: n.target ?? null }] });
      return 'shown';
    },
    async share(d) {
      if (!pluginFn(cap, 'Share', 'share')) return base.share(d);
      try {
        await call('Share', 'share', { title: d.title, text: d.text, url: d.url });
        return 'shared';
      } catch {
        return 'cancelled';
      }
    },
    haptic(kind) {
      if (pluginFn(cap, 'Haptics', 'impact')) void call('Haptics', 'impact', { style: IMPACT[kind] }).catch(() => {});
      else base.haptic(kind);
    },
    openExternal(url) {
      call('WispSsh', 'openExternal', { url }).catch(() => base.openExternal(url));
    },
  };
}
