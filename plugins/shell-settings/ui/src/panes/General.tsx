// Settings → General (v1 settings.js 'general'): where files open, where a task opens in its harness, and how
// tasks start. Every row is another plugin's setting, read from its `setting` row and written with
// `settings.set` (instant, rolled back with a toast on a refusal); a row a plugin locked says so.
// "Open tasks in" shows only with two terminals or more, and its command field only for Custom.

import { Slot, useShell } from '@wisp/shell';
import { Show, createMemo, createResource, type JSX } from 'solid-js';
import { computed, defineCommand, type PluginClient } from '@wisp/client';
import { Input, SelectSetting, SettingsGroup, SettingsRow, SwitchSetting, useSignal, type SelectOption, Kbd, ChoiceSetting } from '@wisp/ui';
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

function OnOffRow(props: { readonly client: PluginClient; readonly k: string; readonly dflt: boolean; readonly title: Key; readonly hint: Key; readonly keys?: readonly string[] }): JSX.Element {
  // a hint that ends on its key (v1: "… with its Transcript button or <kbd>V</kbd>"); no keys on a touch screen (the kit hides kbd)
  const hint = (): JSX.Element =>
    props.keys ? (
      <>
        {t(props.hint)} <Kbd keys={props.keys} inline />
      </>
    ) : (
      t(props.hint)
    );
  return <SwitchSetting title={t(props.title)} description={hint()} source={onOff(fromRow(props.client, props.k), props.dflt, props.k)} locked={locked} />;
}

/** wisp.terminal's list for this computer (v1 config.terminals): In wisp, the terminal apps found, Custom. */
const terminalApps = defineCommand<{ peer: string }, { terminals: TerminalApp[]; defaultTerminal: string }>({
  id: 'terminal.apps',
  owner: (a) => a.peer,
  wire: () => ({}),
  optimistic: 'none',
  pending: 'the Take over in list',
});

function TakeOver(props: { readonly client: PluginClient }): JSX.Element {
  const rows = useSignal(props.client.entities.list<TerminalApp>(TERMINAL_KIND));
  const [asked] = createResource(() =>
    props.client.run(terminalApps, { peer: props.client.home }).then(
      (r) => r.terminals,
      () => [] as TerminalApp[],
    ),
  );
  const apps = (): readonly TerminalApp[] => (rows().length > 0 ? rows() : (asked() ?? []));
  const terminal = text(fromRow(props.client, KEYS.terminal), 'wisp');
  const current = useSignal(terminal.value);
  const command = fromRow(props.client, KEYS.terminalCommand, '');
  const commandValue = useSignal(command.value);
  return (
    <Show when={apps().length > 1}>
      <SelectSetting
        title={t('shell-settings.terminal')}
        description={t('shell-settings.terminal.hint')}
        source={terminal}
        locked={locked}
        items={apps().map((a) => ({ value: a.id, label: a.label }))}
      />
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
  return <SelectSetting part="settings.review" title={t('shell-settings.review')} description={t('shell-settings.review.hint')} source={review} locked={locked} items={items()} />;
}

export default function General(props: { readonly client: PluginClient }): JSX.Element {
  const shell = useShell();
  const editors = computed(() => EDITORS.map((v) => ({ value: v, label: t(`shell-settings.editor.${v}`) })));
  return (
    <>
      <SettingsGroup part="settings.general.open">
        <SelectSetting title={t('shell-settings.editor')} description={t('shell-settings.editor.hint')} source={text(fromRow(props.client, KEYS.editor), 'vscode')} locked={locked} items={editors()} />
        <TakeOver client={props.client} />
      </SettingsGroup>
      <SettingsGroup part="settings.general.answers">
        <OnOffRow client={props.client} k={KEYS.tui} dflt={false} title="shell-settings.tui" hint="shell-settings.tui.hint" />
        <OnOffRow client={props.client} k={KEYS.blocks} dflt title="shell-settings.blocks" hint="shell-settings.blocks.hint" />
      </SettingsGroup>
      <SettingsGroup part="settings.general.tasks">
        <OnOffRow client={props.client} k={KEYS.worktree} dflt title="shell-settings.worktree" hint="shell-settings.worktree.hint" />
        <Review client={props.client} />
        <OnOffRow client={props.client} k={KEYS.fixConflicts} dflt={false} title="shell-settings.fix-conflicts" hint="shell-settings.fix-conflicts.hint" />
        <OnOffRow client={props.client} k={KEYS.readTimes} dflt title="shell-settings.read-times" hint="shell-settings.read-times.hint" />
        <OnOffRow client={props.client} k={KEYS.watch} dflt title="shell-settings.watch" hint="shell-settings.watch.hint" />
        <OnOffRow client={props.client} k={KEYS.apps} dflt title="shell-settings.apps" hint="shell-settings.apps.hint" />
      </SettingsGroup>
      <SettingsGroup part="settings.general.crew">
        {/* v1 kept Theme here, above Crew tint (Appearance has it too) */}
        <ChoiceSetting
          title={t('shell-settings.theme')}
          description={t('shell-settings.theme.hint')}
          source={{ value: () => shell.theme.pref(), set: (v: string) => void shell.theme.set(v as never) }}
          items={[
            { value: 'system', label: t('shell-settings.theme.system'), icon: 'laptop' },
            { value: 'light', label: t('shell-settings.theme.light'), icon: 'sun' },
            { value: 'dark', label: t('shell-settings.theme.dark'), icon: 'moon' },
          ]}
        />
        <OnOffRow client={props.client} k={KEYS.crewTint} dflt title="shell-settings.crew-tint" hint="shell-settings.crew-tint.hint" />
      </SettingsGroup>
      <SettingsGroup part="settings.general.transcript">
        <OnOffRow client={props.client} k={KEYS.transcript} dflt={false} title="shell-settings.transcript" hint="shell-settings.transcript.hint" keys={['V']} />
      </SettingsGroup>
      {/* what other plugins put at the end of General (wisp.update's Updates row, as v1 had it here) */}
      <Slot input="shell.settings:general" layout="contents" />
    </>
  );
}
