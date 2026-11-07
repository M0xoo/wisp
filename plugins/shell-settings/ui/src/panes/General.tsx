// Settings → General (v1 settings.js 'general'): where files open, where you take over, and how
// tasks start. Every row is another plugin's setting, read from its `setting` row and written with
// `settings.set` (instant, rolled back with a toast on a refusal); a row a plugin locked says so.
// "Take over in" shows only with two terminals or more, and its command field only for Custom.

import { Show, createMemo, type JSX } from 'solid-js';
import { computed, type PluginClient } from '@wisp/client';
import { Input, SelectSetting, SettingsGroup, SettingsRow, SwitchSetting, useSignal, type SelectOption } from '@wisp/ui';
import { t, type Key } from '../i18n.ts';
import { fromRow, onOff, text } from '../source.ts';
import { EDITORS, HARNESS_KIND, KEYS, REVIEW_HARNESSES, TERMINAL_KIND, type Harness, type TerminalApp } from '../types.ts';

const locked = (by: string): string => t('shell-settings.locked', { by });

/** v1 REVIEW_CHOICES: Off, Another harness, then each review harness that's here (or already picked). */
export function reviewChoices(harnesses: readonly Harness[], picked: string): SelectOption[] {
  const named = REVIEW_HARNESSES.filter((id) => harnesses.some((h) => h.id === id && h.available) || picked === id);
  return [
    { value: 'off', label: t('shell-settings.review.off') },
    { value: 'other', label: t('shell-settings.review.other') },
    ...named.map((id) => ({ value: id, label: harnesses.find((h) => h.id === id)?.name ?? id })),
  ];
}

function Switch(props: { readonly client: PluginClient; readonly k: string; readonly dflt: boolean; readonly title: Key; readonly hint: Key }): JSX.Element {
  return <SwitchSetting title={t(props.title)} description={t(props.hint)} source={onOff(fromRow(props.client, props.k), props.dflt)} locked={locked} />;
}

function TakeOver(props: { readonly client: PluginClient }): JSX.Element {
  const apps = useSignal(props.client.entities.list<TerminalApp>(TERMINAL_KIND));
  const terminal = text(fromRow(props.client, KEYS.terminal), 'wisp');
  const current = useSignal(terminal.value);
  const command = fromRow(props.client, KEYS.terminalCommand, '');
  const commandValue = useSignal(command.value);
  return (
    <Show when={apps().length > 1}>
      <SelectSetting title={t('shell-settings.terminal')} description={t('shell-settings.terminal.hint')} source={terminal} locked={locked} items={apps().map((a) => ({ value: a.id, label: a.label }))} />
      <Show when={current() === 'custom'}>
        <SettingsRow
          title={t('shell-settings.terminal-command')}
          description={t('shell-settings.terminal-command.hint')}
          wideControl
          control={
            <Input
              mono
              spellcheck={false}
              aria-label={t('shell-settings.terminal-command')}
              value={typeof commandValue() === 'string' ? (commandValue() as string) : ''}
              placeholder={t('shell-settings.terminal-command.placeholder')}
              onChange={(v) => command.set(v.trim())}
            />
          }
        />
      </Show>
    </Show>
  );
}

function Review(props: { readonly client: PluginClient }): JSX.Element {
  const review = text(fromRow(props.client, KEYS.review), 'off');
  const picked = useSignal(review.value);
  const harnesses = useSignal(props.client.entities.list<Harness>(HARNESS_KIND));
  const items = createMemo(() => reviewChoices(harnesses() as readonly Harness[], picked()));
  return <SelectSetting title={t('shell-settings.review')} description={t('shell-settings.review.hint')} source={review} locked={locked} items={items()} />;
}

export default function General(props: { readonly client: PluginClient }): JSX.Element {
  const editors = computed(() => EDITORS.map((v) => ({ value: v, label: t(`shell-settings.editor.${v}`) })));
  return (
    <>
      <SettingsGroup part="settings.general.open">
        <SelectSetting title={t('shell-settings.editor')} description={t('shell-settings.editor.hint')} source={text(fromRow(props.client, KEYS.editor), 'vscode')} locked={locked} items={editors()} />
        <TakeOver client={props.client} />
      </SettingsGroup>
      <SettingsGroup part="settings.general.answers">
        <Switch client={props.client} k={KEYS.tui} dflt={false} title="shell-settings.tui" hint="shell-settings.tui.hint" />
        <Switch client={props.client} k={KEYS.blocks} dflt title="shell-settings.blocks" hint="shell-settings.blocks.hint" />
      </SettingsGroup>
      <SettingsGroup part="settings.general.tasks">
        <Switch client={props.client} k={KEYS.worktree} dflt title="shell-settings.worktree" hint="shell-settings.worktree.hint" />
        <Review client={props.client} />
        <Switch client={props.client} k={KEYS.fixConflicts} dflt={false} title="shell-settings.fix-conflicts" hint="shell-settings.fix-conflicts.hint" />
        <Switch client={props.client} k={KEYS.readTimes} dflt title="shell-settings.read-times" hint="shell-settings.read-times.hint" />
        <Switch client={props.client} k={KEYS.watch} dflt title="shell-settings.watch" hint="shell-settings.watch.hint" />
        <Switch client={props.client} k={KEYS.apps} dflt title="shell-settings.apps" hint="shell-settings.apps.hint" />
      </SettingsGroup>
      <SettingsGroup part="settings.general.transcript">
        <Switch client={props.client} k={KEYS.transcript} dflt={false} title="shell-settings.transcript" hint="shell-settings.transcript.hint" />
      </SettingsGroup>
    </>
  );
}
