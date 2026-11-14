// The goal band on top of the open task (v1 goal.js bandHtml, design/goals.md): two fixed rows so a
// round starting or a check landing never moves what's under it. First the mark, Done when, the
// condition on one line, the state and a menu; then the progress (the last check's estimate and its
// change), the judges' faces with the tally, the round, and the last check in the checker's words,
// which opens the checks. Paused: Resume goal right there.

import { Show, createMemo, type JSX } from 'solid-js';
import type { ExtensionProps } from '@wisp/shell/contract';
import { Box, Button, Icon, Inline, Menu, Pill, Stack, Text, Tooltip, futureLabel } from '@wisp/ui';
import type { EntityKey } from '@wisp/client';
import { ACTION_ICON, actionLabel, openChecks, runGoalAction } from './actions.ts';
import { Faces } from './Faces.tsx';
import { t } from './i18n.ts';
import { checkLine, goalActions, goalLive, hasChecks, lastVotes, progressDelta, ruleLine, SAID_KEY, shownProgress, stateWords, tally, type GoalAction } from './rules.ts';
import { keyOf, useTask } from './task.ts';
import type { GoalView } from './types.ts';

const TONE = { working: 'accent', checking: 'accent', met: 'good', impossible: 'bad', out: 'warn', paused: 'warn', handed: 'neutral' } as const;

function history(g: GoalView): string {
  if (!g.checks.length) return t('wisp.goal.notChecked');
  return g.checks
    .map((c) => (c.progress != null ? t('wisp.goal.history.progress', { round: c.round, said: t(SAID_KEY[c.verdict]), p: c.progress }) : t('wisp.goal.history', { round: c.round, said: t(SAID_KEY[c.verdict]) })))
    .join('\n');
}

function Progress(props: { readonly goal: GoalView }): JSX.Element {
  const p = (): number | null => shownProgress(props.goal);
  const delta = (): number | null => progressDelta(props.goal);
  const label = (): string => {
    const d = delta();
    const base = p() == null ? '–' : `${p()}%`;
    return d ? `${base} ${d > 0 ? '+' : '−'}${Math.abs(d)}` : base;
  };
  return (
    <Tooltip content={history(props.goal)}>
      <Pill part="goal.track" tone={props.goal.status === 'met' ? 'good' : 'neutral'} variant="outline">
        {label()}
      </Pill>
    </Tooltip>
  );
}

function JudgeVotes(props: { readonly client: ExtensionProps['client']; readonly goal: GoalView }): JSX.Element {
  const votes = (): ReturnType<typeof lastVotes> => lastVotes(props.goal);
  const n = (): number => props.goal.judges?.length ?? 0;
  const rule = (): string => {
    const r = ruleLine(props.goal.vote, n());
    return r ? t(r.key, r.vars) : '';
  };
  const tip = (i: number): string => {
    const v = votes()?.[i];
    return v ? `${v.name}: ${t(SAID_KEY[v.verdict])}${v.why ? ` · ${v.why}` : ''}` : rule();
  };
  return (
    <Inline gap="1">
      <Faces client={props.client} judges={props.goal.judges ?? []} votes={votes()} tip={tip} />
      <Text size="sm" numeric tone="muted" nowrap>
        {tally(props.goal)}
      </Text>
    </Inline>
  );
}

function CheckLineButton(props: { readonly client: ExtensionProps['client']; readonly task: EntityKey; readonly goal: GoalView; readonly now: number }): JSX.Element {
  const line = createMemo(() => checkLine(props.goal));
  const text = (): string => {
    const l = line();
    const lead = t(l.lead.key, { ...l.lead.vars, ...(l.at !== undefined && { when: futureLabel(l.at, props.now) }) });
    const tail = [l.text, l.next && t('wisp.goal.line.next', { next: l.next })].filter(Boolean).join(' · ');
    return tail ? `${lead} · ${tail}` : lead;
  };
  return (
    <Show when={hasChecks(props.goal)} fallback={<Text part="goal.check" size="sm" tone="muted" truncate title={text()}>{text()}</Text>}>
      <Button part="goal.check" variant="ghost" size="xs" haspopup="dialog" title={text()} onClick={() => openChecks(props.client, props.task)}>
        {text()}
      </Button>
    </Show>
  );
}

export default function Band(props: ExtensionProps): JSX.Element {
  const key = (): EntityKey | undefined => {
    const s = props.session?.();
    return s ? keyOf(props.client, s.id) : undefined;
  };
  const row = useTask(props.client, key);
  const now = (): number => props.client.scope.timers.now();
  const items = (): { value: GoalAction; label: string; icon: (typeof ACTION_ICON)[GoalAction] }[] => goalActions(row()).map((a) => ({ value: a, label: t(actionLabel(a, row())), icon: ACTION_ICON[a] }));
  return (
    <Show when={row()?.goal && key()}>
      {(task) => {
        const g = (): GoalView => row()?.goal as GoalView;
        const paused = (): boolean => g().status === 'paused' || g().status === 'out';
        const state = (): string => t(stateWords(g()).key);
        return (
          <Box as="section" part="goal.band" pad="3" radius="md" border="line" surface="surface" aria-label={t('wisp.goal.band')}>
            <Stack gap="2">
              <Inline gap="2" align="center">
                <Icon name={g().status === 'met' ? 'check' : 'target'} size="sm" />
                <Text size="sm" tone="muted" nowrap>
                  {t('wisp.goal.doneWhen')}
                </Text>
                <Box grow>
                  <Text part="goal.text" weight="medium" truncate title={g().text}>
                    {g().text}
                  </Text>
                </Box>
                <Pill tone={TONE[g().status]} dot={goalLive(g())}>
                  {state()}
                </Pill>
                <Menu trigger={{ icon: 'dots', 'aria-label': t('wisp.goal.actions'), variant: 'ghost', size: 'xs' }} items={items()} onSelect={(v) => runGoalAction(props.client, v as GoalAction, task())} placement="bottom-end" />
              </Inline>
              <Inline gap="2" align="center">
                <Progress goal={g()} />
                <Show when={(g().judges?.length ?? 0) > 0}>
                  <JudgeVotes client={props.client} goal={g()} />
                </Show>
                <Show when={goalLive(g())}>
                  <Text size="sm" tone="muted" numeric nowrap>
                    {t('wisp.goal.round', { round: g().round })}
                  </Text>
                </Show>
                <Box grow>
                  <CheckLineButton client={props.client} task={task()} goal={g()} now={now()} />
                </Box>
                <Show when={paused()}>
                  <Button part="goal.resume" variant="ghost" size="xs" icon="play" onClick={() => runGoalAction(props.client, 'resume', task())}>
                    {t('wisp.goal.action.resume')}
                  </Button>
                </Show>
              </Inline>
            </Stack>
          </Box>
        );
      }}
    </Show>
  );
}
