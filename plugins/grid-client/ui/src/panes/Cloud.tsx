// Settings → Cloud (v1 settings.js cloud, design/v1-reference/settings.cloud): your wisp on a server. Signed
// out: the grid's address and Sign in, then the code the browser asks for while it approves. Signed in: who,
// where, this computer on the grid (reach it from any browser), and Sign out.
import { createSignal, Match, onCleanup, Show, Switch as Pick, type JSX } from 'solid-js';
import { entityKey, type PluginClient } from '@wisp/client';
import { Button, Inline, Input, Link, SettingsGroup, SettingsRow, Stack, Switch, Text, useSignal } from '@wisp/ui';
import { cancelSignIn, DEFAULT_GRID, KIND, setComputer, signIn, signOut, TOPIC, type CloudRow } from '../commands.ts';
import { t } from '../i18n.ts';

const host = (url: string): string => url.replace(/^https?:\/\//, '').replace(/\/$/, '');

export default function Cloud(props: { readonly client: PluginClient }): JSX.Element {
  const c = props.client;
  const peer = c.home;
  const scope = c.scope.child('cloud-pane');
  onCleanup(() => scope.dispose());
  c.watch(peer, TOPIC, scope);
  const row = useSignal(c.entities.row<CloudRow>(KIND, entityKey(peer, 'this')));
  const r = (): CloudRow | undefined => row() as CloudRow | undefined;
  const [grid, setGrid] = createSignal(DEFAULT_GRID);
  const [starting, setStarting] = createSignal(false);
  const waiting = () => (r()?.signin?.state === 'waiting' ? r()?.signin : undefined);
  const failed = () => (r()?.signin && ['denied', 'expired', 'failed'].includes(r()?.signin?.state ?? '') ? r()?.signin?.error : undefined);
  const start = (): void => {
    setStarting(true);
    c.run(signIn, { peer, grid: grid() })
      .then((s) => {
        if (s.verifyUrl) window.open(s.verifyUrl, '_blank', 'noopener');
      })
      .catch(() => {})
      .finally(() => setStarting(false));
  };
  const computerLine = (): string => {
    const k = r()?.computer;
    if (!k?.on) return t('grid-client.computer.off');
    if (k.state === 'online') return k.url ? t('grid-client.computer.online', { url: host(k.url) }) : t('grid-client.computer.onlineNoUrl');
    if (k.state === 'retrying') return k.error || t('grid-client.computer.retrying');
    return t('grid-client.computer.connecting');
  };
  return (
    <>
      <Text as="p" tone="muted" part="grid-client.lede">
        {t('grid-client.lede')}
      </Text>
      <Pick>
        <Match when={r()?.signedIn}>
          <SettingsGroup part="grid-client.account">
            <SettingsRow
              part="grid-client.signed-in"
              title={t('grid-client.signedIn', { handle: r()?.handle ?? '' })}
              description={host(r()?.grid ?? '')}
              control={
                <Button size="sm" variant="ghost" onClick={() => void c.run(signOut, { peer }).catch(() => {})}>
                  {t('grid-client.signOut')}
                </Button>
              }
            />
            <SettingsRow
              part="grid-client.computer"
              title={t('grid-client.computer.title')}
              description={computerLine()}
              control={<Switch aria-label={t('grid-client.computer.title')} checked={r()?.computer?.on ?? false} onChange={(on) => void c.run(setComputer, { peer, on }).catch(() => {})} />}
            />
          </SettingsGroup>
        </Match>
        <Match when={waiting()}>
          {(s) => (
            <SettingsGroup part="grid-client.waiting" title={t('grid-client.waiting.title')} description={t('grid-client.waiting.description')}>
              <Stack gap="2">
                <Text size="lg" mono part="grid-client.code">
                  {s().userCode}
                </Text>
                <Inline gap="2">
                  <Link href={s().verifyUrl} external>
                    {host(s().verifyUrl)}
                  </Link>
                  <Button size="sm" variant="ghost" onClick={() => void c.run(cancelSignIn, { peer, id: s().id }).catch(() => {})}>
                    {t('grid-client.cancel')}
                  </Button>
                </Inline>
              </Stack>
            </SettingsGroup>
          )}
        </Match>
        <Match when={true}>
          <SettingsGroup part="grid-client.signin" title={t('grid-client.signin.title')} description={t('grid-client.signin.description')}>
            <Inline gap="2">
              <Input mono aria-label={t('grid-client.signin.grid')} value={grid()} onInput={setGrid} placeholder={DEFAULT_GRID} />
              <Button icon="lock" part="grid-client.signin.go" disabled={starting()} onClick={start}>
                {t('grid-client.signin.go')}
              </Button>
            </Inline>
            <Show when={failed()}>{(why) => <Text tone="bad">{why()}</Text>}</Show>
          </SettingsGroup>
        </Match>
      </Pick>
      <Text as="p" tone="muted" part="grid-client.note">
        {t('grid-client.note')}
      </Text>
    </>
  );
}
