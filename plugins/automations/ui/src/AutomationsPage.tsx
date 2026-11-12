// Automations as v1 opened it from ⌘K (features/automations.js openAutomations): Recipes and Triggers with their
// counts, each a list with "+ New …", and the trigger form v1 had (kind tiles, Name, Send to, Project, the kind's own
// rows, Run, Prompt, Mode, Harness, Cancel / Create trigger). Saved as a `trigger` resource (ADR-0043), the same
// declaration Settings → Automations, the CLI and formulas write.
import { createEffect, createMemo, createResource, createSignal, Match, onMount, Show, Switch, type JSX } from 'solid-js';
import { defineCommand, type PeerId, type PluginClient } from '@wisp/client';
import { cronWords, projectList, useShell } from '@wisp/shell';
import { AutoFoot, AutoList, AutoNote, AutoPresets, AutoRow, AutomationsBody, Input, Select, TextArea, TriggerKinds, useSignal } from '@wisp/ui';
import { recipes, triggers, type Recipe, type Trigger } from './commands.ts';
import { t } from './i18n.ts';
import { EVERY, HOOK_KINDS, KINDS, POLLED, SCHEDULE_PRESETS, TASK_KINDS, emptyForm, kindOf, pick, readBack, specOfForm, warning, type TriggerFormState } from './trigger-form.ts';

const apply = defineCommand<{ peer: PeerId; name: string; spec: Record<string, unknown> }>({
  id: 'resources.apply',
  owner: (a) => a.peer,
  wire: (a) => ({ resources: [{ kind: 'trigger', name: a.name, spec: a.spec }] }),
  optimistic: 'none',
  pending: 'Create trigger',
});

export const PAGE_VIEW = 'automations.page';

export interface PageParams {
  readonly tab: 'recipes' | 'triggers';
}

export default function AutomationsPage(props: { readonly client: PluginClient; readonly params: PageParams }): JSX.Element {
  const c = props.client;
  const shell = useShell();
  const say = t as (k: string, v?: Readonly<Record<string, string | number>>) => string;
  const [tab, setTab] = createSignal<'recipes' | 'triggers'>(props.params.tab);
  const [rs] = createResource(() => c.run(recipes, { peer: c.home }).catch((): Recipe[] => []));
  const [ts, { refetch }] = createResource(() => c.run(triggers, { peer: c.home }).catch((): Trigger[] => []));
  const [editing, setEditing] = createSignal(false);
  const openRecipe = (): void => c.navigate({ t: 'openOverlay', overlay: { kind: 'dialog', id: 'automations.recipe' as never, params: { name: '', prompt: '' } } });
  return (
    <AutomationsBody
      lede={[say('automations.page.lede1'), { code: '{name}' }, say('automations.page.lede2')]}
      tabs={[
        { value: 'recipes', label: say('automations.recipes'), count: (rs() ?? []).length },
        { value: 'triggers', label: say('automations.triggers'), count: (ts() ?? []).length },
      ]}
      tab={tab()}
      onTab={(v) => {
        setTab(v === 'triggers' ? 'triggers' : 'recipes');
        setEditing(false);
      }}
    >
      <Switch>
        <Match when={tab() === 'triggers' && editing()}>
          <TriggerForm
            client={c}
            recipes={rs() ?? []}
            here={shell.projectFilter?.value()}
            onDone={(saved) => {
              setEditing(false);
              if (saved) void refetch();
            }}
          />
        </Match>
        <Match when={tab() === 'triggers'}>
          <AutoList
            items={(ts() ?? []).map((x) => ({
              id: x.name,
              icon: 'replay',
              name: x.name,
              line: [x.why || say('automations.trigger.line', { runs: x.runs, last: x.lastRunAt ? new Date(x.lastRunAt).toLocaleString() : say('automations.never') })],
              off: x.state === 'off',
            }))}
            empty={say('automations.page.noTriggers')}
            add={{ label: say('automations.page.newTrigger'), onClick: () => setEditing(true) }}
            hint={[say('automations.page.triggersHint1'), { code: 'gh' }, say('automations.page.triggersHint2')]}
          />
        </Match>
        <Match when={tab() === 'recipes'}>
          <AutoList
            items={(rs() ?? []).map((r) => ({ id: r.name, icon: 'bolt', name: r.name, line: [r.prompt.replace(/\s+/g, ' ').slice(0, 140)] }))}
            empty={say('automations.page.noRecipes')}
            add={{ label: say('automations.page.newRecipe'), onClick: openRecipe }}
            hint={[say('automations.page.recipesHint1'), { code: 'wisp recipes' }, ', ', { code: 'wisp run <name> [values…]' }, '.']}
          />
        </Match>
      </Switch>
    </AutomationsBody>
  );
}

