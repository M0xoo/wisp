// Settings → Computers → Sandboxes (ADR-0047, v1 Settings → Cloud → Sandboxes): sign in to Claude once for every
// sandbox (`claude setup-token` runs here; its link opens, its code goes back; the token goes to the grid sealed,
// never kept here), the env vars every sandbox gets (names only come back), and each sandbox with whose it is,
// Open its task, Sign in to Codex there (its own device login), and Delete.
import { For, Show, createResource, createSignal, type JSX } from 'solid-js';
import { entityKey, type PeerId, type PluginClient } from '@wisp/client';
import { useShell } from '@wisp/shell';
import { Button, Callout, IconButton, Inline, Input, SettingsGroup, SettingsRow, Stack, Text } from '@wisp/ui';
import { claudeBegin, claudeCode, codexLogin, drop, env, info, logout, type ClaudeSignIn, type Info } from './commands.ts';
import { t } from './i18n.ts';
import { ownerTask, ownerWords } from './model.ts';

export default function Sandboxes(props: { readonly client: PluginClient }): JSX.Element {
  const c = props.client;
  const shell = useShell();
  const peer = c.home as PeerId;
  const say = t as (k: string, v?: Readonly<Record<string, string | number>>) => string;
  const [data, { mutate, refetch }] = createResource(() => c.run(info, { peer }).catch((): Info | undefined => undefined));
  const claudeOn = (): boolean => !!data()?.logins.includes('claude');
  // the Claude sign-in: its link, then the code
  const [flow, setFlow] = createSignal<ClaudeSignIn | undefined>(undefined);
  const [code, setCode] = createSignal('');
  const begin = (): void => {
    setFlow({ state: 'waiting' });
    void c.run(claudeBegin, { peer }).then(setFlow, (e: unknown) => setFlow({ state: 'failed', error: e instanceof Error ? e.message : String(e) }));
  };
  const finish = (): void => {
    const v = code().trim();
    if (!v) return;
    setCode('');
    void c.run(claudeCode, { peer, code: v }).then(
      (r) => {
        setFlow(r.state === 'done' ? undefined : r);
        void refetch();
      },
      () => undefined,
    );
  };
  // env vars: the name shows at once, the value goes and never comes back
  const [key, setKey] = createSignal('');
  const [value, setValue] = createSignal('');
  const setVar = (k: string, v: string): void => {
    const d = data();
    if (d) mutate({ ...d, env: v ? [...new Set([...d.env, k])] : d.env.filter((x) => x !== k) });
    void c.run(env, { peer, key: k, value: v }).then(mutate, () => void refetch());
  };
  const addVar = (): void => {
    const k = key().trim();
    if (!k || !value()) return;
    setKey('');
    setValue('');
    setVar(k, value());
  };
  const remove = (machine: string): void => {
    const d = data();
    if (d) mutate({ ...d, sandboxes: d.sandboxes.filter((s) => s.machine !== machine) });
    void c.run(drop, { peer, machine }).catch(() => void refetch());
  };
  const crewName = (id: string): string =>
    (c.entities.list<{ id: string; name?: string; body?: { name?: string } }>('crew_member')() as readonly { id: string; name?: string; body?: { name?: string } }[]).find(
      (m) => m.id === id || m.id.endsWith(`:${id}`),
    )?.body?.name ?? id;
  const codex = (sbPeer: string): void => {
    void c.run(codexLogin, { peer: sbPeer as PeerId }).then(
      (r) => r.url && shell.toast.show(`${r.url}${r.code ? `  ·  ${r.code}` : ''}`),
      () => undefined,
    );
  };
  return (
    <>
      <Text as="p" tone="muted" part="sandbox.lede">
        {t('sandbox.lede')}
      </Text>
      <Show when={data() && !data()?.enabled}>
        <Callout tone="warn" title={t('sandbox.off')} part="sandbox.off">
          {data()?.why ?? ''}
        </Callout>
      </Show>
      <SettingsGroup part="sandbox.signin" title={t('sandbox.signin')} description={t('sandbox.signin.hint')}>
        <SettingsRow
          part="sandbox.claude"
          title={t('sandbox.claude')}
          description={t(claudeOn() ? 'sandbox.claude.on' : 'sandbox.claude.off')}
          control={
            <Show
              when={claudeOn()}
              fallback={
                <Button size="sm" variant="primary" loading={flow()?.state === 'waiting'} disabled={!data()?.enabled} onClick={begin}>
                  {t('sandbox.claude.go')}
                </Button>
              }
            >
              <Button size="sm" variant="ghost" onClick={() => void c.run(logout, { peer, agent: 'claude' }).then(mutate, () => undefined)}>
                {t('sandbox.claude.out')}
              </Button>
            </Show>
          }
        />
        <Show when={flow()?.state === 'link' && flow()?.link}>
          {(link) => (
            <Stack gap="2" part="sandbox.claude.flow">
              <span>
                <Button size="sm" variant="secondary" icon="external" onClick={() => void shell.platform.openExternal(link())}>
                  {t('sandbox.claude.open')}
                </Button>
              </span>
              <Inline gap="2">
                <Input size="sm" value={code()} onInput={setCode} placeholder={t('sandbox.claude.code')} aria-label={t('sandbox.claude.code')} onKeyDown={(e) => e.key === 'Enter' && finish()} />
                <Button size="sm" variant="primary" disabled={!code().trim()} onClick={finish}>
                  {t('sandbox.claude.send')}
                </Button>
              </Inline>
            </Stack>
          )}
        </Show>
        <Show when={flow()?.state === 'failed'}>
          <Callout tone="bad" title={t('sandbox.claude.failed')} part="sandbox.claude.error">
            {flow()?.error ?? ''}
          </Callout>
        </Show>
      </SettingsGroup>
      <SettingsGroup part="sandbox.env" title={t('sandbox.env')} description={t('sandbox.env.hint')}>
        <For each={data()?.env ?? []} fallback={<SettingsRow part="sandbox.env.none" title={t('sandbox.env.none')} control={<span />} />}>
          {(k) => (
            <SettingsRow
              part="sandbox.env.row"
              title={k}
              control={<IconButton icon="trash" size="sm" variant="ghost" label={say('sandbox.env.remove', { name: k })} onClick={() => setVar(k, '')} />}
            />
          )}
        </For>
        <Inline gap="2" part="sandbox.env.add">
          <Input size="sm" value={key()} onInput={(v) => setKey(v.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))} placeholder={t('sandbox.env.key')} aria-label={t('sandbox.env.key')} />
          <Input
            size="sm"
            type="password"
            value={value()}
            onInput={setValue}
            placeholder={t('sandbox.env.value')}
            aria-label={t('sandbox.env.value')}
            onKeyDown={(e) => e.key === 'Enter' && addVar()}
          />
          <Button size="sm" variant="secondary" disabled={!key().trim() || !value()} onClick={addVar}>
            {t('sandbox.env.add')}
          </Button>
        </Inline>
      </SettingsGroup>
      <SettingsGroup part="sandbox.list" title={t('sandbox.list')}>
        <For each={data()?.sandboxes ?? []} fallback={<SettingsRow part="sandbox.list.none" title={t('sandbox.list.none')} control={<span />} />}>
          {(s) => (
            <SettingsRow
              part="sandbox.row"
              title={s.name}
              description={`${ownerWords(s.owner, say, crewName)} · ${s.state}`}
              control={
                <Inline gap="1">
                  <Show when={ownerTask(s.owner)}>
                    {(task) => (
                      <Button size="sm" variant="ghost" onClick={() => c.navigate({ t: 'openTask', id: (task().includes(':') ? task() : entityKey(s.peer as PeerId, task())) as never })}>
                        {t('sandbox.list.open')}
                      </Button>
                    )}
                  </Show>
                  <Show when={s.peer}>
                    <Button size="sm" variant="ghost" onClick={() => codex(s.peer)}>
                      {t('sandbox.list.codex')}
                    </Button>
                  </Show>
                  <IconButton icon="trash" size="sm" variant="ghost" label={say('sandbox.list.remove', { name: s.name })} onClick={() => remove(s.machine)} />
                </Inline>
              }
            />
          )}
        </For>
      </SettingsGroup>
    </>
  );
}
