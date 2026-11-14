// A CLI sign-in's steps (v1 agent-login.js loginPanel): the page to open, the code, the paste box. Settings → Agents
// and the harness picker's sign-in (SignInHere) show the same.
import { createSignal, Match, Show, Switch as Pick, type JSX } from 'solid-js';
import type { PeerId, PluginClient } from '@wisp/client';
import { Button, Inline, Input, Link, Stack, Text } from '@wisp/ui';
import { loginInput } from '../commands.ts';
import { t } from '../i18n.ts';
import type { LoginRow } from '../types.ts';
import { loginStep, site } from '../words.ts';

const quiet = (p: Promise<unknown>): void => {
  p.catch(() => {}); // the shell's onError shows the rollback toast
};

/** A sign-in under way: the page to open, the code, the paste box. */
/** `peer`: the computer the sign-in runs on (a cloud computer's agents, signed in to from here); this wisp's by default. */
export function Steps(props: { readonly c: PluginClient; readonly agent: string; readonly account: string; readonly login: LoginRow | undefined; readonly peer?: PeerId }): JSX.Element {
  const [code, setCode] = createSignal('');
  const step = () => loginStep(props.agent, props.login);
  const peer = props.peer ?? props.c.home;
  return (
    <Pick>
      <Match when={step().kind === 'failed'}>
        <Text tone="bad" part="accounts.login.failed">
          {(step() as { error: string }).error}
        </Text>
      </Match>
      <Match when={step().kind === 'steps'}>
        {(() => {
          const s = step() as { url: string; code: string; paste: boolean; checking: boolean };
          return (
            <Stack gap="2" part="accounts.login.steps">
              <Show when={s.url}>
                <Text>
                  {t('accounts.login.open')}{' '}
                  <Link href={s.url} external>
                    {site(s.url)}
                  </Link>
                </Text>
              </Show>
              <Show when={s.code}>
                <Text>{t('accounts.login.code', { code: s.code })}</Text>
              </Show>
              <Show when={s.paste}>
                <Inline gap="2">
                  <Input size="sm" mono placeholder={t('accounts.login.paste')} value={code()} onInput={setCode} />
                  <Button size="sm" disabled={code().trim() === ''} onClick={() => quiet(props.c.run(loginInput, { peer, agent: props.agent, account: props.account, code: code().trim() }))}>
                    {t('accounts.login.send')}
                  </Button>
                </Inline>
              </Show>
              <Show when={s.checking}>
                <Text tone="muted">{t('accounts.login.checking')}</Text>
              </Show>
            </Stack>
          );
        })()}
      </Match>
    </Pick>
  );
}

