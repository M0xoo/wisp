import type { JSX } from 'solid-js';
import type { ExtensionProps } from '@wisp/shell/contract';
import { Pill, useSignal } from '@wisp/ui';

export default function Probe(props: ExtensionProps): JSX.Element {
  const rows = useSignal(props.client.entities.list<{ title: string }>('session'));
  return <Pill tone="accent">{`${rows().length} rows`}</Pill>;
}
