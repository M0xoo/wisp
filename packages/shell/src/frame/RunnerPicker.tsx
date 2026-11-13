// The harness · model picker (v1 runner-picker.js): the harnesses set up here, a search over every harness's models,
// the model list of the one picked, and its thinking level. A harness pick keeps the dialog open; a model pick
// closes it. Runs on what `runtime.agents` says (asked once the box shows).
import { Show, createMemo, createResource, createSignal, type JSX } from 'solid-js';
import { defineCommand } from '@wisp/client';
import { Dialog, Grid, Input, RadioGroup, Stack, Text, ThinkingSlider, useSignal } from '@wisp/ui';
import { useShell } from '../context.tsx';
import { Slot } from '../slot.tsx';
import { effortsFor, fullest, harnessesFor, modelsFor, usedPct, type AgentOffer, type PlanWindow, type Runner } from './runner.ts';

/** v1 effortLabel: "X-High", else the level capitalised */
const levelLabel = (e: string): string => (e === 'xhigh' ? 'X-High' : e.charAt(0).toUpperCase() + e.slice(1));

const agentsOf = defineCommand<{ peer: string }, AgentOffer[]>({ id: 'runtime.agents', owner: (a) => a.peer, wire: () => ({}), optimistic: 'none', pending: 'the harness list' });

const plansOf = defineCommand<{ peer: string; agent: string }, { windows: PlanWindow[] }[]>({
  id: 'budget.view',
  owner: (a) => a.peer,
  wire: (a) => ({ agent: a.agent }),
  optimistic: 'none',
  pending: 'the plan windows',
});

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
  // before you pick, how much of each plan is gone (v1 runner-picker.js usageNote): asked when the picker opens
  const [usage] = createResource(
    () => (props.open && agents() ? { peer: props.peer, ids: (agents() ?? []).filter((a) => a.available).map((a) => a.id) } : false),
    async ({ peer, ids }) =>
      new Map(await Promise.all(ids.map(async (agent) => [agent, fullest(await shell.client.commands.run(plansOf, { peer, agent }).catch(() => []))] as const))),
  );
  const usageHint = (id: string): string | undefined => {
    const w = usage()?.get(id);
    return w ? t('shell.runner.used', { label: w.label, pct: usedPct(w) }) : undefined;
  };
  const list = createMemo(() => harnessesFor(agents() ?? [], query()));
  /** a harness that's there but signed out (v1 runner-picker.js signedOut): picked, it offers its sign-in */
  const signedOut = (id: string): boolean => (agents() ?? []).some((a) => a.id === id && a.signedIn === false);
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
              options={list().map((a) => {
                const used = a.available && a.signedIn !== false ? usageHint(a.id) : undefined;
                const out = a.signedIn === false && { hint: t('shell.runner.signedOut') };
                return { value: a.id, label: a.name, logo: logoOf(a.id), ...(!a.available && !out && { disabled: true, hint: t('shell.runner.notSetUp') }), ...out, ...(used && { hint: used }) };
              })}
              value={props.value.agent}
              onChange={(agent) => props.onChange({ agent, model: '', effort: '' })}
            />
          </Show>
          <Show when={signedOut(props.value.agent)}>
            {/* v1 paintSignIn: a signed-out harness signs in right here, in place of its models (wisp.accounts) */}
            <Slot input="shell.runner:signin" id={props.value.agent} layout="stack" />
          </Show>
          <Show when={models().length > 0 && !signedOut(props.value.agent)}>
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
          {/* v1 runner-picker.js: Thinking is a slider from Default to the harness's top level */}
          <ThinkingSlider
            heading={t('shell.runner.thinking')}
            stops={['', ...efforts()]}
            value={props.value.effort}
            onChange={(effort) => props.onChange({ ...props.value, effort })}
            label={(e) => (e ? levelLabel(e) : t('shell.runner.default'))}
            hint={(e) => t(`shell.runner.hint.${e || 'default'}`)}
            aria={{ label: t('shell.runner.thinkingLevel'), valueText: (e) => t('shell.runner.thinkingIs', { level: e ? levelLabel(e) : t('shell.runner.default') }) }}
          />
        </Show>
      </Stack>
    </Dialog>
  );
}
