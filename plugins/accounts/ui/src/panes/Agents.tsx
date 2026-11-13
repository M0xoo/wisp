// Settings → Agents (v1 settings.js paintAgents, agent-login.js; design/v1-reference/settings.agents): the
// harnesses wisp found, each with its state, version and models; Claude and Codex with their extra accounts
// ("Add another … account"); a CLI sign-in's steps (the page to open, the code to paste); a key for harnesses
// that take one (opencode); Install for one wisp can install; the notice when a harness's program changed;
// git and the GitHub CLI that Ship it needs; Re-check. Every write shows at once.
import { createMemo, createSignal, For, Match, onCleanup, Show, Switch as Pick, type JSX } from 'solid-js';
import { entityKey, type PluginClient } from '@wisp/client';
import { useShell } from '@wisp/shell';
import {
  Button,
  Dialog,
  Inline,
  Input,
  Link,
  Menu,
  Pill,
  SelectSetting,
  SettingsGroup,
  SettingsInset,
  SettingsInsetAdd,
  SettingsInsetRow,
  SettingsRow,
  Stack,
  Switch,
  Text,
  useSignal,
} from '@wisp/ui';
import { fromRow, text } from '../source.ts';
import { Steps } from './Steps.tsx';
import { addAccount, install, keyRemove, keySet, loginCancel, loginInput, loginStart, logout, recheck, removeAccount, setAsk, trust } from '../commands.ts';
import { t } from '../i18n.ts';
import { ACCOUNT, HARNESS, KEY, LOGIN, PLACE, TOOL, TOPIC, loginId, type AccountRow, type HarnessRow, type KeyRow, type LoginRow, type PlaceRow, type ToolRow } from '../types.ts';
import { accountLine, changeText, changeTip, harnessLine, harnessState, loginControl, loginStep, masked, present, site, stillChanged } from '../words.ts';

const quiet = (p: Promise<unknown>): void => {
  p.catch(() => {}); // the shell's onError shows the rollback toast
};

type Rows<T> = () => readonly T[];

function useRows<T>(c: PluginClient, kind: string): Rows<T> {
  const list = useSignal(c.entities.list<T>(kind));
  return () => list() as readonly T[];
}

/** The keys a harness signs in with (opencode Zen, Go…): set, test, remove; never the key itself. */
function Keys(props: { readonly c: PluginClient; readonly h: HarnessRow; readonly keys: readonly KeyRow[]; readonly onClose: () => void }): JSX.Element {
  const [typed, setTyped] = createSignal<Record<string, string>>({});
  const peer = props.c.home;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && props.onClose()}
      title={t('accounts.keys.title', { name: props.h.name })}
      description={t('accounts.keys.where', { site: site(props.keys[0]?.url ?? '') })}
      part="accounts.keys"
    >
      <Stack gap="1">
        <For each={props.keys}>
          {(k) => (
            <SettingsRow
              part="accounts.key"
              title={k.name}
              description={k.set ? t('accounts.keys.saved', { hint: masked(k) }) : t('accounts.keys.none')}
              wideControl
              control={
                <Inline gap="2">
                  <Input
                    size="sm"
                    mono
                    type="password"
                    aria-label={t('accounts.keys.input', { name: k.name })}
                    placeholder={k.set ? t('accounts.keys.replace') : t('accounts.keys.paste')}
                    value={typed()[k.provider] ?? ''}
                    onInput={(v) => setTyped({ ...typed(), [k.provider]: v })}
                  />
                  <Button
                    size="sm"
                    disabled={(typed()[k.provider] ?? '').trim() === ''}
                    onClick={() => {
                      quiet(props.c.run(keySet, { peer, agent: k.agent, provider: k.provider, key: (typed()[k.provider] ?? '').trim() }));
                      setTyped({ ...typed(), [k.provider]: '' });
                    }}
                  >
                    {t('accounts.keys.save')}
                  </Button>
                  <Show when={k.set}>
                    <Button size="sm" variant="ghost" onClick={() => quiet(props.c.run(keyRemove, { peer, agent: k.agent, provider: k.provider }))}>
                      {t('accounts.keys.remove')}
                    </Button>
                  </Show>
                </Inline>
              }
            />
          )}
        </For>
      </Stack>
    </Dialog>
  );
}

