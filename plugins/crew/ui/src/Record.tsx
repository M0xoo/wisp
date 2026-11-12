// Crew track record (v1 crew-record.js, the crew's view): how each member did over 7, 30 or 90 days (crew.stats):
// jobs, finished, failed, check-ins that found nothing to do, spend, and the jobs the range before, most jobs
// first. A member's own view (plan limits, tokens per day, its biggest jobs) is not here yet.
import { createMemo, createResource, createSignal, Show, type JSX } from 'solid-js';
import { defineCommand, type PeerId, type PluginClient } from '@wisp/client';
import { DataTable, Stack, Tabs, Text, useSignal } from '@wisp/ui';
import { crewData } from './data.ts';
import { t } from './i18n.ts';

interface MemberStats {
  readonly id: string;
  readonly jobs: number;
  readonly done: number;
  readonly failed: number;
  readonly quiet: number;
  readonly before?: number;
  readonly cost?: number;
}

const stats = defineCommand<{ peer: PeerId; days: number }, MemberStats[]>({
  id: 'crew.stats',
  owner: (a) => a.peer,
  wire: (a) => ({ days: a.days }),
  optimistic: 'none',
  pending: 'the track record',
});

/** The rows, most jobs first; a member with none still shows (it did nothing, which is worth seeing). */
export function recordRows(list: readonly MemberStats[], nameOf: (id: string) => string): { key: string; cells: string[] }[] {
  return [...list]
    .sort((a, b) => b.jobs - a.jobs || nameOf(a.id).localeCompare(nameOf(b.id)))
    .map((s) => ({
      key: s.id,
      cells: [
        nameOf(s.id),
        String(s.jobs),
        t('wisp.crew.record.of', { n: s.done, of: s.jobs }),
        String(s.failed),
        String(s.quiet),
        s.cost === undefined ? '—' : `$${s.cost.toFixed(2)}`,
        s.before === undefined ? '—' : String(s.before),
      ],
    }));
}

export default function Record(props: { readonly client: PluginClient }): JSX.Element {
  const c = props.client;
  const members = useSignal(crewData(c).members);
  const nameOf = (id: string): string => members().find((m) => m.id === id)?.name ?? id;
  const [days, setDays] = createSignal(30);
  const [list] = createResource(days, (d) => c.run(stats, { peer: c.home, days: d }).catch(() => undefined));
  const rows = createMemo(() => recordRows(list() ?? [], nameOf));
  return (
    <Stack gap="6" part="crew.record">
      <Tabs
        variant="seg"
        part="crew.record.range"
        aria-label={t('wisp.crew.record.range')}
        value={String(days())}
        onChange={(v) => setDays(Number(v))}
        items={[7, 30, 90].map((d) => ({ value: String(d), label: t('wisp.crew.record.days', { n: d }) }))}
      />
      <Show when={list()} fallback={<Text tone="muted">{t('wisp.crew.record.adding')}</Text>}>
        <DataTable
          part="crew.compare"
          columns={[
            t('wisp.crew.record.member'),
            t('wisp.crew.record.jobs'),
            t('wisp.crew.record.finished'),
            t('wisp.crew.record.failed'),
            t('wisp.crew.record.quiet'),
            t('wisp.crew.record.spend'),
            t('wisp.crew.record.before'),
          ]}
          empty={t('wisp.crew.record.none')}
          rows={rows()}
        />
      </Show>
    </Stack>
  );
}
