// Picking the judges (v1 judges.js judgesEditor): Met when All · Majority · Any with the rule in
// words, a row per judge (its harness, model and thinking level, or a crew member's face and role),
// Add judge (a menu with your crew when you have one), the count and Clear. Controlled: every change
// goes to onChange(judges, vote), named as the server keeps them. JudgesButton opens it from the
// launcher's Done when line and from Set / Edit goal.

import { For, Show, createSignal, type JSX } from 'solid-js';
import type { PluginClient } from '@wisp/client';
import { Button, EmptyState, IconButton, Inline, Menu, Popover, RadioGroup, Select, Stack, Text, type MenuEntry } from '@wisp/ui';
import { Face } from './Faces.tsx';
import { t } from './i18n.ts';
import { isCrew, judgesLabel, named, nextHarness, ruleLine, VOTE_KEY } from './rules.ts';
import { useCrew, useHarnesses } from './task.ts';
import { MAX_JUDGES, VOTES, type HarnessJudge, type HarnessRow, type Judge, type Vote } from './types.ts';

export interface JudgesProps {
  readonly client: PluginClient;
  readonly judges: readonly Judge[];
  readonly vote: Vote;
  readonly onChange: (judges: Judge[], vote: Vote) => void;
}

const HINT: Readonly<Record<Vote, 'wisp.goal.vote.allHint' | 'wisp.goal.vote.majorityHint' | 'wisp.goal.vote.anyHint'>> = {
  all: 'wisp.goal.vote.allHint',
  majority: 'wisp.goal.vote.majorityHint',
  any: 'wisp.goal.vote.anyHint',
};

function HarnessRowEdit(props: { readonly j: HarnessJudge; readonly harnesses: readonly HarnessRow[]; readonly onChange: (j: HarnessJudge) => void }): JSX.Element {
  const h = (): HarnessRow | undefined => props.harnesses.find((x) => x.id === props.j.agent);
  const pickAgent = (agent: string): void => {
    const next = props.harnesses.find((x) => x.id === agent);
    const model = next?.model ?? next?.models[0]?.id ?? '';
    props.onChange({ agent, model, effort: next?.effort ?? next?.efforts?.[0] ?? '' });
  };
  return (
    <Inline gap="2">
      <Select aria-label={t('wisp.goal.judges.harness')} size="sm" items={props.harnesses.map((x) => ({ value: x.id, label: x.name, disabled: !x.available }))} value={props.j.agent} onChange={pickAgent} />
      <Select aria-label={t('wisp.goal.judges.model')} size="sm" items={(h()?.models ?? []).map((m) => ({ value: m.id, label: m.label }))} value={props.j.model} onChange={(model) => props.onChange({ ...props.j, model })} />
      <Show when={(h()?.efforts?.length ?? 0) > 0}>
        <Select aria-label={t('wisp.goal.judges.effort')} size="sm" items={(h()?.efforts ?? []).map((e) => ({ value: e, label: e }))} value={props.j.effort} onChange={(effort) => props.onChange({ ...props.j, effort })} />
      </Show>
    </Inline>
  );
}

