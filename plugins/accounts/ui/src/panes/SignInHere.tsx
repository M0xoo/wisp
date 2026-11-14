// A signed-out harness's sign-in where you picked it (v1 runner-picker.js paintSignIn, F-comp-41): in the harness ·
// model picker, "<Harness> is signed out", Sign in with a link and a code (no terminal), then Signed in. The same
// login Settings → Agents runs (`accounts.login.*`); the login landing re-checks the harness (wisp.accounts).
import { Match, onCleanup, Switch as Pick, type JSX } from 'solid-js';
import type { ExtensionProps } from '@wisp/shell/contract';
import { Button, Inline, Pill, Stack, Text, useSignal } from '@wisp/ui';
import { loginCancel, loginStart } from '../commands.ts';
import { t } from '../i18n.ts';
import { HARNESS, LOGIN, TOPIC, loginId, type HarnessRow, type LoginRow } from '../types.ts';
import { loginControl } from '../words.ts';
import { Steps } from './Steps.tsx';

const quiet = (p: Promise<unknown>): void => {
  p.catch(() => {}); // the shell's onError shows the rollback toast
};

export default function SignInHere(props: ExtensionProps): JSX.Element {
  const c = props.client;
  const peer = c.home;
  const agent = (): string => props.id ?? '';
  const scope = c.scope.child('runner-signin');
  onCleanup(() => scope.dispose());
  c.watch(peer, TOPIC, scope);
  const harnesses = useSignal(c.entities.list<HarnessRow>(HARNESS));
  const logins = useSignal(c.entities.list<LoginRow>(LOGIN));
  const h = (): HarnessRow | undefined => (harnesses() as readonly HarnessRow[]).find((x) => x.id === agent());
  const login = (): LoginRow | undefined => (logins() as readonly LoginRow[]).find((l) => l.agent === agent() && loginId(l.agent, l.account) === loginId(agent(), ''));
  const ctl = (): ReturnType<typeof loginControl> => loginControl(login(), { account: false, out: true });
  const args = (): { peer: typeof peer; agent: string; account: string } => ({ peer, agent: agent(), account: '' });
  const name = (): string => h()?.name ?? agent();
  return (
    <Stack gap="2" part="runner.signin">
      <Text weight="semibold">{t('accounts.runner.signedOut', { name: name() })}</Text>
      <Text size="sm" tone="muted">
        {t('accounts.runner.how', { name: name() })}
      </Text>
      <Inline gap="2">
        <Pick>
          <Match when={ctl() === 'cancel'}>
            <Button size="sm" variant="ghost" onClick={() => quiet(c.run(loginCancel, args()))}>
              {t('accounts.login.cancel')}
            </Button>
          </Match>
          <Match when={ctl() === 'signedIn'}>
            <Pill tone="good" icon="check" variant="plain">
              {t('accounts.login.signedIn')}
            </Pill>
          </Match>
          <Match when={ctl() === 'signIn'}>
            <Button size="sm" variant="primary" icon="lock" onClick={() => quiet(c.run(loginStart, args()))}>
              {t('accounts.login.signIn')}
            </Button>
          </Match>
        </Pick>
      </Inline>
      <Steps c={c} agent={agent()} account="" login={login()} />
    </Stack>
  );
}
