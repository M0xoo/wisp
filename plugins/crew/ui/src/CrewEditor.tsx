// A member's editor (v1 crew.js crewEditor): Edit… on a member's page, and Add a crew member on the rail. Name,
// role and brief; how often they check in and how many jobs at once; the harness, mode and folder their jobs run
// with; and Wakes (ADR-0043): what else starts their jobs, each a trigger spec targeting them (a hand-off is "after
// X reports"). Save shows at once (crew.update or crew.create) and rolls back with the shell's toast if refused.
import { createEffect, createMemo, createResource, createSignal, For, Show, type JSX } from 'solid-js';
import { defineCommand, uuidv7, type PeerId, type PluginClient } from '@wisp/client';
import { useShell } from '@wisp/shell';
import { Button, IconButton, Inline, Input, SelectSetting, SettingsGroup, SettingsRow, TextArea, Text, useSignal } from '@wisp/ui';
import { createMember, updateMember } from './commands.ts';
import { crewData } from './data.ts';
import { addWake, draftOf, patchOf, problemOf, wakeLabel, type Draft } from './editor.ts';
import { t, type Key } from './i18n.ts';
import { CADENCES } from './model.ts';
import type { Member } from './types.ts';
import { VIEW } from './views.ts';

interface Source {
  readonly plugin: string;
  readonly on: string;
  readonly title: string;
  readonly available: boolean;
}
const sources = defineCommand<{ peer: PeerId }, Source[]>({ id: 'automations.sources', owner: (a) => a.peer, wire: () => ({}), optimistic: 'none', pending: 'what can wake them' });

