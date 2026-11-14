// Light, dark or system (v1 web/js/features/theme.js): the `shell.theme` setting. System leaves it
// to the OS (tokens.css reads prefers-color-scheme); light and dark set data-theme on <html>. The
// last one is kept in localStorage too, so index.html's inline script paints it before any module
// loads: no white flash on a dark phone. A theme a plugin locked says who set it instead of changing.

import { computed, effect, signal, type Readable } from '@wisp/client';
import type { ThemePref } from './contract.ts';

export const THEMES = ['system', 'light', 'dark'] as const satisfies readonly ThemePref[];
export const THEME_KEY = 'wisp.theme';

export interface ThemeDeps {
  pref: Readable<string | undefined>;
  lockedBy: Readable<string | undefined>;
  write(pref: ThemePref): Promise<void>;
  root: { setAttribute(k: string, v: string): void; removeAttribute(k: string): void };
  /** the OS's dark mode, and when it changes */
  dark: { matches: boolean; addEventListener(t: 'change', fn: () => void): void; removeEventListener(t: 'change', fn: () => void): void };
  storage?: { setItem(k: string, v: string): void } | undefined;
  onLocked?: (by: string) => void;
}

export interface Theme {
  pref: Readable<ThemePref>;
  resolved: Readable<'light' | 'dark'>;
  set(pref: ThemePref): Promise<void>;
  dispose(): void;
}

const valid = (v: unknown): ThemePref => (v === 'light' || v === 'dark' || v === 'system' ? v : 'system');

export function createTheme(d: ThemeDeps): Theme {
  const pref = computed(() => valid(d.pref()));
  const osDark = signal(d.dark.matches);
  const onOs = (): void => osDark(d.dark.matches);
  d.dark.addEventListener('change', onOs);
  const resolved = computed<'light' | 'dark'>(() => {
    const p = pref();
    return p === 'system' ? (osDark() ? 'dark' : 'light') : p;
  });
  const stop = effect(() => {
    const p = pref();
    if (p === 'system') d.root.removeAttribute('data-theme');
    else d.root.setAttribute('data-theme', p);
    try {
      d.storage?.setItem(THEME_KEY, p);
    } catch {
      // private mode: the inline script falls back to the OS
    }
  });
  return {
    pref,
    resolved,
    async set(p) {
      const by = d.lockedBy();
      if (by) {
        d.onLocked?.(by);
        return;
      }
      // a refusal rolls back and toasts in the command runner; nothing more to do here
      if (p !== pref()) await d.write(p).catch(() => {});
    },
    dispose() {
      stop();
      d.dark.removeEventListener('change', onOs);
    },
  };
}

/** index.html's inline script: it runs before any module, so a dark phone never flashes white. */
export const PREPAINT_THEME = `try{var t=localStorage.getItem('${THEME_KEY}');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}`;
