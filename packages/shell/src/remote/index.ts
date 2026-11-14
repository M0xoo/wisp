// The untrusted tier's UI (ADR-0048): `plugins.ui` says what each untrusted plugin shows; here each one becomes a
// plugin UI the shell registers like any other, its component the remote view host. Only a Settings pane for now
// (a side view, a block renderer and a toolbar button are the ADR's other places).
import { createComponent } from 'solid-js';
import type { PluginUiDef } from '../contract.ts';
import { RemoteView } from './RemoteView.tsx';

export { clean, KIT, type Desc, type Node } from './descriptor.ts';
export { CSP, SANDBOX, frameDoc } from './frame.ts';
export { Render, RemoteView, callAs, readFrame } from './RemoteView.tsx';

/** One entry of `plugins.ui`. */
export interface RemoteUi {
  readonly plugin: string;
  readonly id: string;
  readonly place: string;
  readonly title: string;
  readonly module: string;
}

/** The plugin UIs for what `plugins.ui` gave: one per plugin, its Settings panes in Advanced. */
export function remoteUiDefs(list: readonly RemoteUi[]): PluginUiDef[] {
  const byPlugin = new Map<string, RemoteUi[]>();
  for (const u of list) if (u.place === 'shell.settings' && u.plugin.startsWith('user.')) byPlugin.set(u.plugin, [...(byPlugin.get(u.plugin) ?? []), u]);
  return [...byPlugin].map(([plugin, uis]) => ({
    id: plugin,
    catalogue: Object.fromEntries(uis.map((u) => [`${u.id}.title`, u.title])),
    settings: uis.map((u, i) => ({
      id: u.id,
      group: 'advanced',
      title: `${u.id}.title`,
      icon: 'plug',
      order: 90 + i,
      component: (p) => createComponent(RemoteView, { client: p.client, plugin, module: u.module, title: u.title }),
    })),
  }));
}