// size-ok: one form whose rows share its draft
export default function CrewEditor(props: { readonly client: PluginClient; readonly params: { id?: string } }): JSX.Element {
  const c = props.client;
  const shell = useShell();
  const say = t as (k: string, v?: Readonly<Record<string, string | number>>) => string;
  const data = crewData(c);
  const members = useSignal(data.members);
  const harnesses = useSignal(shell.harnesses());
  // read through `members()` so what depends on it follows the rows as they arrive
  const member = (): (Member & { key: string }) | undefined => (members(), props.params.id ? (data.byId(props.params.id) as (Member & { key: string }) | undefined) : undefined);
  // the member as it was when the form filled: its row may arrive after the dialog opens (a reload on it)
  let before = draftOf(member());
  let touched = false;
  const [d, setD] = createSignal<Draft>(before);
  createEffect(() => {
    const m = member();
    if (!m || touched) return;
    before = draftOf(m);
    setD(before);
  });
  const [problem, setProblem] = createSignal<string | undefined>(undefined);
  const [adding, setAdding] = createSignal('');
  const [after, setAfter] = createSignal('');
  const [list] = createResource(() => c.run(sources, { peer: c.home }).catch((): Source[] => []));
  const set = (patch: Partial<Draft>): void => {
    touched = true;
    setD({ ...d(), ...patch });
  };
  const titleOf = (on: string): string => list()?.find((s) => s.on === on)?.title || on;
  const others = createMemo(() => members().filter((m) => m.id !== props.params.id));
  const close = (): void => c.navigate({ t: 'closeOverlay', id: VIEW.editor as never });
  const save = (): void => {
    const why = problemOf(
      d(),
      others().map((m) => m.name),
    );
    if (why) return void setProblem(why);
    const m = member();
    if (m) {
      const patch = patchOf(d(), before);
      if (Object.keys(patch).length > 0) void c.run(updateMember, { key: m.key as never, id: m.id, ...patch }).catch(() => undefined);
    } else {
      const v = { ...d(), name: d().name.trim(), role: d().role.trim(), brief: d().brief.trim() };
      void c.run(createMember, { peer: c.home, id: uuidv7(), member: v as unknown as Member }).catch(() => undefined);
    }
    close();
  };
  const field = (part: `${string}.${string}`, title: Key, control: JSX.Element, hint?: string): JSX.Element => (
    <SettingsRow part={part} title={t(title)} description={hint} wideControl control={control} />
  );
  return (
    <>
      <SettingsGroup part="crew.editor.who">
        {field(
          'crew.editor.name',
          'wisp.crew.editor.name',
          <Input size="sm" value={d().name} placeholder={t('wisp.crew.editor.namePlaceholder')} aria-label={t('wisp.crew.editor.name')} onInput={(name) => set({ name })} />,
          problem() ? say(problem() as string) : undefined,
        )}
        {field(
          'crew.editor.role',
          'wisp.crew.editor.role',
          <Input size="sm" value={d().role} placeholder={t('wisp.crew.editor.rolePlaceholder')} aria-label={t('wisp.crew.editor.role')} onInput={(role) => set({ role })} />,
        )}
        {field(
          'crew.editor.brief',
          'wisp.crew.editor.brief',
          <TextArea value={d().brief} minRows={2} maxRows={8} aria-label={t('wisp.crew.editor.brief')} onInput={(brief) => set({ brief })} />,
          t('wisp.crew.editor.briefHint'),
        )}
      </SettingsGroup>
      <SettingsGroup part="crew.editor.how">
        <SelectSetting
          part="crew.editor.cron"
          title={t('wisp.crew.editor.cron')}
          source={{ value: () => d().cron || 'asked', set: (v: string) => set({ cron: v === 'asked' ? '' : v }) }}
          items={CADENCES.map(([v, k]) => ({ value: v || 'asked', label: t(k) }))}
        />
        <SelectSetting
          part="crew.editor.parallel"
          title={t('wisp.crew.editor.parallel')}
          source={{ value: () => String(d().parallel), set: (v: string) => set({ parallel: Number(v) }) }}
          items={[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: say('wisp.crew.page.parallel', { count: n }) }))}
        />
        <SelectSetting
          part="crew.editor.agent"
          title={t('wisp.crew.editor.agent')}
          source={{ value: () => d().agent || (harnesses()[0]?.id ?? ''), set: (agent: string) => set({ agent }) }}
          items={[{ value: 'auto', label: t('wisp.crew.editor.auto') }, ...harnesses().map((h) => ({ value: h.id, label: h.name }))]}
        />
        <SelectSetting
          part="crew.editor.mode"
          title={t('wisp.crew.editor.mode')}
          source={{ value: () => d().mode, set: (mode: string) => set({ mode: mode as Draft['mode'] }) }}
          items={(['plan', 'edits', 'auto'] as const).map((m) => ({ value: m, label: t(`wisp.crew.page.mode.${m}`) }))}
        />
        {field(
          'crew.editor.cwd',
          'wisp.crew.editor.cwd',
          <Input size="sm" value={d().cwd} placeholder={t('wisp.crew.editor.cwdPlaceholder')} aria-label={t('wisp.crew.editor.cwd')} onInput={(cwd) => set({ cwd })} />,
        )}
      </SettingsGroup>
      <SettingsGroup part="crew.editor.wakes" title={t('wisp.crew.editor.wakes')} description={t('wisp.crew.editor.wakesHint')}>
        <For each={d().wakes}>
          {(w, i) => (
            <SettingsRow
              part="crew.editor.wake"
              title={wakeLabel(w, titleOf, say)}
              control={<IconButton icon="x" size="sm" variant="ghost" label={t('wisp.crew.editor.wake.remove')} onClick={() => set({ wakes: d().wakes.filter((_, k) => k !== i()) })} />}
            />
          )}
        </For>
        <SelectSetting
          part="crew.editor.wake.add"
          title={t('wisp.crew.editor.wake.add')}
          source={{ value: adding, set: setAdding }}
          items={[
            { value: 'crew.reported', label: t('wisp.crew.editor.wake.handoff') },
            ...(list() ?? []).filter((s) => !['manual', 'schedule', 'once', 'crew.reported'].includes(s.on)).map((s) => ({ value: s.on, label: s.title || s.on })),
          ]}
        />
        <Show when={adding() === 'crew.reported'}>
          <SelectSetting
            part="crew.editor.wake.after"
            title={t('wisp.crew.editor.wake.who')}
            source={{ value: after, set: setAfter }}
            items={others().map((m) => ({ value: m.name, label: m.name }))}
          />
        </Show>
        <SettingsRow
          part="crew.editor.wake.go"
          title=""
          control={
            <Button
              size="sm"
              variant="secondary"
              icon="plus"
              disabled={!adding() || (adding() === 'crew.reported' && !after())}
              onClick={() => {
                set({ wakes: addWake(d().wakes, adding(), after() || undefined) });
                setAdding('');
                setAfter('');
              }}
            >
              {t('wisp.crew.editor.wake.addButton')}
            </Button>
          }
        />
      </SettingsGroup>
      <Inline gap="2" justify="end" part="crew.editor.actions">
        <Show when={problem()}>
          {(p) => (
            <Text size="sm" tone="bad">
              {say(p())}
            </Text>
          )}
        </Show>
        <Button size="sm" variant="ghost" onClick={close}>
          {t('wisp.crew.page.cancel')}
        </Button>
        <Button size="sm" variant="primary" onClick={save}>
          {t('wisp.crew.page.save')}
        </Button>
      </Inline>
    </>
  );
}
