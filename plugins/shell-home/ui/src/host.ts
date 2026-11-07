// What Home reads beyond PluginClient, through the shell's useShell() (packages/shell contract.ts
// ShellContext): what's open, navigate, the toaster, the platform, and the extensions attached to
// Home's own inputs. @wisp/shell doesn't export useShell() yet, so a Solid context stands in: the
// shell (or the dev page) provides it, and each piece falls back to the PluginClient so Home still
// renders on a host that lacks it. One place to change once useShell() ships.

import { createContext, useContext } from 'solid-js';
import { initialNav, type Intent, type Nav, type PluginClient } from '@wisp/client';
import type { ResolvedExtension, ShellContext } from '@wisp/shell/contract';
import { nullPlatform } from '@wisp/shell/platform';
import { createToaster } from '@wisp/ui';

export type Host = Pick<ShellContext, 'navigate' | 'toast' | 'platform' | 'nav' | 'extensions' | 'focusTargets'> & { readonly now: () => number };

export const HostContext = createContext<Partial<Host>>({});

const NO_EXTENSIONS = (): readonly ResolvedExtension[] => [];
const WIDE = initialNav(1440);

export function useHost(client: PluginClient): Host {
  const h = useContext(HostContext);
  return {
    navigate: h.navigate ?? ((i: Intent) => client.navigate(i)),
    nav: h.nav ?? ((): Nav => WIDE),
    // a refused command's toast still shows: the client's onError hands it to the shell's toaster
    toast: h.toast ?? createToaster(),
    platform: h.platform ?? nullPlatform(),
    extensions: h.extensions ?? (() => NO_EXTENSIONS),
    focusTargets: h.focusTargets ?? { provide: () => () => {}, focus: () => false },
    now: h.now ?? (() => client.scope.timers.now()),
  };
}
