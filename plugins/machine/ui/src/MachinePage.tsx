// This Mac as a page of its own (⌘K, a phone's computer row): the pane under its title, for the
// peer named in the params (a phone looks at one of its computers), else this client's own wisp.

import type { PeerId, PluginClient } from '@wisp/client';
import { Box, Heading, Stack } from '@wisp/ui';
import type { JSX } from 'solid-js';
import { MachinePane } from './MachinePane.tsx';
import { machineLabelKey } from './view.ts';
import { useSignal } from '@wisp/ui';
import { entityKey } from '@wisp/client';
import { SNAPSHOT, THIS, type MachineSnapshot } from './types.ts';

export function MachinePage(props: { readonly client: PluginClient; readonly params: { readonly peer?: string } }): JSX.Element {
  const peer = (): PeerId => (props.params.peer ?? props.client.home) as PeerId;
  const snap = useSignal(props.client.entities.row<MachineSnapshot>(SNAPSHOT, entityKey(peer(), THIS)));
  const title = (): string => {
    const label = props.client.t(machineLabelKey(snap()?.platform));
    return peer() === props.client.home ? label : props.client.peers.name(peer());
  };
  return (
    <Box padX="7" padY="7" part="machine.page">
      <Stack gap="7">
        <Heading level={1} size="title">
          {title()}
        </Heading>
        <MachinePane client={props.client} peer={peer()} />
      </Stack>
    </Box>
  );
}

export default MachinePage;
