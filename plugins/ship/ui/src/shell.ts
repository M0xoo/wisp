// How this plugin reaches the shell's context (ShellContext in @wisp/shell's contract: toast, nav,
// platform, focus targets). The contract names `useShell()` but @wisp/shell doesn't export it yet,
// so this file is the one place that knows how the context arrives: a provider here, used by the
// shell (and by the tests and dev page) until the shell exports its own. Switching is one edit.

import { createContext, useContext } from 'solid-js';
import type { ShellContext } from '@wisp/shell/contract';

/** The part of the shell this plugin uses. */
export type ShipShell = Pick<ShellContext, 'toast' | 'nav' | 'platform' | 'focusTargets'>;

export const ShellCtx = createContext<ShipShell>();
export const ShellProvider = ShellCtx.Provider;

export function useShell(): ShipShell {
  const c = useContext(ShellCtx);
  if (!c) throw new Error('wisp.ship renders inside the shell: no ShellContext above it');
  return c;
}

/** Stacked (< 900 px, the phone app): the PR is a page, its verdict a bar at the bottom. */
export const stacked = (shell: ShipShell): boolean => shell.nav().layout === 'stack';
