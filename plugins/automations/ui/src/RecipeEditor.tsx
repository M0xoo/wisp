// A recipe from a task (v1 automations.js recipeForm, opened by Save as recipe… in a task's menu): its name, the
// prompt (`{version}` becomes a field when it's run), the project (any, picked when run), the mode (the launcher's
// default) and the task's harness, model and effort as they were. Create recipe saves it (`automations.task.set`) and
// opens Settings → Automations on it; Cancel keeps nothing.
import { createMemo, createSignal, Show, type JSX } from 'solid-js';
import { defineCommand, type PeerId, type PluginClient } from '@wisp/client';
import { projectList } from '@wisp/shell';
import { Button, Dialog, Field, Input, Inline, Select, Stack, Text, TextArea, useSignal } from '@wisp/ui';
import { t } from './i18n.ts';
import { recipeParams, type RecipeDraft } from './recipe.ts';

const save = defineCommand<{ peer: PeerId; draft: RecipeDraft }, unknown>({
  id: 'automations.task.set',
  owner: (a) => a.peer,
  wire: ({ draft: d }) => ({
    name: d.name.trim(),
    prompt: d.prompt,
    ...(d.project && { project: d.project }),
    ...(d.mode && { mode: d.mode }),
    ...(d.agent && { agent: d.agent }),
    ...(d.model && { model: d.model }),
    ...(d.effort && { effort: d.effort }),
  }),
  optimistic: 'none',
  pending: 'Create recipe',
});

/** the task's first turn (v1 saveAsRecipe: `s.turns[0].prompt`) */
const firstTurn = defineCommand<{ key: string; id: string }, readonly { prompt?: string }[]>({
  id: 'runtime.turns',
  owner: (a) => a.key,
  wire: (a) => ({ id: a.id, before: 1, limit: 1 }),
  optimistic: 'none',
  pending: 'the task’s first prompt',
});

export const RECIPE_VIEW = 'automations.recipe';

export default function RecipeEditor(props: { readonly client: PluginClient; readonly params: RecipeDraft }): JSX.Element {
  const c = props.client;
  const say = t as (k: string, v?: Readonly<Record<string, string | number>>) => string;
  const [name, setName] = createSignal(props.params.name);
  const [prompt, setPrompt] = createSignal(props.params.prompt);
  const from = props.params.session;
  if (from && !props.params.prompt)
    void c
      .run(firstTurn, { key: from, id: from.slice(from.indexOf(':') + 1) })
      .then((turns) => !prompt() && setPrompt(turns[0]?.prompt ?? ''))
      .catch(() => undefined);
  const [project, setProject] = createSignal(props.params.project ?? '');
  const [mode, setMode] = createSignal(props.params.mode ?? '');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const rows = useSignal(c.entities.list<unknown>('project'));
  const projects = createMemo(() => projectList(rows(), undefined));
  const params = createMemo(() => recipeParams(prompt()));
  const close = (): void => c.navigate({ t: 'closeOverlay', id: RECIPE_VIEW as never });
  const create = (): void => {
    if (!name().trim() || !prompt().trim()) {
      setError(say('automations.recipe.need'));
      return;
    }
    setBusy(true);
    setError('');
    c.run(save, { peer: c.home, draft: { ...props.params, name: name(), prompt: prompt(), project: project(), mode: mode() } }).then(
      () => {
        close();
        c.navigate({ t: 'openOverlay', overlay: { kind: 'viewer', id: 'shell-settings.sheet' as never, params: { pane: 'automations' } } });
      },
      (e: unknown) => {
        setBusy(false);
        setError(e instanceof Error ? e.message : String(e));
      },
    );
  };
  return (
    <Dialog
      part="automations.recipe"
      title={say('automations.recipe.title')}
      open
      onOpenChange={(o) => !o && close()}
      closeOnOutside={false}
      footer={
        <Inline gap="2" justify="end">
          <Button variant="ghost" size="sm" onClick={close}>
            {say('automations.recipe.cancel')}
          </Button>
          <Button variant="primary" size="sm" loading={busy()} onClick={create}>
            {say('automations.recipe.create')}
          </Button>
        </Inline>
      }
    >
      <Stack gap="4">
        <Field label={say('automations.recipe.name')}>
          <Input value={name()} onInput={setName} maxLength={60} spellcheck={false} placeholder={say('automations.recipe.namePlaceholder')} autofocus />
        </Field>
        <Field
          label={say('automations.recipe.prompt')}
          hint={
            params().length
              ? say('automations.recipe.fields', {
                  fields: params()
                    .map((p) => `{${p}}`)
                    .join(' '),
                })
              : say('automations.recipe.noFields')
          }
        >
          <TextArea value={prompt()} onInput={setPrompt} minRows={5} maxRows={12} spellcheck={false} mono />
        </Field>
        <Field label={say('automations.recipe.project')}>
          <Select
            aria-label={say('automations.recipe.project')}
            value={project()}
            onChange={setProject}
            items={[{ value: '', label: say('automations.recipe.anyProject') }, ...projects().map((p) => ({ value: p.path, label: p.name }))]}
          />
        </Field>
        <Field label={say('automations.recipe.mode')}>
          <Select
            aria-label={say('automations.recipe.mode')}
            value={mode()}
            onChange={setMode}
            items={['', 'plan', 'edits', 'auto'].map((m) => ({ value: m, label: say(`automations.recipe.mode.${m || 'default'}`) }))}
          />
        </Field>
        <Show when={props.params.agent}>
          {(a) => (
            <Text size="sm" tone="muted">
              {say('automations.recipe.runsOn', { runner: [a(), props.params.model, props.params.effort].filter(Boolean).join(' · ') })}
            </Text>
          )}
        </Show>
        <Show when={error()}>
          <Text size="sm" tone="bad">
            {error()}
          </Text>
        </Show>
      </Stack>
    </Dialog>
  );
}
