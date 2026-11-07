// What this UI reads beyond PluginClient: what's open (nav) and the toaster. The shell gives screens
// both through useShell() (ShellContext.nav, .toast); PluginClient doesn't carry them yet, so they're
// read duck-typed here, with fallbacks: Home, and no toast (a refused command still rolls back and the
// shell's own onError toast says why). One place to change once @wisp/shell's useShell() ships.

import { initialNav, type Nav, type PluginClient, type Readable } from '@wisp/client';
import type { Toaster } from '@wisp/ui';

const HOME_NAV = initialNav(1440);

export function navOf(c: PluginClient): Readable<Nav> {
  return (c as PluginClient & { nav?: Readable<Nav> }).nav ?? (() => HOME_NAV);
}

export function toastOf(c: PluginClient): Pick<Toaster, 'show' | 'error'> | undefined {
  return (c as PluginClient & { toast?: Toaster }).toast;
}
