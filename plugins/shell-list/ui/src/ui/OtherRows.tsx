// The rows that aren't one task: a compare task's head (one launch on several harnesses, a row per
// run under it), a plan that hasn't started (Scheduled), a draft (Drafts), and a section's heading.

import { Show, type JSX } from 'solid-js';
import { Button, Dot, FoldHead, Gap, Icon, IconButton, ListRow, Stack, Text, Time, futureLabel } from '@wisp/ui';
import { computed, type EntityKey, type ExtensionId, type Json } from '@wisp/client';
import { toggleDone } from '../actions.ts';
import type { Entry, SectionId } from '../model/sections.ts';
import { freshForLater } from '../model/sections.ts';
import { colorToken, KIND, type Plan, type Row, type SessionRow } from '../types.ts';
import { follow } from './follow.ts';
import { kitT } from './say.ts';
import { useEnv } from './env.ts';
import { flatSession } from '../model/wire.ts';

type Group = Extract<Entry, { kind: 'group' }>;

/** The compare task as a whole: asking if any run asks, working while any works, done once all are. */
export function GroupRow(props: { readonly entry: Group }): JSX.Element {
  const env = useEnv();
  const t = env.shell.t;
  // the runs' own rows, so a run finishing repaints the head's count
  const live = follow(() => {
    const keys = props.entry.runs.map((r) => r.key);
    return computed(() => keys.map((k) => flatSession(env.client.entities.row<SessionRow>(KIND.session, k)())).filter((r): r is SessionRow => r !== undefined));
  });
  const first = (): SessionRow | undefined => live()[0];
  const finished = (): number => live().filter((r) => r.state === 'review' || r.state === 'done').length;
  const state = (): string =>
    live().some((r) => r.state === 'waiting') ? 'waiting' : live().some((r) => r.state === 'running') ? 'running' : live().every((r) => r.state === 'done') ? 'done' : 'review';
  const status = (): string =>
    state() === 'waiting'
      ? t('shell-list.group.asking')
      : state() === 'running'
        ? t('shell-list.group.finished', { n: finished(), of: live().length })
        : state() === 'done'
          ? t('shell-list.group.done')
          : t('shell-list.group.pick');
  const review = (): EntityKey[] => props.entry.runs.filter((r) => live().find((x) => x.id === r.s.id)?.state === 'review').map((r) => r.key);
  const compare = (e: MouseEvent): void => {
    e.stopPropagation();
    const k = props.entry.runs[0]?.key;
    if (k) env.client.navigate({ t: 'openOverlay', overlay: { kind: 'dialog', id: 'shell.compare' as never, params: { id: k } as Json } });
  };
  const markAll = (): void => {
    for (const k of review()) toggleDone(env.actions, k);
  };
  return (
    <Show when={first()}>
      {(s) => (
        <ListRow
          part="list.group"
          title={s().title}
          lead={<Dot color={colorToken(s().color)} size="md" {...(state() === 'running' ? { live: true } : {})} />}
          sub={
            <Text size="sm" tone={state() === 'waiting' ? 'warn' : 'muted'} truncate>
              {status()}
            </Text>
          }
          // v1 task-head .it-side: vs Compare, always there (the shell's Compare runs)
          pills={
            <Button variant="ghost" size="xs" mark="vs" title={t('shell-list.group.compareTitle')} part="list.group.compare" onClick={compare}>
              {t('shell-list.group.compare')}
            </Button>
          }
          time={<Time at={Math.max(...live().map((r) => r.updatedAt))} now={env.now()} t={kitT(t)} />}
          actions={
            <Show when={review().length > 0} fallback={<Gap size="sm" />}>
              <IconButton icon="done" size="sm" tone="good" label={t('shell-list.group.mark-all')} onClick={markAll} />
            </Show>
          }
          quiet={state() === 'done'}
        />
      )}
    </Show>
  );
}

const PLAN_ICON = { reminder: 'bell', draft: 'pen', task: 'clock' } as const;

/** A scheduled task or reminder that hasn't started, or a draft: it opens its plan page. */
export function PlanRow(props: { readonly plan: Row<Plan> }): JSX.Element {
  const env = useEnv();
  const t = env.shell.t;
  const open = (): void => env.client.navigate({ t: 'openView', id: 'later.plan' as ExtensionId, params: { id: props.plan.id } as Json });
  return (
    <ListRow
      part={props.plan.kind === 'draft' ? 'list.draft' : 'list.plan'}
      title={props.plan.title}
      lead={<Icon name={PLAN_ICON[props.plan.kind]} size="md" tone="muted" />}
      sub={
        <Stack gap="0">
          <Text size="sm" tone="muted" truncate>
            {props.plan.after !== undefined ? t('shell-list.plan.after', { title: props.plan.after }) : t(`shell-list.plan.${props.plan.kind}`)}
          </Text>
          <Show when={props.plan.project}>
            {(p) => (
              <Text size="xs" tone="muted" truncate>
                {p()}
              </Text>
            )}
          </Show>
        </Stack>
      }
      time={
        <Show
          when={props.plan.kind === 'draft'}
          fallback={
            <Text size="xs" tone="faint" numeric nowrap>
              {futureLabel(props.plan.at, env.now())}
            </Text>
          }
        >
          <Time at={props.plan.at} now={env.now()} t={kitT(t)} />
        </Show>
      }
      onOpen={open}
    />
  );
}

/** A section's heading: folds it, with its count, and For later's "2 new" from the crew. */
export function SectionHead(props: { readonly id: SectionId; readonly count: number; readonly open: boolean; readonly entries: readonly Entry[] }): JSX.Element {
  const env = useEnv();
  const t = env.shell.t;
  const fresh = (): number => (props.id === 'forLater' ? freshForLater(props.entries) : 0);
  return (
    <FoldHead
      part={`list.section.${props.id} section.heading`}
      title={t(`shell-list.section.${props.id}`)}
      count={props.count}
      open={props.open}
      onToggle={() => env.model.toggleSection(props.id)}
      {...(fresh() ? { badge: t('shell-list.section.new', { n: fresh() }) } : {})}
    />
  );
}
