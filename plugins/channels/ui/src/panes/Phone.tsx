// Settings → Phone (v1 web/js/features/phone.js openPhone, F-chan-13): one pane that sets up ntfy, Telegram, Slack,
// Discord, GitHub and email. Each channel is a group: its name and how it's used, where it stands, Test and its
// switch; then its setup steps (ticked as they're done), its fields (a secret shows only as saved), its link code,
// and what its service or the last test said. Every save shows at once and is put back if the hub refuses it.
import { createMemo, createSignal, For, onMount, Show, type JSX } from 'solid-js';
import type { PluginClient } from '@wisp/client';
import { useShell } from '@wisp/shell';
import { Button, CopyCommand, Inline, Input, Pill, SettingsBlock, SettingsGroup, SettingsNote, SettingsRow, Skeleton, Stack, Steps, Switch, Text } from '@wisp/ui';
import { phoneStatus, setupChannel, testChannel } from '../commands.ts';
import { t, type Key } from '../i18n.ts';
import { fieldsFor, isTransport, linkLine, marked, optimistic, STATE_KEY, stepsOf, testNote, toneOf, withRow, type FieldDef } from '../lib.ts';
import { ORDER, type ChannelSetup, type PhoneStatus, type SetupArgs, type Tested } from '../types.ts';

const nameOf = (transport: string): string => (isTransport(transport) ? t(`channels.name.${transport}` as Key) : transport);

function howOf(row: ChannelSetup, cloud: boolean): string {
  if (!isTransport(row.transport)) return '';
  return t(row.transport === 'discord' && cloud ? 'channels.how.discord.cloud' : (`channels.how.${row.transport}` as Key));
}

interface ChannelProps {
  readonly row: ChannelSetup;
  readonly cloud: boolean;
  readonly testing: boolean;
  readonly tested: Tested | undefined;
  readonly onSave: (a: Omit<SetupArgs, 'transport'>) => void;
  readonly onTest: () => void;
  readonly onCopy: (text: string) => void;
}

/** A secret field: never filled with what's saved; a paste or Enter saves it, and the box empties. */
function SecretField(props: { readonly row: ChannelSetup; readonly f: FieldDef; readonly onSave: ChannelProps['onSave'] }): JSX.Element {
  const [typed, setTyped] = createSignal('');
  const saved = (): boolean => props.row.saved.includes(props.f.key);
  const commit = (): void => {
    const v = typed().trim();
    if (v === '') return;
    setTyped('');
    props.onSave({ secrets: { [props.f.key]: v } });
  };
  return (
    <SettingsRow
      part="channels.field"
      title={t(props.f.label)}
      wideControl
      control={
        <Inline gap="2">
          <Input
            size="sm"
            mono
            type="password"
            autocomplete="off"
            spellcheck={false}
            aria-label={`${nameOf(props.row.transport)} · ${t(props.f.label)}`}
            placeholder={saved() ? t('channels.saved') : props.f.placeholder ? t(props.f.placeholder) : ''}
            value={typed()}
            onInput={setTyped}
            onChange={commit}
            onKeyDown={(e) => e.key === 'Enter' && commit()}
          />
          <Show when={saved()}>
            <Button size="sm" variant="ghost" part="channels.field.remove" title={t('channels.remove.title', { field: t(props.f.label) })} onClick={() => props.onSave({ secrets: { [props.f.key]: '' } })}>
              {t('channels.remove')}
            </Button>
          </Show>
        </Inline>
      }
    />
  );
}

function TextField(props: { readonly row: ChannelSetup; readonly f: FieldDef; readonly onSave: ChannelProps['onSave'] }): JSX.Element {
  const value = (): string => {
    const v = props.row.settings[props.f.key];
    return typeof v === 'string' ? v : '';
  };
  const commit = (v: string): void => {
    if (v.trim() !== value()) props.onSave({ settings: { [props.f.key]: v.trim() } });
  };
  return (
    <SettingsRow
      part="channels.field"
      title={t(props.f.label)}
      wideControl
      control={
        <Input
          size="sm"
          mono
          spellcheck={false}
          aria-label={`${nameOf(props.row.transport)} · ${t(props.f.label)}`}
          placeholder={props.f.placeholder ? t(props.f.placeholder) : ''}
          value={value()}
          onChange={commit}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget instanceof HTMLInputElement && commit(e.currentTarget.value)}
        />
      }
    />
  );
}

