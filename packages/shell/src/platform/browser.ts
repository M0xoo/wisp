// The browser: Web Notifications, the Badging API, the Web Share API, an <input type=file> picker,
// navigator.vibrate and the Clipboard API. Each is feature-detected, so Safari, Firefox and an
// insecure origin (http://laptop.local) answer 'unsupported' instead of throwing.

import type { Target } from '@wisp/client';
import type { Haptic, Permission, Platform, PlatformWindow, Shown } from './types.ts';

const VIBRATE: Record<Haptic, number | number[]> = { tap: 8, select: 4, success: [10, 40, 10], warning: [20, 60, 20], error: [30, 50, 30, 50, 30] };

function permissionOf(w: PlatformWindow): Permission {
  const N = w.Notification;
  if (!N) return 'unsupported';
  return N.permission === 'default' ? 'prompt' : N.permission;
}


// size-ok: one object literal of small methods, one per platform call
export function browserPlatform(w: PlatformWindow): Platform {
  const opens = new Set<(t: Target) => void>();
  const nav = w.navigator as Navigator & { setAppBadge?(n: number): Promise<void>; clearAppBadge?(): Promise<void>; standalone?: boolean };
  const coarse = w.matchMedia('(pointer: coarse)').matches;
  const narrow = w.matchMedia('(max-width: 720px)').matches;
  const standalone = w.matchMedia('(display-mode: standalone)').matches || nav.standalone === true;
  const apple = /Mac|iPhone|iPad/.test(nav.platform || nav.userAgent);

  const platform: Platform = {
    kind: 'browser',
    mobile: coarse && narrow,
    standalone,
    apple,
    notifyPermission: () => Promise.resolve(permissionOf(w)),
    async requestNotify() {
      const N = w.Notification;
      if (!N) return 'unsupported';
      if (N.permission !== 'default') return permissionOf(w);
      const answer = await N.requestPermission();
      return answer === 'default' ? 'prompt' : answer;
    },
    async notify(n): Promise<Shown> {
      const N = w.Notification;
      if (!N) return 'unsupported';
      if (N.permission !== 'granted') return 'denied';
      const note = new N(n.title, { ...(n.body !== undefined && { body: n.body }), ...(n.tag !== undefined && { tag: n.tag }), ...(n.silent !== undefined && { silent: n.silent }) });
      if (n.target) {
        const target = n.target;
        note.onclick = () => {
          for (const fn of opens) fn(target);
        };
      }
      return 'shown';
    },
    async badge(count) {
      if (!nav.setAppBadge) return 'unsupported';
      await (count > 0 ? nav.setAppBadge(count) : (nav.clearAppBadge?.() ?? nav.setAppBadge(0))).catch(() => {});
      return 'set';
    },
    async share(d) {
      if (typeof nav.share !== 'function') return 'unsupported';
      const data: ShareData = {};
      if (d.title !== undefined) data.title = d.title;
      if (d.text !== undefined) data.text = d.text;
      if (d.url !== undefined) data.url = d.url;
      if (d.files) data.files = [...d.files];
      if (data.files && nav.canShare && !nav.canShare(data)) return 'unsupported';
      try {
        await nav.share(data);
        return 'shared';
      } catch (err) {
        return err instanceof DOMException && err.name === 'AbortError' ? 'cancelled' : 'unsupported';
      }
    },
    pickFiles(o = {}) {
      return new Promise((resolve) => {
        const input = w.document.createElement('input');
        input.type = 'file';
        if (o.accept) input.accept = o.accept;
        input.multiple = o.multiple === true;
        if (o.capture) input.setAttribute('capture', 'environment');
        input.addEventListener('change', () => resolve([...(input.files ?? [])]), { once: true });
        input.addEventListener('cancel', () => resolve([]), { once: true });
        input.click();
      });
    },
    haptic(kind) {
      if (typeof nav.vibrate === 'function' && coarse) nav.vibrate(VIBRATE[kind]);
    },
    async copy(text) {
      try {
        await nav.clipboard.writeText(text);
        return true;
      } catch {
        return false;
      }
    },
    openExternal(url) {
      w.open(url, '_blank', 'noopener');
    },
    onResume(fn) {
      const on = (): void => {
        if (w.document.visibilityState === 'visible') fn();
      };
      w.document.addEventListener('visibilitychange', on);
      w.addEventListener('focus', fn);
      return () => {
        w.document.removeEventListener('visibilitychange', on);
        w.removeEventListener('focus', fn);
      };
    },
    reload: () => w.location.reload(),
    onOpen(fn) {
      opens.add(fn);
      return () => opens.delete(fn);
    },
  };
  return platform;
}
