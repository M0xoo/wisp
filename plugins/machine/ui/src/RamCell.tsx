// A task row's RAM (design/machine-page.md "Task rows"): only for a running task whose summary has
// `res` (the peer sets it over 500 MB or 50% CPU), so most rows never change. It sits in the row's
// fixed-width column before the time; under the thresholds nothing renders and nothing shifts.

import type { ExtensionProps } from '@wisp/shell/contract';
import { Text } from '@wisp/ui';
import { Show, type JSX } from 'solid-js';
import type { RowRes } from './types.ts';
import { resText } from './view.ts';

export function RamCell(props: ExtensionProps): JSX.Element {
  const ram = (): string => resText(props.session?.() as RowRes | undefined);
  return (
    <Show when={ram()}>
      <Text size="xs" tone="muted" numeric nowrap part="card.ram" title={props.client.t('machine.ram', { size: ram() })}>
        {ram()}
      </Text>
    </Show>
  );
}

export default RamCell;
