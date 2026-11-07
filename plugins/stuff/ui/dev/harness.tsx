// The dev page's frame (dev only, never shipped): a real @wisp/client on a memory peer, the
// plugin's views and extensions rendered by kind from the URL, with the kit's theme and toasts.
//   ?view=<view kind>&params=<json>   a registered view, in a page-sized box
//   ?ext=<extension id>               an extension, with ?session=<id> for task-scoped ones
//   &theme=light|dark                 the theme (default: the OS's)
// Delete this once apps/web's shell and mock peer render every plugin.

import '@wisp/ui/kit.css';
import { createClient, entityKey, peerId, type Client, type PluginClient, type Topic } from '@wisp/client';
import type { PeerInfo } from '@wisp/protocol';
import { Box, KitProvider, Text, Toasts, createToaster } from '@wisp/ui';
import { Dynamic, render } from 'solid-js/web';
import type { Component, JSX } from 'solid-js';
import { memoryPeer, type Handler, type SeedRow } from './memory-peer.ts';

export interface DevView {
  readonly kind: string;
  readonly component: Component<{ client: PluginClient; params: never }>;
}
export interface DevExtension {
  readonly id: string;
  readonly component: Component<{ client: PluginClient; config: never; session?: () => { id: string; agent: string } | undefined }>;
}
export interface DevPlugin {
  readonly id: string;
  readonly views?: readonly DevView[];
  readonly extensions?: readonly DevExtension[];
  readonly catalogue?: Record<string, string>;
}

export const DEV_PEER = peerId('laptop');

export function devInfo(plugin: string, topics: readonly string[], commands: readonly string[]): PeerInfo {
  return { peer: 'laptop', name: 'MacBook Pro', build: 'dev', version: '2.0.0', proto_min: 2, proto_max: 2, plugins: [{ id: plugin, version: '2.0.0', commands: [...commands], topics: [...topics], blocks: [] }] };
}

export async function startDev(o: { plugin: DevPlugin; info: PeerInfo; seed: readonly SeedRow[]; handle: Handler; topics: readonly Topic[]; delayMs?: number }): Promise<{ client: Client; root: HTMLElement }> {
  const q = new URLSearchParams(window.location.search);
  const theme = q.get('theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
  const toaster = createToaster();
  const client = createClient({
    clientId: 'dev',
    build: 'dev',
    home: DEV_PEER,
    width: window.innerWidth,
    dev: true,
    onError: (err) => void toaster.error(err.message),
  });
  const transport = memoryPeer(o.info, o.seed, o.handle, o.delayMs ?? 250);
  await client.start([{ peer: DEV_PEER, name: 'MacBook Pro', transport }]);
  for (const t of o.topics) client.peers.watch(DEV_PEER, t, client.scope);
  const pc = client.plugin(o.plugin.id);
  if (o.plugin.catalogue) pc.strings(o.plugin.catalogue);
  const root = document.getElementById('root');
  if (!root) throw new Error('no #root');
  const view = o.plugin.views?.find((v) => v.kind === q.get('view'));
  const ext = o.plugin.extensions?.find((x) => x.id === q.get('ext'));
  const sid = q.get('session');
  const session = sid ? () => ({ id: entityKey(DEV_PEER, sid) as string, agent: 'claude' }) : undefined;
  const params = JSON.parse(q.get('params') ?? 'null') as never;
  const body = (): JSX.Element =>
    view ? (
      <Dynamic component={view.component} client={pc} params={params} />
    ) : ext ? (
      <Dynamic component={ext.component} client={pc} config={{} as never} {...(session && { session })} />
    ) : (
      <Text tone="muted">{`?view= one of ${(o.plugin.views ?? []).map((v) => v.kind).join(', ')}; ?ext= one of ${(o.plugin.extensions ?? []).map((x) => x.id).join(', ')}`}</Text>
    );
  render(
    () => (
      <KitProvider t={(k) => client.i18n.t(k)}>
        <Box part="dev.page" surface="bg">
          {body()}
        </Box>
        <Toasts toaster={toaster} />
      </KitProvider>
    ),
    root,
  );
  return { client, root };
}
