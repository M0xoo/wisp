// Harness, model, thinking level and account (v1 runner-picker.js) as one bar item. A harness pick
// applies at once with its saved model and level and leaves the picker open; a model pick commits
// and closes; the level and the account commit in place. Auto lists goals instead of models. From
// More it opens as a dialog (an overflowed item has no button to anchor a popover to).
import { createMemo, createSignal, For, Show, type JSX } from 'solid-js';
import { Dialog, Input, Popover, RadioGroup, Select, Stack, Text, type RadioOption, type ToolbarItem } from '@wisp/ui';
import { liveItem } from './pickers.tsx';
import type { Env } from '../env.ts';
import { AUTO, AUTO_GOALS, accountLabel, accountsOf, agentNote, agentOf, effortKey, effortStops, runnerParts, savedRunner, withModel, type RunnerDefaults } from '../model/runner.ts';
import type { Agent, Row, Runner } from '../types.ts';

const K = 'shell-composer.runner';

export interface RunnerPickerProps {
  readonly env: Env;
  readonly agents: readonly Row<Agent>[];
  readonly value: Runner;
  readonly onChange: (r: Runner, close: boolean) => void;
  /** New task offers Auto; a follow-up keeps a harness */
  readonly auto?: boolean;
  readonly defaults: RunnerDefaults;
}

/** The bar's words for a runner: "Opus 4.7", "Codex · GPT-5", "Default". */
export function runnerLabel(env: Env, agents: readonly Row<Agent>[], r: Runner, lead?: string): string {
  const p = runnerParts(agents, r);
  if (r.agent === AUTO) return `${env.t(`${K}.auto`)} · ${env.t(p.model ?? 'shell-composer.auto.balanced')}`;
  const model = p.model ?? env.t(`${K}.default`);
  return lead !== undefined && lead !== r.agent ? `${p.harness} · ${model}` : model;
}

function PickerBody(p: RunnerPickerProps): JSX.Element {
  const t = p.env.t;
  const [query, setQuery] = createSignal('');
  const list = createMemo(() => (p.auto ? [{ id: AUTO, name: t(`${K}.auto`) } as Row<Agent>, ...p.agents] : p.agents));
  const agent = createMemo(() => agentOf(p.agents, p.value.agent));
  const harnesses = createMemo((): RadioOption[] =>
    list().map((a) => {
      const note = agentNote(a);
      return { value: a.id, label: a.name, hint: t(note.key, note.vars), ...(a.available === false && { disabled: true }) };
    }),
  );
  const models = createMemo((): RadioOption[] => {
    const all = p.value.agent === AUTO ? AUTO_GOALS.map((g) => ({ ...g, label: t(g.label), hint: t(g.hint ?? '') })) : (agent()?.models ?? []).map((m) => ({ id: m.id, label: m.id === '' ? t(`${K}.default`) : m.label, hint: m.hint ?? '' }));
    const q = query().trim().toLowerCase();
    return all.filter((m) => !q || m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)).map((m) => ({ value: m.id, label: m.label, ...(m.hint && { hint: m.hint }) }));
  });
  const stops = createMemo(() => effortStops(agent(), p.value.model));
  const accounts = createMemo(() => accountsOf(agent()));
  const pickAgent = (id: string): void => p.onChange(savedRunner(p.agents, id, p.defaults), false);
  return (
    <Stack gap="5" part="composer.runner.body">
      <RadioGroup label={t(`${K}.harness`)} options={harnesses()} value={p.value.agent} onChange={pickAgent} />
      <Show when={(agent()?.models?.length ?? 0) > 6}>
        <Input type="search" icon="search" size="sm" value={query()} onInput={setQuery} placeholder={t(`${K}.search`, { name: agent()?.name ?? '' })} />
      </Show>
      <Show when={models().length > 0} fallback={<Text size="sm" tone="muted">{t(`${K}.no-match`)}</Text>}>
        <RadioGroup label={t(p.value.agent === AUTO ? `${K}.goal` : `${K}.model`)} options={models()} value={p.value.model} onChange={(m) => p.onChange(withModel(p.agents, p.value, m, p.defaults), true)} />
      </Show>
      <Show when={p.value.agent === AUTO}>
        <Text size="sm" tone="muted">{t(`${K}.auto-note`)}</Text>
      </Show>
      <Show when={stops().length > 0}>
        <Select
          aria-label={t(`${K}.thinking`)}
          size="sm"
          items={stops().map((e) => ({ value: e, label: t(effortKey(e)) }))}
          value={p.value.effort}
          onChange={(effort) => p.onChange({ ...p.value, effort }, false)}
        />
      </Show>
      <Show when={accounts().length > 0}>
        <Select
          aria-label={t(`${K}.account`)}
          size="sm"
          items={[{ value: '', label: t(`${K}.account-auto`) }, ...accounts().map((a) => ({ value: a.id, label: accountLabel(a), ...(a.state === 'signedOut' && { disabled: true }) }))]}
          value={p.value.account ?? ''}
          onChange={(account) => p.onChange({ ...p.value, ...(account ? { account } : { account: '' }) }, false)}
        />
        <For each={accounts().filter((a) => a.id === p.value.account && a.state && a.state !== 'ready')}>
          {(a) => <Text size="sm" tone="warn">{t(`${K}.account-${a.state === 'limit' ? 'limit' : 'out'}`, { name: accountLabel(a) })}</Text>}
        </For>
      </Show>
    </Stack>
  );
}

/** The runner as a bar item; `id` lets a compare run have one of its own. Made once per box. */
export function runnerItem(o: {
  readonly env: Env;
  readonly id?: string;
  readonly priority: number;
  readonly agents: () => readonly Row<Agent>[];
  readonly value: () => Runner;
  readonly defaults: () => RunnerDefaults;
  readonly onChange: (r: Runner) => void;
  readonly auto?: boolean;
  /** the task's harness: the label names the harness when the pick differs */
  readonly lead?: () => string | undefined;
}): { item: ToolbarItem; dialog: () => JSX.Element } {
  const t = o.env.t;
  const [open, setOpen] = createSignal(false);
  const [sheet, setSheet] = createSignal(false);
  const label = (): string => runnerLabel(o.env, o.agents(), o.value(), o.lead?.());
  const change = (r: Runner, close: boolean): void => {
    o.onChange(r);
    if (close) {
      setOpen(false);
      setSheet(false);
    }
  };
  const body = (): JSX.Element => <PickerBody env={o.env} agents={o.agents()} value={o.value()} defaults={o.defaults()} auto={o.auto === true} onChange={change} />;
  return {
    item: liveItem({
      id: o.id ?? 'runner',
      priority: o.priority,
      label,
      icon: () => 'agent',
      onSelect: () => setSheet(true),
      render: (form) => (
        <Popover
          part="composer.runner"
          placement="top-start"
          open={open()}
          onOpenChange={setOpen}
          title={t(`${K}.title`)}
          trigger={form === 'full' ? { label: label(), icon: 'agent', size: 'sm' } : { icon: 'agent', 'aria-label': `${t(`${K}.title`)}: ${label()}`, size: 'sm' }}
        >
          {body()}
        </Popover>
      ),
    }),
    dialog: () => (
      <Dialog open={sheet()} onOpenChange={setSheet} title={t(`${K}.title`)} size="sm">
        {body()}
      </Dialog>
    ),
  };
}
