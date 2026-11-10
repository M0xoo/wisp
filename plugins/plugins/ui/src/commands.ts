// Settings → Plugins' reads and writes: every plugin the kernel has (plugins.list) and its switch
// (plugins.setEnabled). The list is read when the pane opens and after a switch.
import { defineCommand, type PeerId } from '@wisp/client';

export interface PluginRow {
  readonly id: string;
  readonly version: string;
  /** active | resolved | off | refused */
  readonly state: string;
  readonly enabled: boolean;
  readonly builtin: boolean;
  readonly reason?: string;
}

export const list = defineCommand<{ peer: PeerId }, PluginRow[]>({ id: 'plugins.list', owner: (a) => a.peer, wire: () => ({}), optimistic: 'none', pending: 'the plugins list' });
export const setEnabled = defineCommand<{ peer: PeerId; id: string; enabled: boolean }>({ id: 'plugins.setEnabled', owner: (a) => a.peer, wire: (a) => ({ id: a.id, enabled: a.enabled }), optimistic: 'none', pending: 'the plugin’s switch' });