function BoolField(props: { readonly row: ChannelSetup; readonly f: FieldDef; readonly onSave: ChannelProps['onSave'] }): JSX.Element {
  return (
    <SettingsRow
      part="channels.field"
      title={t(props.f.label)}
      control={<Switch aria-label={t(props.f.label)} checked={props.row.settings[props.f.key] === true} onChange={(on) => props.onSave({ settings: { [props.f.key]: on } })} />}
    />
  );
}

function Channel(props: ChannelProps): JSX.Element {
  const name = (): string => nameOf(props.row.transport);
  const usable = (): boolean => props.row.installed && !(props.row.transport === 'email' && !props.cloud);
  const steps = () =>
    marked(stepsOf(props.row, props.cloud, props.tested?.outcome === 'sent')).map((s) => ({ title: t(s.title), status: s.status, ...(s.detail !== undefined && { detail: t(s.detail) }) }));
  const note = () => (props.tested ? testNote(props.tested) : undefined);
  return (
    <SettingsGroup part="channels.channel">
      <SettingsRow
        part="channels.channel.head"
        title={name()}
        description={howOf(props.row, props.cloud)}
        keepRight
        control={
          <Inline gap="2">
            <Pill part="channels.state" tone={props.row.installed ? toneOf(props.row.state) : 'neutral'} dot live={props.row.state === 'checking'}>
              {props.row.installed ? t(STATE_KEY[props.row.state]) : t('channels.state.absent')}
            </Pill>
            <Button size="sm" variant="ghost" icon="send" part="channels.test" title={t('channels.test.title', { name: name() })} loading={props.testing} disabled={!props.row.enabled} onClick={() => props.onTest()}>
              {t('channels.test')}
            </Button>
            <Switch aria-label={t('channels.on', { name: name() })} checked={props.row.enabled} disabled={!usable()} onChange={(on) => props.onSave({ enabled: on })} />
          </Inline>
        }
      />
      <Show when={usable()} fallback={<Show when={props.row.transport === 'email' && props.row.installed}><SettingsNote part="channels.email.cloud" boxed>{t('channels.email.cloud')}</SettingsNote></Show>}>
        <SettingsBlock part="channels.steps" title={t('channels.step.title')}>
          <Steps part="channels.steps.list" items={steps()} />
        </SettingsBlock>
        <For each={fieldsFor(props.row, props.cloud)}>
          {(f) => (f.kind === 'bool' ? <BoolField row={props.row} f={f} onSave={props.onSave} /> : f.secret ? <SecretField row={props.row} f={f} onSave={props.onSave} /> : <TextField row={props.row} f={f} onSave={props.onSave} />)}
        </For>
        <Show when={linkLine(props.row)}>
          {(line) => (
            <SettingsRow part="channels.link" title={t('channels.link')} description={t('channels.link.hint')} control={<CopyCommand part="channels.link.code" bare command={line()} label={t('channels.copy')} onCopy={props.onCopy} />} />
          )}
        </Show>
        <Show when={props.row.linked > 0 || props.row.who !== undefined}>
          <SettingsNote part="channels.who" boxed>
            {props.row.transport === 'email' && props.row.who ? t('channels.address', { who: props.row.who }) : props.row.who ? t('channels.linkedTo', { who: props.row.who }) : t('channels.linked', { count: props.row.linked })}
          </SettingsNote>
        </Show>
        <Show when={props.row.state === 'failing' && props.row.error}>
          {(e) => (
            <SettingsNote part="channels.error" boxed>
              <Text tone="bad">{e()}</Text>
            </SettingsNote>
          )}
        </Show>
        <Show when={note()}>
          {(n) => (
            <SettingsNote part="channels.tested" boxed>
              <Text tone={n().tone}>{t(n().key, n().error !== undefined ? { error: n().error ?? '' } : undefined)}</Text>
            </SettingsNote>
          )}
        </Show>
      </Show>
    </SettingsGroup>
  );
}

