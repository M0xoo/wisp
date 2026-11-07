// The real @wisp/client on the mock peer: what the dev page and the tests run the task view on.
// Dev-only (copied from plugins/crew/ui/dev).
import { createClient, memoryHistory, peerId, type Client, type CommandError, type PluginClient } from '@wisp/client';
import type { Topic } from '@wisp/protocol';
import { mockPeer, type MockPeer, type MockPeerOptions } from './mock-peer.ts';

export interface Harness {
  readonly client: Client;
  readonly plugin: PluginClient & { readonly nav: Client['nav']['nav'] };
  readonly mock: MockPeer;
  readonly errors: { cmd: string; message: string }[];
  /** resolves once every watched topic's snapshot is in */
  ready(): Promise<void>;
}

export interface HarnessOptions extends Omit<MockPeerOptions, 'peer'> {
  plugin: string;
  peer?: string;
  width?: number;
  /** topics to keep live (the shell subscribes list and crew for everyone) */
  watch?: readonly Topic[];
  onError?: (err: CommandError, cmd: string) => void;
}

export function harness(o: HarnessOptions): Harness {
  const peer = peerId(o.peer ?? 'laptop');
  const mock = mockPeer({ ...o, peer });
  const errors: { cmd: string; message: string }[] = [];
  const client = createClient({
    clientId: 'dev',
    build: 'dev',
    home: peer,
    width: o.width ?? 1440,
    history: memoryHistory('/'),
    onError: (err, cmd) => {
      errors.push({ cmd, message: err.message });
      o.onError?.(err, cmd);
    },
  });
  const base = client.plugin(o.plugin);
  // the shell's useShell().nav, which src/host.ts reads until PluginClient carries it
  const plugin = { ...base, nav: client.nav.nav };
  const topics = o.watch ?? (Object.keys(o.rows) as Topic[]);
  const started = client.start([{ peer, name: o.name ?? 'This Mac', transport: mock.transport }]).then(() => {
    for (const t of topics) client.peers.watch(peer, t, client.scope);
  });
  return {
    client,
    plugin,
    mock,
    errors,
    async ready() {
      await started;
      for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 0));
        const kinds = new Set(Object.values(o.rows).flatMap((rows) => rows.map((r) => r.e)));
        if ([...kinds].every((k) => client.entities.keys(k)().length > 0)) return;
      }
    },
  };
}