function TriggerForm(props: { readonly client: PluginClient; readonly recipes: readonly Recipe[]; readonly here?: string | undefined; readonly onDone: (saved: boolean) => void }): JSX.Element {
  const c = props.client;
  const shell = useShell();
  const say = t as (k: string, v?: Readonly<Record<string, string | number>>) => string;
  const projectRows = useSignal(c.entities.list<unknown>('project'));
  const projects = createMemo(() => projectList(projectRows(), undefined));
  const crew = useSignal(c.entities.list<{ id: string; name?: string; role?: string; body?: { name?: string; role?: string } }>('crew_member'));
  const harnesses = useSignal(shell.harnesses());
  const start = projects().find((p) => p.id === props.here)?.path ?? projects()[0]?.path ?? '';
  const [f, setF] = createSignal<TriggerFormState>(emptyForm(start));
  const [busy, setBusy] = createSignal(false);
  const [problem, setProblem] = createSignal('');
  const set = (patch: Partial<TriggerFormState>): void => void setF({ ...f(), ...patch });
  // the project the list shows, else the first (v1: the launcher's), once the projects have arrived; never over a pick
  let picked = false;
  createEffect(() => {
    const first = projects().find((p) => p.id === props.here)?.path ?? projects()[0]?.path;
    if (!picked && first && !f().project) setF({ ...f(), project: first });
  });
  const kind = (): string => kindOf(f().key).kind;
  const hook = (): boolean => HOOK_KINDS.has(kind());
  const members = (): { id: string; label: string }[] =>
    (crew() ?? []).map((m) => {
      const name = m.name ?? m.body?.name ?? m.id;
      const role = m.role ?? m.body?.role;
      return { id: m.id, label: `${name}${role ? ` · ${role}` : ''} (crew)` };
    });
  const save = (): void => {
    const out = specOfForm(f());
    if ('unsupported' in out) return void setProblem(out.unsupported);
    if ('missing' in out) return void setProblem(say(`automations.form.missing.${out.missing}`));
    setProblem('');
    setBusy(true);
    c.run(apply, { peer: c.home, name: out.name, spec: out.spec }).then(
      () => props.onDone(true),
      () => setBusy(false),
    );
  };
  const anyProject = (): string => (TASK_KINDS.has(kind()) ? say(f().crew ? 'automations.form.theirProject' : 'automations.form.anyProject') : say('automations.form.ownFolder'));
  // the New button that opened the form is gone: focus stays in the form on the picked kind (v1 focused no field)
  let root: HTMLDivElement | undefined;
  onMount(() => root?.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus({ preventScroll: true }));
  return (
    <div data-part="automations.form" ref={root}>
      <TriggerKinds kinds={KINDS.map((k) => ({ key: k.key, label: k.label, hint: k.hint, icon: k.icon }))} value={f().key} onPick={(k) => setF(pick(f(), k))} />
      <AutoRow label={say('automations.form.name')}>
        <Input value={f().name} onInput={(v) => set({ name: v })} maxLength={60} spellcheck={false} aria-label={say('automations.form.name')} />
      </AutoRow>
      <Show when={members().length > 0}>
        <AutoRow label={say('automations.form.sendTo')}>
          <Select
            aria-label={say('automations.form.sendTo')}
            value={f().crew}
            onChange={(v) => set({ crew: v })}
            items={[{ value: '', label: say('automations.form.newTask') }, ...members().map((m) => ({ value: m.id, label: m.label }))]}
          />
        </AutoRow>
      </Show>
      <AutoRow label={say('automations.form.project')}>
        <Select
          aria-label={say('automations.form.project')}
          value={f().project}
          onChange={(v) => ((picked = true), set({ project: v }))}
          items={[...(TASK_KINDS.has(kind()) || members().length ? [{ value: '', label: anyProject() }] : []), ...projects().map((p) => ({ value: p.path, label: p.name }))]}
        />
      </AutoRow>
      <Show when={kind() === 'schedule'}>
        <AutoRow label={say('automations.form.when')}>
          <Input
            value={f().when}
            onInput={(v) => set({ when: v })}
            spellcheck={false}
            autocomplete="off"
            placeholder={say('automations.form.whenPlaceholder')}
            aria-label={say('automations.form.when')}
          />
        </AutoRow>
        <AutoPresets items={SCHEDULE_PRESETS} onPick={(w) => set({ when: w })} read={readBack(f().when, (cron) => cronWords(cron))} />
      </Show>
      <Show when={kind() === 'ci'}>
        <AutoRow label={say('automations.form.branch')}>
          <Input mono value={f().branch} onInput={(v) => set({ branch: v })} spellcheck={false} placeholder={say('automations.form.branchPlaceholder')} aria-label={say('automations.form.branch')} />
        </AutoRow>
      </Show>
      <Show when={kind() === 'issues'}>
        <AutoRow label={say('automations.form.label')}>
          <Input value={f().label} onInput={(v) => set({ label: v })} spellcheck={false} placeholder="wisp" aria-label={say('automations.form.label')} />
        </AutoRow>
      </Show>
      <Show when={hook()}>
        <AutoRow label={say('automations.form.url')}>
          <small>{say('automations.form.urlLater')}</small>
        </AutoRow>
        <AutoNote tone="muted">{say(`automations.form.how.${kind()}`)}</AutoNote>
        <AutoRow label={say(kind() === 'webhook' ? 'automations.form.secret' : 'automations.form.signingSecret')}>
          <Input
            mono
            type="password"
            value={f().secret}
            onInput={(v) => set({ secret: v })}
            autocomplete="new-password"
            spellcheck={false}
            placeholder={say(`automations.form.secretPlaceholder.${kind()}`)}
            aria-label={say('automations.form.secret')}
          />
        </AutoRow>
        <Show when={kind() === 'webhook'}>
          <AutoRow label={say('automations.form.header')}>
            <Input mono value={f().header} onInput={(v) => set({ header: v })} spellcheck={false} placeholder="X-Hub-Signature-256" aria-label={say('automations.form.header')} />
          </AutoRow>
        </Show>
        <Show when={kind() === 'slack'}>
          <AutoRow label={say('automations.form.channel')}>
            <Input mono value={f().channel} onInput={(v) => set({ channel: v })} spellcheck={false} placeholder="C0123456789" aria-label={say('automations.form.channel')} />
          </AutoRow>
          <AutoRow label={say('automations.form.people')}>
            <Input mono value={f().users} onInput={(v) => set({ users: v })} spellcheck={false} autocomplete="off" placeholder="U0123ABCDE, U0456FGHIJ" aria-label={say('automations.form.people')} />
          </AutoRow>
          <AutoNote tone="muted">{say('automations.form.peopleHow')}</AutoNote>
          <AutoRow label={say('automations.form.keyword')}>
            <Input value={f().keyword} onInput={(v) => set({ keyword: v })} spellcheck={false} placeholder={say('automations.form.keywordPlaceholder')} aria-label={say('automations.form.keyword')} />
          </AutoRow>
        </Show>
        <Show when={kind() === 'linear'}>
          <AutoRow label={say('automations.form.label')}>
            <Input value={f().label} onInput={(v) => set({ label: v })} spellcheck={false} placeholder={say('automations.form.linearPlaceholder')} aria-label={say('automations.form.label')} />
          </AutoRow>
        </Show>
      </Show>
      <Show when={POLLED.has(kind())}>
        <AutoRow label={say('automations.form.every')}>
          <Select
            aria-label={say('automations.form.every')}
            value={String(f().every)}
            onChange={(v) => set({ every: Number(v) })}
            items={EVERY.map((m) => ({ value: String(m), label: say('automations.form.minutes', { n: m }) }))}
          />
        </AutoRow>
      </Show>
      <AutoRow label={say('automations.form.run')}>
        <Select
          aria-label={say('automations.form.run')}
          value={f().recipe}
          onChange={(v) => set({ recipe: v })}
          items={[{ value: '', label: say('automations.form.thisPrompt') }, ...props.recipes.map((r) => ({ value: r.name, label: say('automations.form.recipe', { name: r.name }) }))]}
        />
      </AutoRow>
      <Show when={!f().recipe}>
        <AutoRow stack label={say('automations.form.prompt')}>
          <TextArea mono value={f().prompt} onInput={(v) => set({ prompt: v })} minRows={6} maxRows={12} spellcheck={false} aria-label={say('automations.form.prompt')} />
        </AutoRow>
      </Show>
      <Show when={!f().crew} fallback={<AutoNote tone="muted">{say('automations.form.crewRuns')}</AutoNote>}>
        <AutoRow label={say('automations.form.mode')}>
          <Select
            aria-label={say('automations.form.mode')}
            value={f().mode}
            onChange={(v) => set({ mode: v })}
            items={['plan', 'edits', 'auto'].map((m) => ({ value: m, label: say(`automations.recipe.mode.${m}`) }))}
          />
        </AutoRow>
        <AutoRow label={say('automations.form.harness')}>
          <Select
            aria-label={say('automations.form.harness')}
            value={f().agent}
            onChange={(v) => set({ agent: v })}
            items={[{ value: '', label: say('automations.form.launcherDefault') }, ...harnesses().map((h) => ({ value: h.id, label: h.name }))]}
          />
        </AutoRow>
      </Show>
      <Show when={warning(f())}>{(w) => <AutoNote tone="warn">{w()}</AutoNote>}</Show>
      <Show when={problem()}>{(p) => <AutoNote tone="warn">{p()}</AutoNote>}</Show>
      <AutoFoot cancel={say('automations.form.cancel')} ok={say('automations.form.create')} busy={busy()} onCancel={() => props.onDone(false)} onOk={save} />
    </div>
  );
}
