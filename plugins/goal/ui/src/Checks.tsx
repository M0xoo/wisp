// A goal's checks (v1 judges.js checksPopover): each judge's vote at the last check and why, then
// Earlier rounds, a row per round with a face per judge. Every row with a record opens that check's
// page; one without (an old goal, a judge that never ran) isn't a link. During a check the rows say
// Checking, and open the run once it has started (After the project's tests until then).

import { For, Show, type JSX } from 'solid-js';
import type { EntityKey, PluginClient } from '@wisp/client';
import { Divider, EmptyState, Icon, Inline, ListRow, Pill, Stack, Text } from '@wisp/ui';
import { openRun } from './actions.ts';
import { Face } from './Faces.tsx';
import { t } from './i18n.ts';
import { earlierRounds, judgeLabel, lastVotes, ruleLine, SAID_KEY, VOTE_TONE } from './rules.ts';
import { useCrew, useHarnesses, useTask } from './task.ts';
import type { CheckView, GoalView, Judge, RunHint, Verdict } from './types.ts';

export interface ChecksParams {
  readonly task: string;
}

export function parseChecks(p: unknown): ChecksParams {
  const o = p as { task?: unknown } | null;
  if (!o || typeof o.task !== 'string' || !o.task.includes(':')) throw new Error('goal checks: task key');
  return { task: o.task };
}

function Said(props: { readonly verdict: Verdict | undefined; readonly checking?: boolean }): JSX.Element {
  return (
    <Show when={!props.checking} fallback={<Pill tone="accent" dot live>{t('wisp.goal.checks.checking')}</Pill>}>
      <Show when={props.verdict} fallback={<Text tone="faint">–</Text>}>
        {(v) => <Pill tone={VOTE_TONE[v()]}>{t(SAID_KEY[v()])}</Pill>}
      </Show>
    </Show>
  );
}

function JudgeRows(props: { readonly client: PluginClient; readonly task: string; readonly goal: GoalView }): JSX.Element {
  const crew = useCrew(props.client);
  const harnesses = useHarnesses(props.client);
  const checking = (): boolean => props.goal.status === 'checking';
  const last = (): CheckView | undefined => props.goal.checks.at(-1);
  const hintFor = (j: Judge, i: number): RunHint | undefined => {
    const name = j.name ?? judgeLabel(j, crew(), harnesses());
    const who = 'crew' in j ? { crew: j.crew } : { agent: j.agent, model: j.model };
    if (checking()) {
      const r = props.goal.running?.find((x) => x.name === name);
      return r ? { task: props.task, run: r.run, name, round: props.goal.round, live: true, ...who } : undefined;
    }
    const v = lastVotes(props.goal)?.[i];
    return v?.run ? { task: props.task, run: v.run, name: v.name, round: last()?.round ?? props.goal.round, verdict: v.verdict, why: v.why, ...who } : undefined;
  };
  return (
    <For each={props.goal.judges ?? []}>
      {(j, i) => {
        const v = () => (checking() ? undefined : lastVotes(props.goal)?.[i()]);
        const hint = (): RunHint | undefined => hintFor(j, i());
        const sub = (): string => (checking() ? t(hint() ? 'wisp.goal.checks.now' : 'wisp.goal.checks.afterTests') : (v()?.why ?? t('wisp.goal.checks.nextRound')));
        return (
          <ListRow
            part="goal.checkRow"
            title={j.name ?? judgeLabel(j, crew(), harnesses())}
            sub={<Text size="sm" tone="muted" truncate>{sub()}</Text>}
            lead={<Face client={props.client} who={j} verdict={v()?.verdict} size="md" />}
            pills={<Said verdict={v()?.verdict} checking={checking()} />}
            {...(hint() && { onOpen: () => openRun(props.client, hint() as RunHint) })}
          />
        );
      }}
    </For>
  );
}

