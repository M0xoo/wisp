// What this UI reads beyond PluginClient: what's open (nav) and the toaster. The shell exposes both
// to screens through useShell() (nav, toast); PluginClient doesn't carry them yet, so they are read
// duck-typed here and fall back (Home; no success toast: a refusal still toasts through the client).
// One place to change once @wisp/shell's useShell() ships.

import { initialNav, type Nav, type PluginClient, type Readable } from '@wisp/client';
import type { Toaster } from '@wisp/ui';

const HOME_NAV = initialNav(1440);

export function navOf(c: PluginClient): Readable<Nav> {
  return (c as PluginClient & { nav?: Readable<Nav> }).nav ?? (() => HOME_NAV);
}

export function toastOf(c: PluginClient): Pick<Toaster, 'show' | 'error'> | undefined {
  return (c as PluginClient & { toast?: Toaster }).toast;
}

/** The plugin's clock (the scope's timers: fake in tests). */
export const nowOf = (c: PluginClient): number => c.scope.timers.now();