// size-ok: one editor's markup, its handlers are one-liners over the same list
export function JudgesEditor(props: JudgesProps): JSX.Element {
  const crew = useCrew(props.client);
  const harnesses = useHarnesses(props.client);
  const [error, setError] = createSignal('');
  const commit = (list: readonly Judge[], vote: Vote = props.vote): void => props.onChange(named(list, crew(), harnesses()), vote);
  const crewFree = () => crew().filter((c) => !props.judges.some((j) => isCrew(j) && j.crew === c.id));
  const full = (): boolean => props.judges.length >= MAX_JUDGES;
  const addHarness = (): void => {
    const h = nextHarness(props.judges, harnesses());
    if (!h) return void setError(t('wisp.goal.judges.noHarness'));
    const model = h.model ?? h.models[0]?.id ?? '';
    commit([...props.judges, { agent: h.id, model, effort: h.effort ?? h.efforts?.[0] ?? '' }]);
  };
  const addMenu = (): MenuEntry[] => [
    { value: 'harness', label: t('wisp.goal.judges.addHarness'), icon: 'agent', hint: t('wisp.goal.judges.addHarnessHint') },
    { kind: 'group', id: 'crew', label: t('wisp.goal.judges.yourCrew'), items: crewFree().map((c) => ({ value: `crew:${c.id}`, label: c.name, icon: 'crew' as const, ...(c.role && { hint: c.role }) })) },
  ];
  const onAdd = (v: string): void => (v.startsWith('crew:') ? commit([...props.judges, { crew: v.slice(5) }]) : addHarness());
  const rule = (): string => {
    const n = props.judges.length;
    if (n < 2) return t(n ? 'wisp.goal.judges.oneDecides' : 'wisp.goal.judges.addTwo');
    const r = ruleLine(props.vote, n);
    return r ? t(r.key, r.vars) : '';
  };
  return (
    <Stack gap="3" part="goal.judgesEditor">
      <Text size="sm" tone="muted">
        {t('wisp.goal.judges.intro')}
      </Text>
      <Stack gap="1">
        <RadioGroup
          label={t('wisp.goal.metWhen')}
          orientation="horizontal"
          options={VOTES.map((v) => ({ value: v, label: t(VOTE_KEY[v]), hint: t(HINT[v]) }))}
          value={props.vote}
          disabled={props.judges.length < 2}
          onChange={(v) => commit(props.judges, v as Vote)}
        />
        <Text size="sm" tone="muted" part="goal.rule">
          {rule()}
        </Text>
      </Stack>
      <Show when={props.judges.length} fallback={<EmptyState icon="judge" title={t('wisp.goal.judges.empty')} compact />}>
        <Stack gap="2">
          <For each={props.judges}>
            {(j, i) => (
              <Inline gap="2" part="goal.judgeRow">
                <Show
                  when={isCrew(j) ? j : undefined}
                  fallback={<HarnessRowEdit j={j as HarnessJudge} harnesses={harnesses()} onChange={(next) => commit(props.judges.map((x, k) => (k === i() ? next : x)))} />}
                >
                  {(c) => {
                    const m = () => crew().find((x) => x.id === c().crew);
                    return (
                      <Inline gap="2">
                        <Face client={props.client} who={c()} size="md" />
                        <Stack gap="0">
                          <Text weight="medium" truncate>
                            {m()?.name ?? c().name ?? t('wisp.goal.crewMember')}
                          </Text>
                          <Text size="sm" tone="muted" truncate>
                            {m() ? [m()?.role, t('wisp.goal.judges.ownHarness')].filter(Boolean).join(' · ') : t('wisp.goal.judges.gone')}
                          </Text>
                        </Stack>
                      </Inline>
                    );
                  }}
                </Show>
                <IconButton icon="x" label={t('wisp.goal.judges.remove')} variant="ghost" size="sm" onClick={() => commit(props.judges.filter((_, k) => k !== i()))} />
              </Inline>
            )}
          </For>
        </Stack>
      </Show>
      <Inline gap="2" justify="between">
        <Inline gap="2">
          <Show when={crewFree().length > 0} fallback={<Button variant="ghost" size="sm" icon="plus" disabled={full()} onClick={addHarness}>{t('wisp.goal.judges.add')}</Button>}>
            <Menu trigger={{ label: t('wisp.goal.judges.add'), icon: 'plus', variant: 'ghost', size: 'sm' }} items={addMenu()} onSelect={onAdd} />
          </Show>
          <Text size="sm" tone="muted" numeric nowrap>
            {t('wisp.goal.judges.count', { n: props.judges.length, max: MAX_JUDGES })}
          </Text>
        </Inline>
        <Show when={props.judges.length}>
          <Button variant="ghost" size="xs" onClick={() => commit([])}>
            {t('wisp.goal.judges.clear')}
          </Button>
        </Show>
      </Inline>
      <Show when={error()}>
        <Text size="sm" tone="bad">
          {error()}
        </Text>
      </Show>
    </Stack>
  );
}

/** The button: "Judges", "1 judge" or "3 judges · All", opening the editor in a popover. */
export function JudgesButton(props: JudgesProps & { readonly part?: `${string}.${string}`; readonly compact?: boolean }): JSX.Element {
  const label = (): string => {
    const w = judgesLabel(props.judges.length, props.vote);
    return t(w.key, w.vars);
  };
  return (
    <Popover
      part={props.part ?? 'goal.judgesButton'}
      title={t('wisp.goal.judges')}
      trigger={props.compact ? { icon: 'judge', 'aria-label': label(), variant: 'ghost', size: 'sm' } : { icon: 'judge', label: label(), variant: props.judges.length ? 'secondary' : 'ghost', size: 'sm' }}
      placement="bottom-end"
    >
      <JudgesEditor client={props.client} judges={props.judges} vote={props.vote} onChange={props.onChange} />
    </Popover>
  );
}