function OwnLive(props: { readonly client: PluginClient; readonly task: string; readonly goal: GoalView }): JSX.Element {
  const r = (): RunHint | undefined => {
    const run = props.goal.running?.[0];
    return run ? { task: props.task, run: run.run, name: t('wisp.goal.ownCheck'), round: props.goal.round, live: true } : undefined;
  };
  return (
    <ListRow
      part="goal.checkRow"
      title={t('wisp.goal.round', { round: props.goal.round })}
      sub={<Text size="sm" tone="muted">{t(r() ? 'wisp.goal.checks.now' : 'wisp.goal.checks.afterTests')}</Text>}
      lead={<Icon name="target" />}
      pills={<Said verdict={undefined} checking />}
      {...(r() && { onOpen: () => openRun(props.client, r() as RunHint) })}
    />
  );
}

function RoundRow(props: { readonly client: PluginClient; readonly task: string; readonly c: CheckView }): JSX.Element {
  const votes = (): readonly NonNullable<CheckView['votes']>[number][] => props.c.votes ?? [];
  const own = (): RunHint | undefined => (props.c.run ? { task: props.task, run: props.c.run, name: t('wisp.goal.ownCheck'), round: props.c.round, verdict: props.c.verdict, why: props.c.why, ...(props.c.next && { next: props.c.next }) } : undefined);
  const faces = (): JSX.Element => (
    <Inline gap="1">
      <For each={votes()}>{(v) => <Face client={props.client} who={v} verdict={v.verdict} tip={`${v.name}: ${t(SAID_KEY[v.verdict])}`} />}</For>
    </Inline>
  );
  // with votes, each face is the way in: the row opens the first judge's record that has one
  const open = (): RunHint | undefined => {
    const v = votes().find((x) => x.run);
    return votes().length ? (v?.run ? { task: props.task, run: v.run, name: v.name, round: props.c.round, verdict: v.verdict, why: v.why, ...(v.crew ? { crew: v.crew } : v.agent ? { agent: v.agent } : {}) } : undefined) : own();
  };
  return (
    <ListRow
      part="goal.roundRow"
      title={t('wisp.goal.round', { round: props.c.round })}
      sub={<Show when={votes().length} fallback={<Text size="sm" tone="muted" truncate>{props.c.why}</Text>}>{faces()}</Show>}
      pills={<Said verdict={props.c.verdict} />}
      {...(open() && { onOpen: () => openRun(props.client, open() as RunHint) })}
    />
  );
}

export default function Checks(props: { readonly client: PluginClient; readonly params: ChecksParams }): JSX.Element {
  const row = useTask(props.client, () => props.params.task as EntityKey);
  return (
    <Show when={row()?.goal} fallback={<EmptyState icon="target" title={t('wisp.goal.notChecked')} compact />}>
      {(g) => {
        const n = (): number => g().judges?.length ?? 0;
        const rule = (): string => {
          const r = ruleLine(g().vote, n());
          return r ? t(r.key, r.vars) : t('wisp.goal.checks.own');
        };
        const rounds = (): CheckView[] => earlierRounds(g());
        return (
          <Stack gap="3" part="goal.checks">
            <Text tone="muted" size="sm">
              {rule()}
            </Text>
            <Show when={n() > 0} fallback={<Show when={g().status === 'checking'}><OwnLive client={props.client} task={props.params.task} goal={g()} /></Show>}>
              <Stack gap="1">
                <JudgeRows client={props.client} task={props.params.task} goal={g()} />
              </Stack>
            </Show>
            <Show when={rounds().length}>
              <Show when={n() > 0}>
                <Divider />
                <Text size="sm" weight="medium" tone="muted">
                  {t('wisp.goal.checks.earlier')}
                </Text>
              </Show>
              <Stack gap="1">
                <For each={rounds()}>{(c) => <RoundRow client={props.client} task={props.params.task} c={c} />}</For>
              </Stack>
            </Show>
          </Stack>
        );
      }}
    </Show>
  );
}
