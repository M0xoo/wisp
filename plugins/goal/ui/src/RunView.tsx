// One goal check, read like a task (v1 goal-run.js): which judge, the round, its vote and why, at
// once from what opened it; then What wisp asked it (folded like a long prompt), what it did and What
// it saw. Laid over the open task, so Back finds the task where it was. Read-only: no reply box, band
// or Ship. Under way it grows live from the record's row on the task's topic.

import { For, Show, createSignal, onCleanup, type JSX } from 'solid-js';
import type { EntityKey, PeerId, PluginClient } from '@wisp/client';
import { Box, Button, Callout, Icon, Inline, Pill, Skeleton, Stack, Text, useSignal, type IconName } from '@wisp/ui';
import { Face } from './Faces.tsx';
import { t, type Key } from './i18n.ts';
import { SAID_KEY, VOTE_TONE } from './rules.ts';
import { bareId } from './task.ts';
import { KIND, type GoalRun, type RunHint, type RunStep } from './types.ts';

const VERDICTS = new Set(['met', 'not_yet', 'impossible', 'unchecked']);

export function parseRun(p: unknown): RunHint {
  const o = p as Partial<RunHint> | null;
  if (!o || typeof o.task !== 'string' || !o.task.includes(':') || typeof o.run !== 'string' || typeof o.name !== 'string' || typeof o.round !== 'number') throw new Error('goal run: params');
  if (o.verdict !== undefined && !VERDICTS.has(o.verdict)) throw new Error('goal run: verdict');
  return o as RunHint;
}

const END: Readonly<Record<NonNullable<GoalRun['end']>, Key>> = {
  timeout: 'wisp.goal.run.end.timeout',
  stopped: 'wisp.goal.run.end.stopped',
  error: 'wisp.goal.run.end.error',
  nojson: 'wisp.goal.run.end.nojson',
  interrupted: 'wisp.goal.run.end.interrupted',
};

const STEP_ICON: Readonly<Record<string, IconName>> = { tool: 'tool', read: 'read', edit: 'pen', bash: 'terminal', search: 'search', text: 'text', think: 'spark' };

function Head(props: { readonly client: PluginClient; readonly hint: RunHint; readonly rec: GoalRun | undefined }): JSX.Element {
  const h = (): RunHint & Partial<GoalRun> => ({ ...props.hint, ...(props.rec ?? {}) });
  const running = (): boolean => props.rec?.status === 'running' || (!props.rec && props.hint.live === true);
  const sub = (): string => [t('wisp.goal.run.round', { round: h().round }), [h().agent, h().model].filter(Boolean).join(' · ')].filter(Boolean).join(' · ');
  return (
    <Stack gap="3" part="goal.runHead">
      <Inline gap="2">
        <Button variant="ghost" size="xs" icon="back" onClick={() => props.client.navigate({ t: 'closeOverlay' })}>
          {t('wisp.goal.run.back')}
        </Button>
      </Inline>
      <Inline gap="3" align="center">
        <Show when={h().crew || h().agent} fallback={<Icon name="target" size="lg" />}>
          <Face client={props.client} who={{ name: h().name, ...(h().crew && { crew: h().crew as string }), ...(h().agent && { agent: h().agent as string }) }} size="md" />
        </Show>
        <Box grow>
          <Stack gap="0">
            <Text weight="semibold" truncate>
              {h().name}
            </Text>
            <Text size="sm" tone="muted" truncate>
              {sub()}
            </Text>
          </Stack>
        </Box>
        <Show when={!running()} fallback={<Pill part="goal.runVote" tone="accent" dot live>{t('wisp.goal.checks.checking')}</Pill>}>
          <Show when={h().verdict}>{(v) => <Pill part="goal.runVote" tone={VOTE_TONE[v()]}>{t(SAID_KEY[v()])}</Pill>}</Show>
        </Show>
      </Inline>
      <Show when={h().why}>{(why) => <Text>{why()}</Text>}</Show>
      <Show when={h().next}>
        {(next) => (
          <Text size="sm" tone="muted">
            {`${t('wisp.goal.run.next')} · ${next()}`}
          </Text>
        )}
      </Show>
      <Show when={props.rec?.end}>{(end) => <Callout tone="warn" title={t(END[end()])} />}</Show>
    </Stack>
  );
}

