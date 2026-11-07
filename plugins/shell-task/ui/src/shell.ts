// How this plugin reaches the shell's context (ShellContext in @wisp/shell's contract: t, nav,
// navigate, toast, platform, selection, sidebar, palette, extensions). The contract names
// `useShell()` but @wisp/shell doesn't export it yet, so this file is the one place that knows how
// the context arrives: a provider here, used by the shell (and by the tests and dev page) until the
// shell exports its own. Switching over is one edit, here.

import { createContext, useContext } from 'solid-js';
import type { ShellContext } from '@wisp/shell/contract';

export const ShellCtx = createContext<ShellContext>();

export function useShell(): ShellContext {
  const c = useContext(ShellCtx);
  if (!c) throw new Error('shell-task renders inside the shell: no ShellContext above it');
  return c;
}

export const ShellProvider = ShellCtx.Provider;
