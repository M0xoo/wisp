// Settings → Phone (v1 web/js/features/phone.js openPhone, F-chan-13): one pane that sets up ntfy, Telegram, Slack,
// Discord, GitHub and email. Each channel is a group: its name and how it's used, where it stands, Test and its
// switch; then its setup steps (ticked as they're done), its fields (a secret shows only as saved), its link code,
// and what its service or the last test said; then Extras.tsx's rows (Send me, Unlink, Slack's manifest, Discord's
// invite and endpoint, email's address). Every save shows at once and is put back if the hub refuses it. Where each
// channel stands comes by itself: the pane watches `plugin:wisp.channels:phone`, so Checking… turns into Working or
// Not working without a read.
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, type JSX } from 'solid-js';
import type { PluginClient } from '@wisp/client';
import { useShell } from '@wisp/shell';
import { Button, CopyCommand, Inline, Input, Pill, SettingsBlock, SettingsGroup, SettingsNote, SettingsRow, Skeleton, Stack, Steps, Switch, Text, useSignal } from '@wisp/ui';
import { channelExtra, phoneStatus, rotateChannel, setupChannel, testChannel } from '../commands.ts';
import { t, type Key } from '../i18n.ts';
import { fieldsFor, inviteOf, isTransport, linkLine, manifestText, marked, newer, optimistic, pinOf, readAgain, shown, STATE_KEY, stepsOf, testNote, toneOf, withRow, type FieldDef } from '../lib.ts';
import { ORDER, PHONE_KIND, PHONE_TOPIC, type ChannelSetup, type PhoneRow, type PhoneStatus, type SetupArgs, type Tested } from '../types.ts';
import { EmailAddress, Endpoint, Invite, Manifest, SendMe, Who, type Extras } from './Extras.tsx';

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
  readonly onCopy: (text: string, done?: Key) => void;
  readonly extras: Extras;
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
        <Manifest show={props.row.transport === 'slack'} cloud={props.cloud} extras={props.extras} />
        <For each={fieldsFor(props.row, props.cloud)}>
          {(f) => (f.kind === 'bool' ? <BoolField row={props.row} f={f} onSave={props.onSave} /> : f.secret ? <SecretField row={props.row} f={f} onSave={props.onSave} /> : <TextField row={props.row} f={f} onSave={props.onSave} />)}
        </For>
        <SendMe row={props.row} onSave={props.onSave} />
        <Endpoint row={props.row} cloud={props.cloud} onCopy={props.onCopy} />
        <Invite row={props.row} extras={props.extras} />
        <Show when={linkLine(props.row)}>
          {(line) => (
            <SettingsRow part="channels.link" title={t('channels.link')} description={t('channels.link.hint')} control={<CopyCommand part="channels.link.code" bare command={line()} label={t('channels.copy')} onCopy={props.onCopy} />} />
          )}
        </Show>
        <Who row={props.row} name={name()} onSave={props.onSave} />
        <EmailAddress row={props.row} extras={props.extras} onCopy={props.onCopy} />
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

/** The pane's state: the hub's answer (channels.status), its rows as they change (the topic), each save shown at once,
 * the tests' last word. */
