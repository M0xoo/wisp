// Settings → Cloud (v1 settings.js cloud, design/v1-reference/settings.cloud): your wisp on a server. Signed
// out: the grid's address and Sign in, then the code the browser asks for while it approves. Signed in: who,
// where, this computer on the grid (reach it from any browser), and Sign out.
import { Match, Show, Switch as Pick, type JSX } from 'solid-js';
import type { PluginClient } from '@wisp/client';
import { Slot } from '@wisp/shell';
import { Button, Code, Inline, Input, Link, SettingsBlock, SettingsInputRow, SettingsGroup, SettingsNote, SettingsRow, Stack, Switch, Text } from '@wisp/ui';
import { cancelSignIn, DEFAULT_GRID, setComputer, signOut } from '../commands.ts';
import { t } from '../i18n.ts';
import { MyShares } from './MyShares.tsx';
import { host, useCloud } from './state.ts';

export default function Cloud(props: { readonly client: PluginClient }): JSX.Element {
  const { c, peer, r, grid, setGrid, starting, waiting, failed, start, computerLine } = useCloud(props.client);
  return (
    <>
      {/* v1 .sx-cloud: the account (or the sign-in) and the note under it */}
      <Stack part="settings.cloud">
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
            <SettingsGroup part="grid-client.signin">
              {/* v1 .cg-signin: the title and its line inside the box, the address and Sign in under them */}
              <SettingsBlock
                part="settings.cloud.signin"
                title={t('grid-client.signin.title')}
                description={
                  <>
                    {t('grid-client.signin.description.pre')}
                    <Code>{t('grid-client.signin.command')}</Code>
                    {t('grid-client.signin.description.post')}
                  </>
                }
              >
                <SettingsInputRow>
                  <Input mono aria-label={t('grid-client.signin.grid')} value={grid()} onInput={setGrid} placeholder={DEFAULT_GRID} />
                  <Button size="sm" variant="primary" icon="lock" part="grid-client.signin.go" disabled={starting()} onClick={start}>
                    {t('grid-client.signin.go')}
                  </Button>
                </SettingsInputRow>
                <Show when={failed()}>{(why) => <Text tone="bad">{why()}</Text>}</Show>
              </SettingsBlock>
            </SettingsGroup>
          </Match>
        </Pick>
        {/* the cloud computers (wisp.machines), each with its agents to sign in to (v1 .cg-list): whenever there are any */}
        <Slot input="shell.settings:cloud" layout="contents" />
        <Show when={r()?.signedIn}>
          <MyShares client={c} />
        </Show>
        <SettingsNote part="grid-client.note" after={10}>
          {t('grid-client.note')}
        </SettingsNote>
      </Stack>
    </>
  );
}
