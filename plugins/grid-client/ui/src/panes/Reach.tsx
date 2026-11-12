// Settings → Machines, under its first group (v1 cloud.js mountGridHere, .mc-grid): this computer on a wisp Grid.
// Signed out: Reach this computer from anywhere, the grid's address and Sign in and add it. Signing in: the code to
// allow. Signed in: this computer, on the grid or not, and Add to grid / Remove from grid.
import { Match, Show, Switch as Pick, type JSX } from 'solid-js';
import type { ExtensionProps } from '@wisp/shell/contract';
import { Button, Inline, Input, Link, SettingsBlock, SettingsInputRow, SettingsGroup, SettingsRow, Text } from '@wisp/ui';
import { cancelSignIn, DEFAULT_GRID, setComputer } from '../commands.ts';
import { t } from '../i18n.ts';
import { host, useCloud } from './state.ts';

export default function Reach(props: ExtensionProps): JSX.Element {
  const { c, peer, r, grid, setGrid, starting, waiting, failed, start, computerLine } = useCloud(props.client);
  return (
    <SettingsGroup part="machines.cloud" spaceAfter>
      <Pick>
        <Match when={r()?.signedIn}>
          <SettingsRow
            part="grid-client.here"
            title={t('grid-client.here.title')}
            description={computerLine()}
            control={
              <Show
                when={r()?.computer?.on}
                fallback={
                  <Button size="sm" variant="primary" icon="cloud" onClick={() => void c.run(setComputer, { peer, on: true }).catch(() => {})}>
                    {t('grid-client.here.add')}
                  </Button>
                }
              >
                <Button size="sm" variant="ghost" onClick={() => void c.run(setComputer, { peer, on: false }).catch(() => {})}>
                  {t('grid-client.here.remove')}
                </Button>
              </Show>
            }
          />
        </Match>
        <Match when={waiting()}>
          {(s) => (
            <SettingsBlock part="settings.cloud.signin" title={t('grid-client.waiting.title')} description={t('grid-client.waiting.description')}>
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
            </SettingsBlock>
          )}
        </Match>
        <Match when={true}>
          <SettingsBlock part="settings.cloud.signin" title={t('grid-client.reach.title')} description={t('grid-client.reach.description')}>
            <SettingsInputRow>
              <Input mono aria-label={t('grid-client.signin.grid')} value={grid()} onInput={setGrid} placeholder={DEFAULT_GRID} />
              <Button size="sm" variant="primary" icon="lock" part="grid-client.reach.go" disabled={starting()} onClick={start}>
                {t('grid-client.reach.go')}
              </Button>
            </SettingsInputRow>
            <Show when={failed()}>{(why) => <Text tone="bad">{why()}</Text>}</Show>
          </SettingsBlock>
        </Match>
      </Pick>
    </SettingsGroup>
  );
}
