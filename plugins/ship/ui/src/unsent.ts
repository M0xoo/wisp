// What waits to go with a task's next follow-up (v1 F-page-11: "2 comments not sent yet" before Ship or Merge), read
// through the shell's prompt sources (`PromptSourceDef.waiting`): the comments are shell-task's drafts, kept in its
// own client store, so Ship never reads that store; it asks each source that answers, with that source's own client.
import type { PluginClient } from '@wisp/client';
import { useShell, usePluginClient } from '@wisp/shell';

/** Counts what every source holds for the task, when called. Call the hook in a component's setup. */
export function useUnsent(): (task: string) => number {
  const shell = useShell();
  const sources = shell.promptSources?.() ?? (() => []);
  const clients = new Map<string, PluginClient>();
  for (const p of sources()) {
    const plugin = (p as { plugin?: string }).plugin ?? 'shell';
    if (p.waiting && !clients.has(plugin)) clients.set(plugin, usePluginClient(plugin));
  }
  return (task) =>
    sources().reduce((n, p) => {
      const client = clients.get((p as { plugin?: string }).plugin ?? 'shell');
      return n + (p.waiting && client ? p.waiting({ client, task }) : 0);
    }, 0);
}

/** The row as Ship reads it, with what waits counted in. */
export const withUnsent = <S extends { readonly id: string; readonly unsentComments?: number }>(s: S | undefined, count: (task: string) => number): S | undefined =>
  s ? { ...s, unsentComments: (s.unsentComments ?? 0) + count(s.id) } : s;
