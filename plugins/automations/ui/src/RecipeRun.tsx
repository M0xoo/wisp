// A recipe from the launcher (v1 automations.js runRecipe, F-comp-37): a dialog with its prompt, a field for each
// `{field}` it asks for, the project when it isn't tied to one (the launcher's pick first), and Run. Always waits for
// Run, even with nothing to fill in, so a click on a recipe never launches it outright. Run starts it
// (`automations.task.run`) and the dialog closes; a refusal keeps it open with why.
import { createMemo, createResource, createSignal, For, Show, type JSX } from 'solid-js';
import { defineCommand, type PeerId, type PluginClient } from '@wisp/client';
import { projectList } from '@wisp/shell';
import { Button, Dialog, Field, Inline, Input, Select, Stack, Text, useSignal } from '@wisp/ui';
import { t } from './i18n.ts';
import { fieldsOf } from './recipe.ts';

export const RUN_VIEW = 'automations.run';

interface Declared {
  readonly name: string;
  readonly prompt: string;
  readonly steps?: readonly string[];
  readonly project?: string;
  readonly agent?: string;
  readonly model?: string;
  readonly mode?: string;
}

const tasks = defineCommand<{ peer: PeerId }, Declared[]>({ id: 'automations.tasks', owner: (a) => a.peer, wire: () => ({}), optimistic: 'none', pending: 'the recipe' });
const start = defineCommand<{ peer: PeerId; name: string; params: Record<string, string>; project: string }, unknown>({
  id: 'automations.task.run',
  owner: (a) => a.peer,
  wire: (a) => ({ name: a.name, params: a.params, ...(a.project && { over: { project: a.project } }) }),
  optimistic: 'none',
  pending: 'Run',
});

export default function RecipeRun(props: { readonly client: PluginClient; readonly params: { name: string; project: string } }): JSX.Element {
  const c = props.client;
  const say = t as (k: string, v?: Readonly<Record<string, string | number>>) => string;
  const [list] = createResource(() => c.run(tasks, { peer: c.home }).catch(() => [] as Declared[]));
  const recipe = createMemo(() => list()?.find((r) => r.name === props.params.name));
  const fields = createMemo(() => (recipe() ? fieldsOf(recipe() as Declared) : []));
  const [values, setValues] = createSignal<Record<string, string>>({});
  const rows = useSignal(c.entities.list<unknown>('project'));
  const projects = createMemo(() => projectList(rows(), undefined));
  const [project, setProject] = createSignal(props.params.project);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const close = (): void => c.navigate({ t: 'closeOverlay', id: RUN_VIEW as never });
  const missing = (): boolean => fields().some((f) => !(values()[f] ?? '').trim());
  const run = (): void => {
    if (busy() || missing()) return;
    setBusy(true);
    setError('');
    const where = recipe()?.project ? '' : project();
    c.run(start, { peer: c.home, name: props.params.name, params: values(), project: where }).then(close, (e: unknown) => {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    });
  };
  return (
    <Dialog
      part="automations.run"
      title={props.params.name}
      open
      onOpenChange={(o) => !o && close()}
      footer={
        <Inline gap="2" justify="between">
          <Text size="xs" tone="muted">
            {recipe()?.agent ? [recipe()?.agent, recipe()?.model].filter(Boolean).join(' · ') : say('automations.run.launcher')}
          </Text>
          <Button variant="primary" size="sm" icon="enter" loading={busy()} disabled={missing() || !recipe()} onClick={run}>
            {say('automations.run.run')}
          </Button>
        </Inline>
      }
    >
      <Stack gap="4">
        <Text size="sm" tone="muted" part="automations.run.prompt">
          {recipe()?.prompt ?? ''}
        </Text>
        <For each={fields()}>
          {(f, i) => (
            <Field label={f}>
              <Input value={values()[f] ?? ''} onInput={(v) => setValues({ ...values(), [f]: v })} spellcheck={false} autofocus={i() === 0} onKeyDown={(e) => e.key === 'Enter' && !e.isComposing && run()} />
            </Field>
          )}
        </For>
        <Show when={recipe() && !recipe()?.project}>
          <Field label={say('automations.recipe.project')}>
            <Select
              aria-label={say('automations.recipe.project')}
              value={project()}
              onChange={setProject}
              items={[{ value: '', label: say('automations.run.noFolder') }, ...projects().map((p) => ({ value: p.path, label: p.name }))]}
            />
          </Field>
        </Show>
        <Show when={error()}>
          <Text size="sm" tone="bad">
            {say('automations.run.failed', { name: props.params.name, why: error() })}
          </Text>
        </Show>
      </Stack>
    </Dialog>
  );
}
