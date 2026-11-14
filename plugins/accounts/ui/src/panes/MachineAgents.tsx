// Another computer's coding agents, signed in to from here (v1 cloud.js agents, F-mach-18): under a cloud computer in
// Settings → Cloud, each harness there that signs in with its CLI, with Sign in / Cancel / Signed in and the same
// link-and-code steps as Settings → Agents. The login runs on that computer (every command goes to its peer) and stays
// there. The machine's peer comes as `id`.
import { For, Match, onCleanup, Show, Switch as Pick, type JSX } from 'solid-js';
import { entityKey, ownerOf, peerId, type EntityKey } from '@wisp/client';
import type { ExtensionProps } from '@wisp/shell/contract';
import { Button, Inline, Pill, SettingsRow, Stack, Text, useSignal } from '@wisp/ui';
import { loginCancel, loginStart } from '../commands.ts';
import { t } from '../i18n.ts';
import { HARNESS, LOGIN, TOPIC, loginId, type HarnessRow, type LoginRow } from '../types.ts';
import { loginControl, signable } from '../words.ts';
import { Steps } from './Steps.tsx';

const quiet = (p: Promise<unknown>): void => {
  p.catch(() => {}); // the shell's onError shows the rollback toast
};

export default function MachineAgents(props: ExtensionProps): JSX.Element {
  const c = props.client;
  const peer = peerId(props.id ?? c.home);
  const scope = c.scope.child('machine-agents');
  onCleanup(() => scope.dispose());
  c.watch(peer, TOPIC, scope);
  const keys = useSignal(c.entities.keys(HARNESS));
  const rows = useSignal(c.entities.list<HarnessRow>(HARNESS));
  const logins = useSignal(c.entities.list<LoginRow>(LOGIN));
  const mine = (): readonly EntityKey[] => (keys() as readonly EntityKey[]).filter((k) => ownerOf(k) === peer);
  // rows() and logins() are read so these follow every change; the rows themselves are that computer's, by key
  const list = (): HarnessRow[] => (void rows(), signable(mine().map((k) => c.entities.row<HarnessRow>(HARNESS, k)() as HarnessRow | undefined)));
  const loginOf = (agent: string): LoginRow | undefined => (void logins(), c.entities.row<LoginRow>(LOGIN, entityKey(peer, loginId(agent)))() as LoginRow | undefined);
  return (
    <Show when={list().length > 0} fallback={<Text size="sm" tone="muted">{t('accounts.machine.none')}</Text>}>
      <Stack gap="1" part="accounts.machine">
        <For each={list()}>
          {(h) => {
            const login = (): LoginRow | undefined => loginOf(h.id);
            const ctl = () => loginControl(login(), { account: false, out: h.signedIn === false });
            const args = { peer, agent: h.id, account: '' };
            return (
              <Stack gap="1">
                <SettingsRow
                  part="accounts.machine.agent"
                  title={h.name}
                  {...(h.version && { description: h.version })}
                  control={
                    <Inline gap="2">
                      <Pick>
                        <Match when={ctl() === 'cancel'}>
                          <Button size="sm" variant="ghost" onClick={() => quiet(c.run(loginCancel, args))}>
                            {t('accounts.login.cancel')}
                          </Button>
                        </Match>
                        <Match when={ctl() === 'signedIn' || (ctl() === 'none' && h.signedIn !== false)}>
                          <Pill tone="good" icon="check" variant="plain">
                            {t('accounts.login.signedIn')}
                          </Pill>
                        </Match>
                        <Match when={ctl() === 'signIn'}>
                          <Button size="sm" variant="primary" icon="lock" onClick={() => quiet(c.run(loginStart, args))} part="accounts.machine.signin">
                            {t('accounts.login.signIn')}
                          </Button>
                        </Match>
                      </Pick>
                    </Inline>
                  }
                />
                <Steps c={c} peer={peer} agent={h.id} account="" login={login()} />
              </Stack>
            );
          }}
        </For>
      </Stack>
    </Show>
  );
}
