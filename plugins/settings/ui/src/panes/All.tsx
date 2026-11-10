// Settings → All settings: every setting wisp's plugins declare, the same registry `wisp settings` and a
// formula's `settings:` reach, searchable, grouped by the plugin that owns it. Each row has the control its type
// takes (a switch, a choice, a number or text), shows its default when unset, and says what locks it (a formula).
import { createMemo, createResource, createSignal, For, Show, type JSX } from 'solid-js';
import type { Json, PluginClient } from '@wisp/client';
import { Input, Select, SettingsGroup, SettingsRow, Switch, Text, useSignal } from '@wisp/ui';
import { list, type SettingInfo } from '../commands.ts';
import { t } from '../i18n.ts';
import { fromRow } from '../source.ts';

const words = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v));

function Control(props: { readonly c: PluginClient; readonly s: SettingInfo }): JSX.Element {
  const src = fromRow(props.c, props.s.key, (props.s.decl.default ?? null) as Json);
  const value = useSignal(src.value);
  const lockedBy = src.lockedBy ? useSignal(src.lockedBy) : (): string | undefined => undefined;
  const locked = (): boolean => !!props.s.lockedBy || !!lockedBy();
  const label = props.s.decl.title ?? props.s.key;
  const [draft, setDraft] = createSignal<string | undefined>();
  const commit = (raw: string): void => {
    setDraft(undefined);
    if (props.s.decl.type === 'number' || props.s.decl.type === 'int') {
      const n = Number(raw);
      if (raw.trim() !== '' && Number.isFinite(n)) src.set(n);
    } else if (props.s.decl.type === 'json') {
      try {
        src.set(JSON.parse(raw) as Json);
      } catch {
        // not JSON: the box keeps what was typed until it is
        setDraft(raw);
      }
    } else src.set(raw);
  };
  switch (props.s.decl.type) {
    case 'boolean':
    case 'bool':
      return <Switch aria-label={label} checked={value() === true || value() === 'on'} disabled={locked()} onChange={(on) => src.set(on)} />;
    case 'enum':
      return <Select aria-label={label} size="sm" items={(props.s.decl.values ?? []).map((v) => ({ value: v, label: v }))} value={words(value()) || undefined} placeholder={t('settings.all.default')} disabled={locked()} onChange={(v) => src.set(v)} />;
    default:
      return <Input size="sm" mono aria-label={label} type={props.s.decl.secret ? 'password' : 'text'} value={draft() ?? words(value())} disabled={locked()} onInput={setDraft} onBlur={() => draft() !== undefined && commit(draft() ?? '')} onKeyDown={(e) => e.key === 'Enter' && commit(draft() ?? words(value()))} />;
  }
}

export default function All(props: { readonly client: PluginClient }): JSX.Element {
  const c = props.client;
  const [rows] = createResource(() => c.run(list, { peer: c.home }).catch((): SettingInfo[] => []));
  const [q, setQ] = createSignal('');
  const groups = createMemo(() => {
    const needle = q().trim().toLowerCase();
    const by = new Map<string, SettingInfo[]>();
    for (const s of rows() ?? []) {
      if (needle && !`${s.key} ${s.decl.title ?? ''} ${s.owner}`.toLowerCase().includes(needle)) continue;
      by.set(s.owner, [...(by.get(s.owner) ?? []), s]);
    }
    return [...by.entries()].sort(([a], [b]) => a.localeCompare(b));
  });
  return (
    <>
      <Text as="p" tone="muted" part="settings.lede">
        {t('settings.all.lede')}
      </Text>
      <Input icon="search" aria-label={t('settings.all.search')} placeholder={t('settings.all.search')} value={q()} onInput={setQ} />
      <Show when={groups().length > 0} fallback={<Text tone="muted">{rows.loading ? t('settings.all.loading') : t('settings.all.none')}</Text>}>
        <For each={groups()}>
          {([owner, items]) => (
            <SettingsGroup part="settings.all.group" title={owner.replace(/^wisp\./, '')}>
              <For each={items}>
                {(s) => (
                  <SettingsRow
                    part="settings.all.row"
                    title={s.decl.title ?? s.key}
                    description={
                      <Text mono tone="muted">
                        {s.lockedBy ? t('settings.all.locked', { key: s.key, by: s.lockedBy }) : s.key}
                      </Text>
                    }
                    wideControl={s.decl.type !== 'boolean' && s.decl.type !== 'bool'}
                    control={<Control c={c} s={s} />}
                  />
                )}
              </For>
            </SettingsGroup>
          )}
        </For>
      </Show>
    </>
  );
}
