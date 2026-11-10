// What the screens read beyond PluginClient, through the shell's useShell() (packages/shell
// contract.ts ShellContext): navigate, the toaster, the platform. @wisp/shell doesn't export
// useShell() yet, so a Solid context stands in: the shell (or the dev page) provides it, and each
// piece falls back to the PluginClient so the UI still renders on a host that lacks it. One place
// to change once useShell() ships.

import { createContext, useContext } from 'solid-js';
import type { ExtensionId, Intent, PluginClient } from '@wisp/client';
import type { ShellContext } from '@wisp/shell/contract';
import { nullPlatform } from '@wisp/shell/platform';
import { createToaster } from '@wisp/ui';

export type Host = Pick<ShellContext, 'navigate' | 'toast' | 'platform'> & { readonly now: () => number };

export const HostContext = createContext<Partial<Host>>({});

export function useHost(client: PluginClient): Host {
  const h = useContext(HostContext);
  return {
    navigate: h.navigate ?? ((i: Intent) => client.navigate(i)),
    // a refused command's toast still shows: the client's onError hands it to the shell's toaster
    toast: h.toast ?? createToaster(),
    platform: h.platform ?? nullPlatform(),
    now: h.now ?? (() => client.scope.timers.now()),
  };
}

/**
 * Opens Settings at a pane. The shell hasn't named its Settings view yet: this asks for an overlay
 * `shell.settings` with `{ pane, filter? }` (in the report), in one place so it's one edit.
 */
export function openSettings(navigate: (i: Intent) => void, pane: string, filter?: string): void {
  navigate({ t: 'openOverlay', overlay: { kind: 'viewer', id: 'shell-settings.sheet' as ExtensionId, params: filter ? { pane, filter } : { pane } } });
}
