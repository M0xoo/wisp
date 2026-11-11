// Settings → Plugins (v1's Spells, ADR-0031: a change to wisp is a plugin now): every plugin this wisp runs,
// built-in or yours, with its state (on, off, refused and why) and its switch. A switch shows at once and
// the list is read again after it; switching off frees everything the plugin made (its scope).
import { createResource, createSignal, For, Show, type JSX } from 'solid-js';
import type { PluginClient } from '@wisp/client';
import { Button, Callout, IconButton, Inline, Input, Pill, SettingsGroup, SettingsRow, Stack, Switch, Text } from '@wisp/ui';
import { install, list, permissionWords, setEnabled, uninstall, type Installed, type PluginRow } from '../commands.ts';
import { t } from '../i18n.ts';

const TONE: Record<string, 'good' | 'neutral' | 'bad'> = { active: 'good', resolved: 'good', off: 'neutral', refused: 'bad' };

export default function Plugins(props: { readonly client: PluginClient }): JSX.Element {
  const c = props.client;
  const peer = c.home;
  const [rows, { refetch, mutate }] = createResource(() => c.run(list, { peer }).catch((): PluginRow[] => []));
  const [busy, setBusy] = createSignal<string | undefined>();
  const flip = (p: PluginRow, on: boolean): void => {
    mutate((rs) => (rs ?? []).map((x) => (x.id === p.id ? { ...x, enabled: on, state: on ? 'active' : 'off' } : x)));
    setBusy(p.id);
    c.run(setEnabled, { peer, id: p.id, enabled: on })
      .catch(() => {})
      .finally(() => {
        setBusy(undefined);
        void refetch();
      });
  };
  // Install…: a folder or a git URL; the answer says what it asks for before anything of it runs
  const say = t as (k: string, v?: Readonly<Record<string, string>>) => string;
  const [source, setSource] = createSignal('');
  const [installing, setInstalling] = createSignal(false);
  const [got, setGot] = createSignal<Installed | undefined>(undefined);
  const go = (): void => {
    const v = source().trim();
    if (!v) return;
    setInstalling(true);
    c.run(install, { peer, source: v })
      .then(
        (r) => {
          setSource('');
          setGot(r);
          void refetch();
        },
        () => undefined,
      )
      .finally(() => setInstalling(false));
  };
  const switchOn = (r: Installed): void => {
    setGot(undefined);
    const p = (rows() ?? []).find((x) => x.id === r.id);
    flip(p ?? { id: r.id, version: r.version, state: 'off', enabled: false, builtin: false }, true);
  };
  // Remove: gone from the list at once, back with the shell's toast if refused
  const remove = (p: PluginRow): void => {
    mutate((rs) => (rs ?? []).filter((x) => x.id !== p.id));
    if (got()?.id === p.id) setGot(undefined);
    c.run(uninstall, { peer, id: p.id })
      .catch(() => {})
      .finally(() => void refetch());
  };
  const yours = (): PluginRow[] => (rows() ?? []).filter((p) => !p.builtin);
  const builtins = (): PluginRow[] => (rows() ?? []).filter((p) => p.builtin).sort((a, b) => a.id.localeCompare(b.id));
  const row = (p: PluginRow): JSX.Element => (
    <SettingsRow
      part="plugins.row"
      title={p.id.replace(/^wisp\./, '')}
      description={p.reason ?? t('plugins.version', { version: p.version })}
      control={
        <>
          <Pill tone={TONE[p.state] ?? 'neutral'} dot variant="outline">
            {t(`plugins.state.${(TONE[p.state] ? p.state : 'off') as 'active'}`)}
          </Pill>
          <Switch aria-label={t('plugins.on', { name: p.id })} checked={p.enabled} disabled={busy() === p.id} onChange={(on) => flip(p, on)} />
          <Show when={p.id.startsWith('user.')}>
            <IconButton icon="trash" size="sm" variant="ghost" label={t('plugins.remove', { name: p.id })} onClick={() => remove(p)} />
          </Show>
        </>
      }
    />
  );
  return (
    <>
      <Text as="p" tone="muted" part="plugins.lede">
        {t('plugins.lede')}
      </Text>
      <SettingsGroup part="plugins.install" title={t('plugins.install')} description={t('plugins.install.hint')}>
        <Stack gap="3">
          <Inline gap="2" part="plugins.install.box">
            <Input
              icon="plug"
              value={source()}
              onInput={setSource}
              onKeyDown={(e) => e.key === 'Enter' && !e.isComposing && (e.preventDefault(), go())}
              placeholder={t('plugins.install.placeholder')}
              aria-label={t('plugins.install')}
            />
            <Button variant="secondary" loading={installing()} disabled={!source().trim()} onClick={go}>
              {t('plugins.install.go')}
            </Button>
          </Inline>
          <Show when={got()}>
            {(r) => (
              <Callout tone="warn" title={say('plugins.installed', { name: r().name, version: r().version })} part="plugins.installed">
                <Stack gap="2">
                  <Text size="sm">{r().permissions.length > 0 ? t('plugins.asks') : t('plugins.asksNothing')}</Text>
                  <For each={r().permissions}>
                    {(p) => (
                      <Text size="sm" part="plugins.installed.permission">
                        {`• ${permissionWords(p, say)}`}
                      </Text>
                    )}
                  </For>
                  <Inline gap="2">
                    <Button size="sm" variant="primary" onClick={() => switchOn(r())}>
                      {t('plugins.switchOn')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setGot(undefined)}>
                      {t('plugins.notNow')}
                    </Button>
                  </Inline>
                </Stack>
              </Callout>
            )}
          </Show>
        </Stack>
      </SettingsGroup>
      <SettingsGroup part="plugins.yours" title={t('plugins.yours')}>
        <Show when={yours().length > 0} fallback={<SettingsRow part="plugins.none" title={t('plugins.none')} description={t('plugins.none.description')} control={<span />} />}>
          <For each={yours()}>{row}</For>
        </Show>
      </SettingsGroup>
      <SettingsGroup part="plugins.builtin" title={t('plugins.builtin')} description={t('plugins.builtin.description')}>
        <For each={builtins()}>{row}</For>
      </SettingsGroup>
    </>
  );
}
