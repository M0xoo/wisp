// Which task is open, as an entity key: nav names a session by id (a key `<peer>:<id>`, or a bare id
// of the home peer, the first one the client has).
import { entityKey, signal, type Client, type EntityKey, type Nav } from '@wisp/client';

export function keyOf(client: Client, id: string): EntityKey | undefined {
  if (id.includes(':')) return id as EntityKey;
  const home = client.peers.list()()[0];
  return home ? entityKey(home, id) : undefined;
}

export function openTaskKey(client: Client, nav: Nav): EntityKey | undefined {
  return nav.main.kind === 'task' ? keyOf(client, nav.main.id) : undefined;
}

export type SidePane = 'changes' | 'shell' | 'pr' | 'preview' | 'watch' | 'term' | 'tab';

/** A plugin's tab beside the task (ShellApi.sideTabs: My Stuff's panes pinned to tasks): `shell-task.tab`, showing
 *  the one last picked. Which one is the panel's own state (v1 kept it in the panel too); a reload opens Changes. */
export const TAB_VIEW = 'shell-task.tab';

/** a plugin's tab as the panel's tabs name it: `<plugin>|<def>|<value>` */
export const tabKey = (plugin: string, def: string, value: string): string => `${plugin}|${def}|${value}`;

/** the plugin tab picked last, by its tabKey */
export const pickedTab = signal<string | undefined>(undefined);

/** A terminal task's CLI, beside it (`shell-task.term`). */
export const TERM_VIEW = 'shell-task.term';

/** A terminal task: its list fields say so (`summary.tui`; flat on a flattened row). */
export function isTui(row: unknown): boolean {
  const r = row as { tui?: boolean; summary?: { tui?: boolean } } | undefined;
  return !!(r?.tui ?? r?.summary?.tui);
}

/** The pane open beside the task: the side kinds nav knows, plus the watch view (`shell-task.watch`). */
export function sideOf(nav: Nav): { pane: SidePane; id: string; file?: string } | undefined {
  const s = nav.side;
  if (s.kind === 'changes' && s.file) return { pane: s.kind, id: s.id, file: s.file };
  if (s.kind === 'changes' || s.kind === 'shell' || s.kind === 'pr' || s.kind === 'preview') return { pane: s.kind, id: s.id };
  if (s.kind === 'view' && s.id === 'shell-task.watch' && nav.main.kind === 'task') return { pane: 'watch', id: nav.main.id };
  if (s.kind === 'view' && s.id === TERM_VIEW && nav.main.kind === 'task') return { pane: 'term', id: nav.main.id };
  if (s.kind === 'view' && s.id === TAB_VIEW && nav.main.kind === 'task') return { pane: 'tab', id: nav.main.id };
  return undefined;
}
