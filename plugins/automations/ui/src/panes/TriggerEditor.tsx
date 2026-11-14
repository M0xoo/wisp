// A new trigger (ADR-0043): its name, When (the "When" picker: every source the plugins declare, grouped by the
// plugin that owns it, with that source's own fields), and the prompt it sends. Saved as a `trigger` resource
// (`resources.apply`, the one declaration the CLI, MCP and formulas write too). Refused: the form stays, with the
// shell's toast saying why.
import { createMemo, createResource, createSignal, For, type JSX } from 'solid-js';
import { defineCommand, type PeerId, type PluginClient } from '@wisp/client';
import { Button, Inline, Input, SelectSetting, SettingsGroup, SettingsRow, Switch, TextArea } from '@wisp/ui';
import { t } from '../i18n.ts';
import { fieldsOf, groups, nameOf, pluginName, specOf, type SourceRow } from '../when.ts';

const sources = defineCommand<{ peer: PeerId }, SourceRow[]>({ id: 'automations.sources', owner: (a) => a.peer, wire: () => ({}), optimistic: 'none', pending: 'the sources' });
const apply = defineCommand<{ peer: PeerId; name: string; spec: Record<string, unknown> }>({
  id: 'resources.apply',
  owner: (a) => a.peer,
  wire: (a) => ({ resources: [{ kind: 'trigger', name: a.name, spec: a.spec }] }),
  optimistic: 'none',
  pending: 'Save',
});

export function TriggerEditor(props: { readonly client: PluginClient; readonly onDone: (saved: boolean) => void }): JSX.Element {
  const c = props.client;
  const [list] = createResource(() => c.run(sources, { peer: c.home }).catch((): SourceRow[] => []));
  const [name, setName] = createSignal('');
  // v1's default kind: on a schedule
  const [on, setOn] = createSignal('schedule');
  const [prompt, setPrompt] = createSignal('');
  const [values, setValues] = createSignal<Record<string, string | boolean>>({});
  const [saving, setSaving] = createSignal(false);
  const [missing, setMissing] = createSignal('');
  const source = createMemo(() => (list() ?? []).find((s) => s.on === on()));
  const fields = createMemo(() => fieldsOf(source()?.fields));
  // the When picker: each source under its plugin, those that can't run now marked
  const items = createMemo(() =>
    groups(list() ?? []).flatMap((g) =>
      g.sources.map((s) => ({ value: s.on, label: s.title || s.on, group: s.available ? pluginName(g.plugin) : t('automations.editor.off', { plugin: pluginName(g.plugin) }) })),
    ),
  );
  const set = (k: string, v: string | boolean): void => {
    setValues({ ...values(), [k]: v });
  };
  const save = (): void => {
    const n = nameOf(name());
    if (!n) return void setMissing('name');
    const out = specOf({ on: on(), prompt: prompt(), values: values() }, fields());
    if ('missing' in out) return void setMissing(out.missing);
    setMissing('');
    setSaving(true);
    c.run(apply, { peer: c.home, name: n, spec: out.spec }).then(
      () => props.onDone(true),
      () => setSaving(false),
    );
  };
  const hint = (k: string): string | undefined => (missing() === k ? t('automations.editor.missing') : undefined);
  return (
    <SettingsGroup part="automations.editor" title={t('automations.editor.title')}>
      <SettingsRow
        part="automations.editor.name"
        title={t('automations.editor.name')}
        description={hint('name')}
        wideControl
        control={<Input size="sm" value={name()} placeholder={t('automations.editor.namePlaceholder')} aria-label={t('automations.editor.name')} onInput={setName} />}
      />
      <SelectSetting
        part="automations.editor.when"
        title={t('automations.editor.when')}
        description={hint('on') ?? (list.loading ? t('automations.editor.loading') : t('automations.editor.pick'))}
        source={{
          value: on,
          set: (v: string) => {
            setOn(v);
            setValues({});
          },
        }}
        items={items()}
      />
      <For each={fields()}>
        {(f) => (
          <SettingsRow
            part="automations.editor.field"
            title={f.title}
            description={hint(f.key) ?? f.hint}
            wideControl={f.type !== 'boolean'}
            control={
              f.type === 'boolean' ? (
                <Switch aria-label={f.title} checked={values()[f.key] === true} onChange={(v) => set(f.key, v)} />
              ) : (
                <Input size="sm" value={String(values()[f.key] ?? '')} aria-label={f.title} onInput={(v) => set(f.key, v)} />
              )
            }
          />
        )}
      </For>
      <SettingsRow
        part="automations.editor.prompt"
        title={t('automations.editor.prompt')}
        description={hint('prompt') ?? t('automations.editor.promptHint')}
        wideControl
        control={<TextArea value={prompt()} onInput={setPrompt} minRows={2} maxRows={8} aria-label={t('automations.editor.prompt')} />}
      />
      <SettingsRow
        part="automations.editor.actions"
        title=""
        control={
          <Inline gap="2">
            <Button size="sm" variant="ghost" onClick={() => props.onDone(false)}>
              {t('automations.editor.cancel')}
            </Button>
            <Button size="sm" variant="primary" loading={saving()} onClick={save}>
              {t('automations.editor.save')}
            </Button>
          </Inline>
        }
      />
    </SettingsGroup>
  );
}
