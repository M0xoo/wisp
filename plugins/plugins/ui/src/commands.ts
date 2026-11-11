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
export const setEnabled = defineCommand<{ peer: PeerId; id: string; enabled: boolean }>({
  id: 'plugins.setEnabled',
  owner: (a) => a.peer,
  wire: (a) => ({ id: a.id, enabled: a.enabled }),
  optimistic: 'none',
  pending: 'the plugin’s switch',
});

/** What `plugins.install` answers: the plugin, off, and what it asks for (switching it on is the consent). */
export interface Installed {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly permissions: readonly string[];
  readonly folder: string;
}

export const install = defineCommand<{ peer: PeerId; source: string }, Installed>({
  id: 'plugins.install',
  owner: (a) => a.peer,
  wire: (a) => ({ source: a.source }),
  optimistic: 'none',
  pending: 'Install',
});
export const uninstall = defineCommand<{ peer: PeerId; id: string }>({
  id: 'plugins.uninstall',
  owner: (a) => a.peer,
  wire: (a) => ({ id: a.id }),
  optimistic: 'none',
  pending: 'the plugin’s Remove',
});

/** A permission in words (`proc:exec{bin:git}` → "run git"); one not known here reads as it is. */
export function permissionWords(p: string, say: (k: string, v?: Readonly<Record<string, string>>) => string): string {
  const m = /^([a-z-]+):([a-zA-Z.*-]+)(?:\{(.*)\})?$/.exec(p.trim());
  if (!m) return p;
  const [, ns = '', verb = '', args = ''] = m;
  const kv = new Map(
    args
      .split(',')
      .map((x) => x.split(':').map((y) => y.trim()))
      .filter((x): x is [string, string] => x.length === 2),
  );
  const arg = (k: string): string => kv.get(k) ?? '';
  if (ns === 'proc' && verb === 'exec') return say('plugins.perm.exec', { bin: arg('bin') || '*' });
  if (ns === 'net') return say('plugins.perm.net', { host: args || '*' });
  if (ns === 'fs') return say(verb === 'write' ? 'plugins.perm.fsWrite' : 'plugins.perm.fsRead', { path: args || '*' });
  if (verb === 'read' || verb === 'list' || verb === 'get') return say('plugins.perm.read', { what: ns });
  return say('plugins.perm.do', { what: `${ns} ${verb}` });
}
