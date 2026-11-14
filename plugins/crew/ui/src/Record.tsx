// Track record (v1 crew-record.js): one dialog, a subject picker (a member, or the whole crew) and the range (7, 30
// or 90 days, crew.stats). The crew's view ranks members: jobs, finished, failed, check-ins that found nothing to do,
// tokens, spend, and the jobs the range before. A member's view (⋯ → Track record…) leads with the tokens its jobs
// used, then where they went by kind of job, its biggest jobs (each opens), and how its jobs went in one line.
import { createMemo, createResource, createSignal, For, Show, type JSX } from 'solid-js';
import { defineCommand, type PeerId, type PluginClient } from '@wisp/client';
import { useShell } from '@wisp/shell';
import { DataTable, Inline, ListRow, PlanAccount, Select, Stack, Tabs, Text, useSignal } from '@wisp/ui';
import { crewData } from './data.ts';
import { t } from './i18n.ts';
import { toks } from './more/record-logic.ts';
import { crewLimits, memberLimits, memberRecord, type LimitRow, type MemberStats, type Say } from './record-view.ts';

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
        s.tokens ? toks(s.tokens) : '—',
        s.cost === undefined ? '—' : `$${s.cost.toFixed(2)}`,
        s.before === undefined ? '—' : String(s.before),
      ],
    }));
}

const CREW = '';

// v1 whenAt: "Tue 14:05"
const whenFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const when = (at: number): string => whenFmt.format(at);

/** *What ate your limits*: the plan windows these jobs took part of, a block per harness and account; nothing when
 * none did (or budget is off). */
function Limits(props: { readonly rows: readonly LimitRow[] }): JSX.Element {
  const harnesses = useSignal(useShell().harnesses());
  const nameOf = (id: string): string => harnesses().find((h) => h.id === id)?.name ?? id;
  const groups = createMemo(() => {
    const by = new Map<string, LimitRow[]>();
    for (const r of props.rows) by.set(`${r.agent}@${r.account}`, [...(by.get(`${r.agent}@${r.account}`) ?? []), r]);
    return [...by.values()];
  });
  return (
    <Show when={props.rows.length}>
      <Stack gap="2" part="crew.record.limits">
        <Text size="sm" tone="muted" title={t('wisp.crew.record.limitsTip')}>
          {t('wisp.crew.record.limits')}
        </Text>
        <For each={groups()}>
          {(g) => (
            <PlanAccount
              part="crew.record.limit"
              name={nameOf(g[0]?.agent ?? '')}
              logo={harnesses().find((h) => h.id === g[0]?.agent)?.logo}
              account={g[0]?.account || undefined}
              windows={g}
            />
          )}
        </For>
      </Stack>
    </Show>
  );
}

export default function Record(props: { readonly client: PluginClient; readonly params?: unknown }): JSX.Element {
  const c = props.client;
  const say = t as unknown as Say;
  const data = crewData(c);
  const members = useSignal(data.members);
  const nameOf = (id: string): string => members().find((m) => m.id === id)?.name ?? id;
  const [who, setWho] = createSignal<string>(((props.params as { id?: unknown } | null)?.id as string | undefined) ?? CREW);
  const [days, setDays] = createSignal(30);
  const [list] = createResource(days, (d) => c.run(stats, { peer: c.home, days: d }).catch(() => undefined));
  const rows = createMemo(() => recordRows(list() ?? [], nameOf));
  const mine = createMemo(() => memberRecord(list()?.find((s) => s.id === who()), days(), say));
  const myLimits = createMemo(() => memberLimits(list()?.find((s) => s.id === who()), nameOf(who()), say, when));
  const allLimits = createMemo(() => crewLimits(list() ?? [], nameOf, say, when));
  const open = (id: string): void => {
    const key = data.sessionKey(id);
    if (key) c.navigate({ t: 'openTask', id: key as never });
  };
  return (
    <Stack gap="6" part="crew.record">
      <Inline gap="3" align="center" justify="between">
        <Select
          part="crew.record.subject"
          aria-label={t('wisp.crew.record.subject')}
          size="sm"
          value={who()}
          onChange={setWho}
          items={[{ value: CREW, label: t('wisp.crew.record.everyone') }, ...members().map((m) => ({ value: m.id, label: m.name }))]}
        />
        <Tabs
          variant="seg"
          part="crew.record.range"
          aria-label={t('wisp.crew.record.range')}
          value={String(days())}
          onChange={(v) => setDays(Number(v))}
          items={[7, 30, 90].map((d) => ({ value: String(d), label: t('wisp.crew.record.days', { n: d }) }))}
        />
      </Inline>
      <Show when={list()} fallback={<Text tone="muted">{t('wisp.crew.record.adding')}</Text>}>
        <Show
          when={who() !== CREW}
          fallback={
            <Stack gap="4">
              <Limits rows={allLimits()} />
              <DataTable
                part="crew.compare"
                columns={[
                  t('wisp.crew.record.member'),
                  t('wisp.crew.record.jobs'),
                  t('wisp.crew.record.finished'),
                  t('wisp.crew.record.failed'),
                  t('wisp.crew.record.quiet'),
                  t('wisp.crew.record.tokens'),
                  t('wisp.crew.record.spend'),
                  t('wisp.crew.record.before'),
                ]}
                empty={t('wisp.crew.record.none')}
                rows={rows()}
              />
            </Stack>
          }
        >
          <Stack gap="4">
            <Limits rows={myLimits()} />
            <Show when={!mine().empty} fallback={<Text tone="muted">{say('wisp.crew.record.noneFor', { name: nameOf(who()) })}</Text>}>
              <Stack gap="4" part="crew.record.member">
                <Text weight="semibold">{mine().head}</Text>
                <Stack gap="1">
                  <Text size="sm" tone="muted">{t('wisp.crew.record.where')}</Text>
                  <For each={mine().kinds}>
                    {(k) => (
                      <Text size="sm">
                        {`${k.label} · ${k.pct}% · ${k.line}`}
                      </Text>
                    )}
                  </For>
                </Stack>
                <Show when={mine().top.length}>
                  <Stack gap="1">
                    <Text size="sm" tone="muted">{t('wisp.crew.record.biggest')}</Text>
                    <For each={mine().top}>
                      {(j) => (
                        <ListRow
                          part="crew.record.job"
                          title={j.title}
                          quiet
                          time={
                            <Text size="sm" tone="muted" numeric nowrap>
                              {`${j.tokens} · ${j.pct}%`}
                            </Text>
                          }
                          onOpen={() => open(j.id)}
                        />
                      )}
                    </For>
                  </Stack>
                </Show>
                <Text size="sm" tone="muted">{mine().outcome}</Text>
              </Stack>
            </Show>
          </Stack>
        </Show>
      </Show>
    </Stack>
  );
}
