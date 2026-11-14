// Usage (v1 features/usage.js, Settings → Usage → Open usage): spend and outcomes over 7, 30 or 90 days. The four
// tiles with what each counts, spend per day (turns per day when no harness reports a price: one measure per
// chart), then by project and by harness · model. Codex, Cursor, Antigravity and Copilot report no price, so a note
// says why some turns aren't in spend.
import { createResource, createSignal, Show, type JSX } from 'solid-js';
import type { PluginClient } from '@wisp/client';
import { useShell } from '@wisp/shell';
import { DataTable, DayBars, SettingsNote, Stack, Stats, Tabs, Text, useSignal } from '@wisp/ui';
import { usage, type Usage, type UsageRow } from './commands.ts';
import { t } from './i18n.ts';

const money = (n: number): string => `$${n.toFixed(2)}`;
const pct = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : `${Math.round(n)}%`);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
/** "Nov 12" of a `YYYY-MM-DD` */
const day = (d: string): string => `${MONTHS[Number(d.slice(5, 7)) - 1] ?? ''} ${Number(d.slice(8, 10))}`;
/** "2m 05s", "41s" (v1 fmtDuration) */
const dur = (ms: number | null): string => {
  if (ms === null) return '—';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};

/** The chart from one answer: pure, so a test reads it. */
export function usageModel(u: Usage): { byCost: boolean; bars: { key: string; share: number; tip: string }[]; max: string; first: string; unpriced: number } {
  const byCost = (u.priced ?? 0) > 0;
  const daily = u.daily ?? [];
  const val = (d: { cost: number; turns: number }): number => (byCost ? d.cost : d.turns);
  const top = Math.max(0, ...daily.map(val)) || 1;
  return {
    byCost,
    bars: daily.map((d) => ({ key: d.date, share: val(d) / top, tip: `${day(d.date)}: ${byCost ? `${money(d.cost)} · ` : ''}${t('budget.view.turns', { count: d.turns })}` })),
    max: t('budget.view.max', { v: byCost ? money(top) : String(top) }),
    first: daily[0] ? day(daily[0].date) : '',
    unpriced: u.turns - (u.priced ?? 0),
  };
}

function Table(props: { readonly rows: readonly UsageRow[]; readonly label: (r: UsageRow) => string; readonly part: `${string}.${string}` }): JSX.Element {
  return (
    <DataTable
      part={props.part}
      columns={['', t('budget.usage.spend'), t('budget.usage.turns'), t('budget.usage.worked'), t('budget.view.asked'), t('budget.view.avg')]}
      empty={t('budget.view.nothing')}
      rows={props.rows.map((r) => ({ key: r.key, cells: [props.label(r), r.priced ? money(r.cost) : '—', String(r.turns), pct(r.worked), String(r.questions), dur(r.avgMs)] }))}
    />
  );
}

export default function UsageView(props: { readonly client: PluginClient }): JSX.Element {
  const c = props.client;
  const marks = useSignal(useShell().harnesses());
  const nameOf = (id: string): string => marks().find((m) => m.id === id)?.name ?? id;
  const [days, setDays] = createSignal(30);
  const [u] = createResource(days, (d) => c.run(usage, { peer: c.home, days: d }).catch(() => undefined));
  return (
    <Stack gap="6" part="budget.view">
      <Tabs
        variant="seg"
        part="budget.view.range"
        aria-label={t('budget.view.range')}
        value={String(days())}
        onChange={(v) => setDays(Number(v))}
        items={[7, 30, 90].map((d) => ({ value: String(d), label: t('budget.view.days', { n: d }) }))}
      />
      <Show when={u()} fallback={<Text tone="muted">{t('budget.view.adding')}</Text>}>
        {(x) => {
          const m = (): ReturnType<typeof usageModel> => usageModel(x());
          return (
            <>
              <Stats
                compact
                part="budget.view.tiles"
                items={[
                  {
                    label: t('budget.usage.spend'),
                    value: m().byCost ? money(x().spend) : '—',
                    note: m().unpriced ? t('budget.view.unpriced', { count: m().unpriced }) : t('budget.view.allPriced'),
                  },
                  { label: t('budget.usage.turns'), value: x().turns, note: t('budget.view.sessions', { count: x().sessions ?? 0 }) },
                  { label: t('budget.usage.worked'), value: pct(x().worked), note: t('budget.view.workedNote') },
                  { label: t('budget.usage.questions'), value: x().questions, note: t('budget.view.questionsNote') },
                ]}
              />
              <Stack gap="3">
                <Text weight="medium">{m().byCost ? t('budget.view.spendPerDay') : t('budget.view.turnsPerDay')}</Text>
                <DayBars
                  part="budget.view.chart"
                  label={m().byCost ? t('budget.view.spendPerDay') : t('budget.view.turnsPerDay')}
                  bars={m().bars}
                  axis={[m().first, m().max, t('budget.view.today')]}
                />
              </Stack>
              <Stack gap="3">
                <Text weight="medium">{t('budget.view.byProject')}</Text>
                <Table part="budget.view.projects" rows={x().projects ?? []} label={(r) => r.name} />
              </Stack>
              <Stack gap="3">
                <Text weight="medium">{t('budget.view.byRunner')}</Text>
                <Table part="budget.view.runners" rows={x().runners ?? []} label={(r) => `${nameOf(r.agent ?? '')} · ${r.name || t('budget.view.defaultModel')}`} />
              </Stack>
              <Show when={m().unpriced > 0}>
                <SettingsNote part="budget.view.note">{t('budget.view.unpricedNote')}</SettingsNote>
              </Show>
            </>
          );
        }}
      </Show>
    </Stack>
  );
}