export default function Agents(props: { readonly client: PluginClient }): JSX.Element {
  const c = props.client;
  // each harness's mark, as its own plugin registered it (HarnessUiDef.logo: plugins/claude/ui, …)
  const marks = useSignal(useShell().harnesses());
  const logoOf = (id: string): string | undefined => marks().find((m) => m.id === id)?.logo;
  const peer = c.home;
  const scope = c.scope.child('agents-pane');
  onCleanup(() => scope.dispose());
  c.watch(peer, TOPIC, scope);
  const harnesses = useRows<HarnessRow>(c, HARNESS);
  const accounts = useRows<AccountRow>(c, ACCOUNT);
  const logins = useRows<LoginRow>(c, LOGIN);
  const keys = useRows<KeyRow>(c, KEY);
  const tools = useRows<ToolRow>(c, TOOL);
  const place = useSignal(c.entities.row<PlaceRow>(PLACE, entityKey(peer, 'this')));
  const [keysOf, setKeysOf] = createSignal<HarnessRow | undefined>();
  const [rechecking, setRechecking] = createSignal(false);
  const sorted = createMemo(() => [...harnesses()].sort((a, b) => a.ord - b.ord));
  const login = (agent: string, account = ''): LoginRow | undefined => logins().find((l) => l.agent === agent && loginId(l.agent, l.account) === loginId(agent, account));
  const accs = (agent: string): AccountRow[] =>
    accounts()
      .filter((a) => a.agent === agent)
      .sort((a, b) => a.ord - b.ord);
  const keysFor = (agent: string): KeyRow[] => keys().filter((k) => k.agent === agent);

  const signControl = (h: HarnessRow, account: string, isAccount: boolean): JSX.Element => {
    const ctl = (): ReturnType<typeof loginControl> => loginControl(login(h.id, account), { account: isAccount, out: h.signedIn === false });
    const args = { peer, agent: h.id, account };
    return (
      <Pick>
        <Match when={ctl() === 'cancel'}>
          <Button size="sm" variant="ghost" onClick={() => quiet(c.run(loginCancel, args))}>
            {t('accounts.login.cancel')}
          </Button>
        </Match>
        <Match when={ctl() === 'signIn'}>
          <Button size="sm" onClick={() => quiet(c.run(loginStart, args))}>
            {t('accounts.login.signIn')}
          </Button>
        </Match>
        <Match when={ctl() === 'signedIn'}>
          <Inline gap="3">
            <Pill tone="good" icon="check" variant="plain">
              {t('accounts.login.signedIn')}
            </Pill>
            <Button size="xs" variant="ghost" onClick={() => quiet(c.run(logout, args))}>
              {t('accounts.login.signOut')}
            </Button>
          </Inline>
        </Match>
      </Pick>
    );
  };

  const addAnother = (h: HarnessRow): void => {
    const n = accs(h.id).length + 1;
    quiet(c.run(addAccount, { peer, agent: h.id, id: `a${Date.now().toString(36)}`, label: t('accounts.account.n', { brand: h.brand ?? h.name, n }), kind: 'personal' }));
  };

  return (
    <>
      {/* v1 .sx-agents: one row per harness, lines between; its accounts in a box under it; then GitHub (and git while it's missing) */}
      <SettingsGroup part="accounts.harnesses">
        <For each={sorted()}>
          {(h) => {
            const state = () => harnessState(h);
            return (
              <>
                <SettingsRow
                  part="accounts.harness"
                  title={h.name}
                  {...(logoOf(h.id) && { logo: logoOf(h.id) as string })}
                  description={harnessLine(h, accs(h.id).length)}
                  control={
                    <Inline gap="3">
                      <Show when={h.signIn === 'key' && present(h)}>
                        <Button size="sm" variant="primary" icon="lock" part="accounts.keys.open" onClick={() => setKeysOf(h)}>
                          {keysFor(h.id).some((k) => k.set) ? t('accounts.keys.edit') : t('accounts.keys.add')}
                        </Button>
                      </Show>
                      <Show when={h.signIn === 'cli' && present(h) && (!h.brand || accs(h.id).length <= 1)}>{signControl(h, '', false)}</Show>
                      <Show when={!present(h) && h.installable === true}>
                        <Button size="sm" disabled={h.installing === true} onClick={() => quiet(c.run(install, { peer, agent: h.id }))}>
                          {h.installing === true ? t('accounts.installing') : t('accounts.install')}
                        </Button>
                      </Show>
                      <Pill tone={state().tone} dot variant="plain">
                        {state().label}
                      </Pill>
                    </Inline>
                  }
                />
                <Show when={stillChanged(h) && h.changed}>
                  {(ch) => (
                    <SettingsRow
                      part="accounts.changed"
                      title={changeText(h.name, ch())}
                      description={<span title={changeTip(ch())}>{t('accounts.change.why')}</span>}
                      control={
                        <Button size="sm" onClick={() => quiet(c.run(trust, { peer, agent: h.id }))}>
                          {t('accounts.change.trust')}
                        </Button>
                      }
                    />
                  )}
                </Show>
                <Steps c={c} agent={h.id} account="" login={login(h.id)} />
                <Show when={h.brand && present(h)}>
                  <SettingsInset part="settings.accounts">
                    <For each={accs(h.id).length > 1 ? accs(h.id) : []}>
                      {(a) => (
                        <SettingsInsetRow
                          part="accounts.account"
                          title={a.label}
                          description={accountLine(a)}
                          state={a.state === 'limit' ? a.why || t('accounts.state.limit') : a.state === 'signedOut' ? t('accounts.state.signedOut') : undefined}
                          control={
                            <Inline gap="2">
                              {signControl(h, a.id, true)}
                              <Show when={!a.default}>
                                <Menu
                                  trigger={{ icon: 'dots', 'aria-label': t('accounts.account.more', { name: a.label }), variant: 'ghost', size: 'sm' }}
                                  items={[
                                    { value: 'out', label: t('accounts.login.signOut'), icon: 'lock' },
                                    { kind: 'separator' },
                                    { value: 'remove', label: t('accounts.account.remove'), icon: 'trash', danger: true },
                                  ]}
                                  onSelect={(v) => quiet(v === 'out' ? c.run(logout, { peer, agent: h.id, account: a.id }) : c.run(removeAccount, { peer, agent: h.id, account: a.id }))}
                                />
                              </Show>
                            </Inline>
                          }
                        />
                      )}
                    </For>
                    <SettingsInsetAdd part="accounts.add" label={t('accounts.account.add', { brand: h.brand ?? h.name })} onClick={() => addAnother(h)} />
                  </SettingsInset>
                </Show>
              </>
            );
          }}
        </For>
        {/* git only while it's missing; GitHub always (v1: "For pushing branches and opening pull requests") */}
        <For each={tools().filter((x) => x.id === 'gh' || !x.installed)}>
          {(x) => (
            <SettingsRow
              part="accounts.tool"
              title={x.id === 'gh' ? t('accounts.tool.github') : x.name}
              icon={x.id === 'gh' ? 'github' : 'branch'}
              description={x.installed ? t('accounts.tool.gh') : (x.setup?.tip ?? t('accounts.tool.missing'))}
              control={
                <Show when={!x.installed}>
                  <Pill tone="bad" dot variant="plain">
                    {t('accounts.state.notFound')}
                  </Pill>
                </Show>
              }
            />
          )}
        </For>
      </SettingsGroup>
      <SettingsGroup part="accounts.watch">
        {/* v1 Lean Claude Code runs (`runtime.leanRuns`): off, wisp's side runs, every run */}
        <SelectSetting
          part="settings.leanRuns"
          title={t('accounts.lean.title')}
          description={t('accounts.lean.description')}
          source={text(fromRow(c, 'runtime.leanRuns'), 'on')}
          items={(['off', 'on', 'all'] as const).map((v) => ({ value: v, label: t(`accounts.lean.${v}`) }))}
        />
        <SettingsRow
          part="settings.harnessAsk"
          title={t('accounts.ask.title')}
          description={t('accounts.ask.description')}
          control={<Switch aria-label={t('accounts.ask.title')} checked={place()?.ask ?? false} onChange={(on) => quiet(c.run(setAsk, { peer, on }))} />}
        />
      </SettingsGroup>
      {/* v1: Installed something new? Re-check, last */}
      <SettingsGroup part="accounts.recheck.group">
        <SettingsRow
          part="accounts.recheck"
          title={t('accounts.recheck.title')}
          description={t('accounts.recheck.hint')}
          control={
            <Button
              size="sm"
              variant="ghost"
              icon="replay"
              disabled={rechecking()}
              onClick={() => {
                setRechecking(true);
                c.run(recheck, { peer }).finally(() => setRechecking(false));
              }}
            >
              {rechecking() ? t('accounts.recheck.running') : t('accounts.recheck')}
            </Button>
          }
        />
      </SettingsGroup>
      <Show when={keysOf()}>{(h) => <Keys c={c} h={h()} keys={keysFor(h().id)} onClose={() => setKeysOf(undefined)} />}</Show>
    </>
  );
}