function usePhone(c: PluginClient) {
  const shell = useShell();
  const peer = c.home;
  const scope = c.scope.child('phone-pane');
  onCleanup(() => scope.dispose());
  c.watch(peer, PHONE_TOPIC, scope);
  const rows = useSignal(c.entities.list<PhoneRow>(PHONE_KIND));
  const live = createMemo(() => {
    const out: Record<string, ChannelSetup> = {};
    for (const r of rows() as readonly PhoneRow[]) if (r.body) out[r.body.transport] = r.body;
    return out;
  });
  const [status, setStatus] = createSignal<PhoneStatus | undefined>();
  const [testing, setTesting] = createSignal<string | undefined>();
  const [tested, setTested] = createSignal<Readonly<Record<string, Tested>>>({});
  const [busy, setBusy] = createSignal<Readonly<Record<string, boolean>>>({});
  const [invite, setInvite] = createSignal<string | undefined>();
  const latest: Record<string, number> = {}; // per channel: the last save sent, so an older answer never lands over a newer change
  const [inflight, setInflight] = createSignal<Readonly<Record<string, number>>>({}); // per channel: saves not answered yet
  const bump = (tr: string, by: number): void => {
    setInflight((all) => ({ ...all, [tr]: Math.max(0, (all[tr] ?? 0) + by) }));
  };
  // per channel: the row the topic had when a save was answered. That row is older than the answer (the hub writes the
  // new one just after), so the answer shows until another row comes
  const [pins, setPins] = createSignal<Readonly<Record<string, string>>>({});
  const saving = (tr: string): boolean => (inflight()[tr] ?? 0) > 0 || !newer(pins()[tr], live()[tr]);
  // a reload never lands over a row with a save on its way: that row's answer is newer than this read
  const reload = (): void => {
    c.run(phoneStatus, { peer }).then(
      (next) => setStatus((now) => ({ ...next, channels: next.channels.map((x) => (saving(x.transport) ? (now?.channels.find((y) => y.transport === x.transport) ?? x) : x)) })),
      () => {},
    );
  };
  onMount(reload);
  // a row whose change can change what only channels.status says (a new link code, the endpoint): read once more
  let seen: Record<string, ChannelSetup> = {};
  createEffect(
    on(live, (now) => {
      const again = Object.values(now).some((r) => readAgain(seen[r.transport], r) && !saving(r.transport));
      seen = now;
      const done = Object.keys(pins()).filter((tr) => newer(pins()[tr], now[tr]));
      if (done.length > 0) setPins((all) => Object.fromEntries(Object.entries(all).filter(([tr]) => !done.includes(tr))));
      if (again) reload();
    }),
  );
  const view = createMemo((): PhoneStatus | undefined => {
    const s = status();
    return s && { ...s, channels: s.channels.map((x) => shown(x, live()[x.transport], saving(x.transport)) ?? x) };
  });
  const put = (row: ChannelSetup): void => {
    setStatus((now) => (now ? withRow(now, row) : now));
  };
  // shown at once in the pane's copy; the hub's answer replaces it, a refusal puts the row back (the shell toasts why)
  const save = (transport: string, a: Omit<SetupArgs, 'transport'>): void => {
    const s = view();
    const was = s?.channels.find((x) => x.transport === transport);
    if (!s || !was) return;
    const n = (latest[transport] = (latest[transport] ?? 0) + 1);
    put(optimistic(was, { transport, ...a }, s.cloud));
    if (a.enabled === false || a.secrets !== undefined) setTested(({ [transport]: _gone, ...rest }) => rest);
    bump(transport, 1);
    c.run(setupChannel, { peer, transport, ...a }).then(
      (row) => {
        if (latest[transport] === n) put(row);
        setPins((all) => ({ ...all, [transport]: pinOf(live()[transport]) }));
        bump(transport, -1);
      },
      () => {
        if (latest[transport] === n) put(was);
        bump(transport, -1);
        reload(); // a later save may have shown over it: what the hub holds now settles it
      },
    );
  };
  // the test is also its health: the Phone row says Working or Not working by itself
  const test = (transport: string): void => {
    setTesting(transport);
    c.run(testChannel, { peer, channel: transport }).then(
      (out) => {
        setTesting(undefined);
        const mine = out.find((x) => x.channel === transport);
        if (mine) setTested((all) => ({ ...all, [transport]: mine }));
      },
      () => setTesting(undefined),
    );
  };
  const copy = (text: string, done: Key = 'channels.copied'): void => {
    void navigator.clipboard?.writeText(text).then(
      () => shell.toast.show(t(done)),
      () => {},
    );
  };
  const doing = (what: string, on: boolean): void => {
    setBusy((all) => ({ ...all, [what]: on }));
  };
  // Discord's invite: asked for once it's on and working (it needs the application the bot learned), never on a timer
  const discordReady = createMemo(() => {
    const d = view()?.channels.find((x) => x.transport === 'discord');
    return d?.enabled === true && (d.state === 'connected' || d.state === 'linking');
  });
  createEffect(
    on(
      discordReady, // a memo: it fires when readiness flips, not on every other channel's change
      (ready) => {
        if (!ready) return setInvite(undefined);
        c.run(channelExtra, { peer, channel: 'discord', what: 'invite' }).then(
          (v) => setInvite(inviteOf(v)),
          () => setInvite(undefined),
        );
      },
    ),
  );
  const rotated = (address: string): void => {
    setStatus((now) => {
      const e = now?.channels.find((x) => x.transport === 'email');
      return now && e ? withRow(now, { ...e, who: address }) : now;
    });
    shell.toast.show(t('channels.email.rotated'));
  };
  const extras: Extras = {
    busy: (what) => busy()[what] === true,
    invite,
    copyManifest: () => {
      doing('manifest', true);
      c.run(channelExtra, { peer, channel: 'slack', what: 'manifest' }).then(
        (m) => {
          doing('manifest', false);
          copy(manifestText(m), 'channels.manifest.copied');
        },
        () => doing('manifest', false),
      );
    },
    copyInvite: () => {
      const u = invite();
      if (u) copy(u, 'channels.invite.copied');
    },
    rotate: () => {
      doing('rotate', true);
      c.run(rotateChannel, { peer, channel: 'email' }).then(
        (r) => {
          doing('rotate', false);
          if (r.status === 200 && r.body.address) rotated(r.body.address);
          else shell.toast.show(r.body.error ?? t('channels.email.rotate'), { tone: 'error' });
        },
        () => doing('rotate', false),
      );
    },
  };
  return { status: view, testing, tested, save, test, copy, extras };
}

export default function Phone(props: { readonly client: PluginClient }): JSX.Element {
  const p = usePhone(props.client);
  const names = createMemo(() => (p.status()?.channels ?? []).map((x) => x.transport), undefined, { equals: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]) });
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
                    extras={p.extras}
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