/** While channels.status answers: the six groups' heads, so nothing moves when they fill in. */
function Loading(): JSX.Element {
  return (
    <For each={ORDER}>
      {(tr) => (
        <SettingsGroup part="channels.channel">
          <SettingsRow part="channels.channel.head" title={nameOf(tr)} description={t(`channels.how.${tr}` as Key)} control={<Skeleton shape="pill" width="1/4" />} />
        </SettingsGroup>
      )}
    </For>
  );
}

/** The pane's state: the hub's answer (channels.status), each save shown at once, the tests' last word. */
function usePhone(c: PluginClient) {
  const shell = useShell();
  const peer = c.home;
  const [status, setStatus] = createSignal<PhoneStatus | undefined>();
  const [testing, setTesting] = createSignal<string | undefined>();
  const [tested, setTested] = createSignal<Readonly<Record<string, Tested>>>({});
  const latest: Record<string, number> = {}; // per channel: the last save sent, so an older answer never lands over a newer change
  const inflight: Record<string, number> = {}; // per channel: saves not answered yet
  // a reload never lands over a row with a save on its way: that row's answer is newer than this read
  const reload = (): void => {
    c.run(phoneStatus, { peer }).then(
      (next) => setStatus((now) => ({ ...next, channels: next.channels.map((x) => ((inflight[x.transport] ?? 0) > 0 ? (now?.channels.find((y) => y.transport === x.transport) ?? x) : x)) })),
      () => {},
    );
  };
  onMount(reload);
  const put = (row: ChannelSetup): void => {
    setStatus((now) => (now ? withRow(now, row) : now));
  };
  // shown at once in the pane's copy; the hub's answer replaces it, a refusal puts the row back (the shell toasts why)
  const save = (transport: string, a: Omit<SetupArgs, 'transport'>): void => {
    const s = status();
    const was = s?.channels.find((x) => x.transport === transport);
    if (!s || !was) return;
    const n = (latest[transport] = (latest[transport] ?? 0) + 1);
    put(optimistic(was, { transport, ...a }, s.cloud));
    if (a.enabled === false || a.secrets !== undefined) setTested(({ [transport]: _gone, ...rest }) => rest);
    inflight[transport] = (inflight[transport] ?? 0) + 1;
    const settled = (): void => {
      inflight[transport] = (inflight[transport] ?? 1) - 1;
    };
    c.run(setupChannel, { peer, transport, ...a }).then(
      (row) => {
        settled();
        if (latest[transport] === n) put(row);
      },
      () => {
        settled();
        if (latest[transport] === n) put(was);
        reload(); // a later save may have shown over it: what the hub holds now settles it
      },
    );
  };
  const test = (transport: string): void => {
    setTesting(transport);
    c.run(testChannel, { peer, channel: transport }).then(
      (out) => {
        setTesting(undefined);
        const mine = out.find((x) => x.channel === transport);
        if (mine) setTested((all) => ({ ...all, [transport]: mine }));
        reload(); // the test is also its health: Working or Not working
      },
      () => setTesting(undefined),
    );
  };
  const copy = (text: string): void => {
    void navigator.clipboard?.writeText(text).then(
      () => shell.toast.show(t('channels.copied')),
      () => {},
    );
  };
  return { status, testing, tested, save, test, copy };
}

export default function Phone(props: { readonly client: PluginClient }): JSX.Element {
  const p = usePhone(props.client);
  const names = createMemo(() => (p.status()?.channels ?? []).map((x) => x.transport));
  return (
    <Stack part="settings.phone">
      <SettingsNote part="channels.lede" after={8}>
        {t('channels.lede')}
      </SettingsNote>
      <Show when={p.status()} fallback={<Loading />}>
        {(s) => (
          // keyed by name: a row's new answer repaints it in place, its group (and what's being typed) stays
          <For each={names()}>
            {(name) => (
              <Show when={s().channels.find((x) => x.transport === name)}>
                {(row) => (
                  <Channel
                    row={row()}
                    cloud={s().cloud}
                    testing={p.testing() === name}
                    tested={p.tested()[name]}
                    onSave={(a) => p.save(name, a)}
                    onTest={() => p.test(name)}
                    onCopy={p.copy}
                  />
                )}
              </Show>
            )}
          </For>
        )}
      </Show>
    </Stack>
  );
}
