// What this plugin takes from @wisp/shell, in one place (the shell is being built alongside).
import type { PluginClient } from '@wisp/client';
import type { ExtensionProps, ResolvedExtension } from '@wisp/shell';
import type { Services } from '../types.ts';
import { useShell as useShellContext } from '@wisp/shell';

export { ExtView, usePluginClient } from '@wisp/shell';
export type { ExtensionProps, ResolvedExtension } from '@wisp/shell';

/** The shell's context, with the three services the composer asks for (all optional). */
export const useShell = (): Services => useShellContext() as Services;

/** An attached extension's props outside its render (its bar `select`). */
export function extensionPropsOf(ext: ResolvedExtension, client: PluginClient, scoped: Pick<ExtensionProps, 'session' | 'id'>): ExtensionProps {
  return { client, config: ext.config, ...scoped };
}