function Prompt(props: { readonly text: string }): JSX.Element {
  const [open, setOpen] = createSignal(false);
  return (
    <Box part="goal.runPrompt" pad="3" radius="md" surface="sunk">
      <Stack gap="2">
        <Inline gap="2" align="center">
          <Icon name="target" size="sm" />
          <Text size="sm" weight="medium">
            {t('wisp.goal.run.asked')}
          </Text>
        </Inline>
        <Show when={open()} fallback={<Text lines={3} breakAnywhere>{props.text}</Text>}>
          <Text breakAnywhere>{props.text}</Text>
        </Show>
        <Inline gap="2">
          <Button variant="ghost" size="xs" onClick={() => setOpen(!open())}>
            {t(open() ? 'wisp.goal.run.showLess' : 'wisp.goal.run.showAll')}
          </Button>
        </Inline>
      </Stack>
    </Box>
  );
}

function Steps(props: { readonly steps: readonly RunStep[] }): JSX.Element {
  return (
    <Stack gap="1" part="goal.runSteps">
      <For each={props.steps} fallback={<Text tone="muted">{t('wisp.goal.run.noSteps')}</Text>}>
        {(s) => (
          <Inline gap="2" align="start">
            <Icon name={STEP_ICON[s.kind] ?? 'dots'} size="sm" />
            <Text size="sm" lines={s.kind === 'text' ? 3 : 2} breakAnywhere>
              {s.label ?? s.text ?? s.detail ?? s.kind}
            </Text>
          </Inline>
        )}
      </For>
    </Stack>
  );
}

function Skeletons(): JSX.Element {
  return (
    <Stack gap="2" aria-hidden="true">
      <Skeleton width="full" />
      <Skeleton width="3/4" />
      <Skeleton width="1/2" />
    </Stack>
  );
}

export default function RunView(props: { readonly client: PluginClient; readonly params: RunHint }): JSX.Element {
  const task = props.params.task as EntityKey;
  const peer = task.slice(0, task.indexOf(':')) as PeerId;
  // the task's topic carries its check records: watched while the page is up
  const scope = props.client.scope.child('goal-run');
  props.client.watch(peer, `session:${bareId(task)}`, scope);
  onCleanup(() => scope.dispose());
  const rec = useSignal(props.client.entities.row<GoalRun>(KIND.run, `${peer}:${props.params.run}` as EntityKey));
  const record = (): GoalRun | undefined => rec() as GoalRun | undefined;
  return (
    <Stack gap="4" part="goal.run" role="region" aria-label={t('wisp.goal.run.title')}>
      <Head client={props.client} hint={props.params} rec={record()} />
      <Show when={record()} fallback={<Skeletons />}>
        {(r) => (
          <>
            <Prompt text={r().turn.prompt} />
            <Stack gap="2">
              <Text size="sm" weight="medium" tone="muted">
                {t('wisp.goal.run.steps')}
              </Text>
              <Steps steps={r().turn.activity} />
              <Show when={r().status === 'running'}>
                <Inline gap="2" align="center">
                  <Pill tone="accent" dot live>
                    {t('wisp.goal.run.isChecking', { name: r().name })}
                  </Pill>
                </Inline>
              </Show>
            </Stack>
            <Show when={r().evidence?.length}>
              <Stack gap="1" part="goal.runSaw">
                <Text size="sm" weight="medium" tone="muted">
                  {t('wisp.goal.run.saw')}
                </Text>
                <For each={r().evidence}>{(e) => <Text size="sm" mono breakAnywhere>{e}</Text>}</For>
              </Stack>
            </Show>
          </>
        )}
      </Show>
    </Stack>
  );
}
