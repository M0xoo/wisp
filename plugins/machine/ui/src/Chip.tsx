// The top-bar chip (design/machine-page.md "Where", design/layout.md §2): only when it matters
// (memory near the floor, work held, automations paused, processes left behind). In a bar it is a
// control, not a sentence: the number with its icon (`12%`), the long form ("12% memory · 9
// running") in its tooltip and accessible name; collapsed, the icon alone with the tone. The number
// is --warn near the floor and --bad under it; the chip itself stays neutral. Click opens the pane.

import type { ExtensionProps } from '@wisp/shell/contract';
import { Button, IconButton, Text } from '@wisp/ui';
import { Show, createMemo, type JSX } from 'solid-js';
import { useLoad } from './data.ts';
import { openSettings, useHost } from './host.ts';
import { chipOf, loadOf, machineLabelKey } from './view.ts';

export function MachineChip(props: ExtensionProps): JSX.Element {
  const t = props.client.t;
  const host = useHost(props.client);
  const peer = props.client.home;
  const { load, snap } = useLoad(props.client, peer);
  const chip = createMemo(() => {
    const s = snap();
    const l = load() ?? (s ? loadOf(s) : undefined);
    return chipOf({ load: l, pausedUntil: s?.guard.pausedUntil ?? 0, left: s?.leftovers.length ?? 0, now: host.now(), t });
  });
  const name = (): string => t(machineLabelKey(load()?.platform ?? snap()?.platform));
  const label = (): string => {
    const c = chip();
    if (!c) return name();
    const long = t('machine.chip.label', { name: name(), text: `${c.lead}${c.rest}` });
    return c.why ? `${long}. ${c.why}` : long;
  };
  const open = (): void => openSettings(host.navigate, 'machine');
  return (
    <Show when={chip()}>
      {(c) => (
        <Show
          when={props.form !== 'icon'}
          fallback={<IconButton icon="laptop" label={label()} size="sm" {...(c().tone === 'bad' && { tone: 'bad' as const })} onClick={open} part="machine.chip" />}
        >
          <Button variant="ghost" size="sm" icon="laptop" title={label()} aria-label={label()} onClick={open} part="machine.chip">
            <Text tone={c().tone === 'neutral' ? 'ink' : c().tone} numeric weight="semibold">
              {c().lead}
            </Text>
          </Button>
        </Show>
      )}
    </Show>
  );
}

export default MachineChip;
