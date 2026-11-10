// The worktrees on disk (v1 .wtr-list): a filter per kind with its count, then one row per task's
// folders or leftover, biggest first. Rows keep their columns: the size sits in the fixed time
// column, the Keep pin and Remove in the actions, for every row. Past 200 rows it's a VirtualList.
import { createEffect, createMemo, createSignal, on, Show, type JSX } from 'solid-js';
import { Button, Each, IconButton, ListRow, Pill, SettingsGroup, Stack, Tabs, Text, VirtualList } from '@wisp/ui';
import { asFilter, bySize, counts, FILTERS, fmtSize, matches, statusText } from '../format.ts';
import { t } from '../i18n.ts';
import type { Entry, Filter } from '../types.ts';

const VIRTUAL_PAST = 200;

export interface ListProps {
  readonly entries: readonly Entry[];
  readonly looking: boolean;
  readonly now: number;
  readonly ago: (at: number) => string;
  readonly onOpen: (x: Entry) => void;
  readonly onKeep: (x: Entry) => void;
  readonly onRemove: (x: Entry) => void;
  /** where it starts: a v1 data-filter value another pane opened it with (This Mac's Review) */
  readonly filter?: string | undefined;
}

const tone = (x: Entry): 'warn' | 'accent' | 'neutral' => (x.status === 'dirty' ? 'warn' : x.status === 'kept' ? 'accent' : 'neutral');

function Row(props: { readonly x: Entry; readonly list: ListProps }): JSX.Element {
  const x = (): Entry => props.x;
  const meta = (): string => {
    const e = x();
    const where = e.left ? [t('worktrees.row.no-task')] : [e.project, e.branch];
    return [...where, e.used_at ? props.list.ago(e.used_at) : ''].filter(Boolean).join(' · ');
  };
  const state = (): string => statusText(x(), props.list.now);
  const kept = (): boolean => x().status === 'kept';
  const busy = (): boolean => x().status === 'busy';
  return (
    <ListRow
      part="worktrees.row"
      title={x().title}
      sub={<Text mono={x().left} size="sm" tone="muted" truncate title={meta()}>{meta()}</Text>}
      {...(x().left ? {} : { onOpen: () => props.list.onOpen(x()) })}
      pills={
        <Show when={state()}>
          <Pill tone={tone(x())} part="worktrees.row.state">{state()}</Pill>
        </Show>
      }
      time={
        <Text size="xs" tone="faint" numeric nowrap>
          {x().size === null ? '' : fmtSize(x().size ?? 0)}
        </Text>
      }
      actions={
        <>
          <IconButton
            icon="pin"
            size="sm"
            part="worktrees.row.keep"
            label={x().left ? t('worktrees.keep.left') : kept() ? t('worktrees.unkeep') : t('worktrees.keep')}
            pressed={kept()}
            disabled={x().left || busy()}
            onClick={() => props.list.onKeep(x())}
          />
          <Button size="xs" variant="ghost" tone="bad" part="worktrees.row.remove" disabled={busy() || x().status === 'checking'} onClick={() => props.list.onRemove(x())}>
            {t('worktrees.remove')}
          </Button>
        </>
      }
    />
  );
}

export function List(props: ListProps): JSX.Element {
  const [filter, setFilter] = createSignal<Filter>(asFilter(props.filter));
  createEffect(on(() => props.filter, (f) => setFilter(asFilter(f)), { defer: true }));
  const n = createMemo(() => counts(props.entries));
  const shown = createMemo(() => props.entries.filter((x) => matches(filter(), x)).sort(bySize));
  const empty = (): string => (props.looking ? t('worktrees.list.looking') : filter() === 'all' ? t('worktrees.list.none') : t('worktrees.list.none-here'));
  const row = (x: () => Entry): JSX.Element => <Row x={x()} list={props} />;
  return (
    <SettingsGroup part="worktrees.list" title={t('worktrees.list.title')}>
      <Stack gap="3" part="worktrees.list.body">
        <Tabs
          variant="pill"
          part="worktrees.filters"
          aria-label={t('worktrees.filter.label')}
          value={filter()}
          onChange={(v) => setFilter(v as Filter)}
          items={FILTERS.map((f) => ({ value: f, label: t(`worktrees.filter.${f}`), count: n()[f] }))}
        />
        <Show when={shown().length > 0} fallback={<Text as="p" size="sm" tone="muted" part="worktrees.list.empty">{empty()}</Text>}>
          <Show when={shown().length > VIRTUAL_PAST} fallback={<Each items={shown()} key={(x) => x.key}>{(x) => row(x)}</Each>}>
            <VirtualList items={shown()} key={(x) => x.key} height="sheet-max" estimate={52} aria-label={t('worktrees.list.label')}>
              {(x) => row(x)}
            </VirtualList>
          </Show>
        </Show>
      </Stack>
    </SettingsGroup>
  );
}
