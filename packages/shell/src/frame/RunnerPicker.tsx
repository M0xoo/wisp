// The harness · model picker (v1 runner-picker.js): the harnesses set up here, a search over every harness's models,
// the model list of the one picked, and its thinking level. A harness pick keeps the dialog open; a model pick
// closes it. Runs on what `runtime.agents` says (asked once the box shows).
import { Show, createMemo, createResource, createSignal, type JSX } from 'solid-js';
import { defineCommand } from '@wisp/client';
import { Dialog, Grid, Input, RadioGroup, Select, Stack, Text, useSignal } from '@wisp/ui';
import { useShell } from '../context.tsx';
import { effortsFor, harnessesFor, modelsFor, type AgentOffer, type Runner } from './runner.ts';

const agentsOf = defineCommand<{ peer: string }, AgentOffer[]>({ id: 'runtime.agents', owner: (a) => a.peer, wire: () => ({}), optimistic: 'none', pending: 'the harness list' });

export function RunnerPicker(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly peer: string;
  readonly value: Runner;
  readonly onChange: (r: Runner) => void;
  /** false: what it's for has no thinking level (a trigger) */ readonly efforts?: boolean;
}): JSX.Element {
  const shell = useShell();
  const t = shell.t;
  const harnesses = useSignal(shell.harnesses());
  /** each harness's logo, as its plugin registered it */
  const logoOf = (id: string): string | undefined => harnesses().find((h) => h.id === id)?.logo;
  const [query, setQuery] = createSignal('');
  // asked when New task shows, not when the picker opens: detecting the harnesses takes seconds
  const [agents] = createResource(
    () => props.peer,
    (peer) => shell.client.commands.run(agentsOf, { peer }).catch(() => [] as AgentOffer[]),
  );
  const list = createMemo(() => harnessesFor(agents() ?? [], query()));
  const models = createMemo(() => modelsFor(agents() ?? [], props.value.agent, query()));
  const efforts = createMemo(() => (props.efforts === false ? [] : effortsFor(agents() ?? [], props.value)));
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange} title={t('shell.runner.title')} size="md" part="shell.runner">
      <Stack gap="5" part="shell.runner.body">
        <Input type="search" icon="search" size="sm" value={query()} onInput={setQuery} placeholder={t('shell.runner.search')} aria-label={t('shell.runner.search')} />
        <Grid columns={2} gap="6" part="shell.runner.cols">
          <Show
            when={list().length > 0}
            fallback={
              <Text size="sm" tone="muted">
                {agents.loading ? t('shell.runner.loading') : t('shell.runner.none')}
              </Text>
            }
          >
            <RadioGroup
              label={t('shell.runner.harness')}
              options={list().map((a) => ({ value: a.id, label: a.name, logo: logoOf(a.id), ...(!a.available && { disabled: true, hint: t('shell.runner.notSetUp') }) }))}
              value={props.value.agent}
              onChange={(agent) => props.onChange({ agent, model: '', effort: '' })}
            />
          </Show>
          <Show when={models().length > 0}>
            <RadioGroup
              label={t('shell.runner.model')}
              options={models().map((m) => ({ value: m.id, label: m.id === '' ? t('shell.runner.default') : m.label, ...(m.hint && { hint: m.hint }) }))}
              value={props.value.model}
              onChange={(model) => {
                props.onChange({ ...props.value, model });
                props.onOpenChange(false);
              }}
            />
          </Show>
        </Grid>
        <Show when={efforts().length > 0}>
          <Text size="sm" weight="medium">
            {t('shell.runner.thinking')}
          </Text>
          <Select
            aria-label={t('shell.runner.thinking')}
            size="sm"
            items={[{ value: '', label: t('shell.runner.default') }, ...efforts().map((e) => ({ value: e, label: e }))]}
            value={props.value.effort}
            onChange={(effort) => props.onChange({ ...props.value, effort })}
          />
        </Show>
      </Stack>
    </Dialog>
  );
}
