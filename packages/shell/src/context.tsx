// The shell context: what screens and extensions read through useShell() (the contract's
// ShellContext). Provided once by the shell's render; reading it outside one is a bug, said loudly.

import { createContext, useContext, type JSX } from 'solid-js';
import type { ShellContext } from './contract.ts';

const Ctx = createContext<ShellContext>();

export function ShellProvider(props: { readonly value: ShellContext; readonly children: JSX.Element }): JSX.Element {
  return <Ctx.Provider value={props.value}>{props.children}</Ctx.Provider>;
}

export function useShell(): ShellContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useShell() outside the shell: render inside createShell().render()');
  return ctx;
}

/** t('key', vars), from the shell's i18n */
export function useT(): ShellContext['t'] {
  return useShell().t;
}
