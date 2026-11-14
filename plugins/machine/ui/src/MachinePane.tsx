// This Mac (This PC, This computer): what agents cost the computer, and acting on it
// (design/machine-page.md). Top to bottom: gauges with their last hour, what's using it, what was
// left behind, space to free, the harnesses' folders, automations, the last 24 hours. Painted
// from the cached row first (first paint comes from IndexedDB), then kept live by the topic.

import type { PeerId, PluginClient } from '@wisp/client';
import { Button, Dialog, ExtensionSlot, Gauges, Inline, Stack, Text, type GaugeProps } from '@wisp/ui';
import { createMemo, createSignal, Show, type JSX } from 'solid-js';
import { Automations, Day } from './Automations.tsx';
import { useMachineData, type MachineData } from './data.ts';
import { openSettings, useHost } from './host.ts';
import { FreeUp, HarnessData } from './Space.tsx';
import { LeftBehind, Using } from './Using.tsx';
import { memTone, pctText, size, sparkPoints, updatedLine, type T } from './view.ts';

/** wisp's default CPU ceiling, shown when none is set (v1 server/load.js) */
const FALLBACK_CEILING = 200;

export function gaugesOf(data: MachineData, t: T): GaugeProps[] {
  const m = data.snap();
  const now = data.now();
  if (!m) return [t('machine.gauge.memory'), t('machine.gauge.cpu'), t('machine.gauge.disk')].map((name) => ({ name, value: undefined }));
  const g = m.guard;
  const free = m.mem.freePct;
  const used = m.mem.total && free !== null ? m.mem.total * (1 - free / 100) : null;
  const mem = sparkPoints(m.history, 'freePct', now, g.floor);
  const cpu = sparkPoints(m.history, 'cpu', now, g.ceiling);
  const disk = sparkPoints(m.history, 'worktreeBytes', now);
  return [
    {
      name: t('machine.gauge.memory'),
      value: t('machine.gauge.memoryValue', { pct: pctText(free) }),
      sub: used !== null ? t('machine.gauge.memoryUsed', { used: size(used), total: size(m.mem.total) }) : '',
      foot: g.floor !== null ? t('machine.gauge.floor', { n: g.floor }) : t('machine.gauge.noFloor'),
      tone: memTone(free, g.floor),
      points: mem?.points ?? [],
      mark: mem?.mark ?? null,
      part: 'machine.gauge.memory',
    },
    {
      name: t('machine.gauge.cpu'),
      value: pctText(m.cpu.pct),
      sub: m.cpu.cores ? t('machine.gauge.cores', { count: m.cpu.cores }) : '',
      foot: g.ceiling !== null ? t('machine.gauge.ceiling', { n: g.ceiling ?? FALLBACK_CEILING }) : t('machine.gauge.noCeiling'),
      tone: g.ceiling !== null && (m.cpu.pct ?? 0) > g.ceiling ? 'warn' : 'neutral',
      points: cpu?.points ?? [],
      mark: cpu?.mark ?? null,
      part: 'machine.gauge.cpu',
    },
    {
      name: t('machine.gauge.disk'),
      value: t('machine.gauge.diskValue', { free: size(m.disk.free) || '—' }),
      sub: m.disk.worktrees !== null ? t('machine.gauge.worktrees', { size: size(m.disk.worktrees) }) : '',
      foot: m.disk.reclaimable ? t('machine.gauge.canGo', { size: size(m.disk.reclaimable) }) : '',
      points: disk?.points ?? [],
      part: 'machine.gauge.disk',
    },
  ];
}

interface Ask {
  readonly title: string;
  readonly body: string;
  readonly ok: string;
  readonly run: () => void;
}

export function MachinePane(props: { readonly client: PluginClient; readonly peer?: PeerId }): JSX.Element {
  const t = props.client.t;
  const host = useHost(props.client);
  const data = useMachineData(props.client, props.peer ?? props.client.home, host.now);
  const [ask, setAsk] = createSignal<Ask | undefined>();
  const gauges = createMemo(() => gaugesOf(data, t));
  const failed = (): boolean => data.status().kind === 'unreachable';
  const shared = { client: props.client, host, data, confirm: setAsk };
  return (
    <Stack gap="8" part="machine.pane">
      <Inline gap="4" justify="between" part="machine.top">
        <Text size="sm" tone="muted" numeric part="machine.at">
          {updatedLine(data.snap()?.at, data.now(), failed(), t)}
        </Text>
        <ExtensionSlot input="machine.head" part="machine.head" extensions={[]} />
      </Inline>
      <Gauges items={gauges()} part="machine.gauges" />
      <Using {...shared} />
      <LeftBehind {...shared} />
      <FreeUp {...shared} review={(filter) => openSettings(host.navigate, 'worktrees', filter)} />
      <HarnessData {...shared} review={(filter) => openSettings(host.navigate, 'worktrees', filter)} />
      <Automations client={props.client} host={host} data={data} limits={() => openSettings(host.navigate, 'usage', 'machine')} />
      <Day client={props.client} data={data} />
      <Show when={ask()}>
        {(a) => (
          <Dialog
            open
            role="alertdialog"
            size="sm"
            title={a().title}
            description={a().body}
            onOpenChange={(open) => !open && setAsk(undefined)}
            footer={
              <Inline gap="4" justify="end">
                <Button variant="ghost" onClick={() => setAsk(undefined)}>
                  {t('machine.ask.cancel')}
                </Button>
                <Button
                  variant="primary"
                  tone="bad"
                  onClick={() => {
                    a().run();
                    setAsk(undefined);
                  }}
                >
                  {a().ok}
                </Button>
              </Inline>
            }
          />
        )}
      </Show>
    </Stack>
  );
}

export default MachinePane;
