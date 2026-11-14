// Machines (v1 machines.js openMachines): your other computers, one card each, and how to add one. The first time:
// the three steps up front and the form open; later the steps behind How it works and the form behind Add a machine.
// Computers wisp found here (~/.ssh/config, Tailscale, known_hosts) are one click from a filled-in form. Every write
// shows at once on the card (the row's optimistic state) or on the pressed button; Remove, Stop and a restart that
// stops working agents ask first.
import { createMemo, createResource, createSignal, For, onCleanup, Show, type JSX } from 'solid-js';
import type { PluginClient } from '@wisp/client';
import { Slot, useShell } from '@wisp/shell';
import { Button, Checkbox, Dialog, Field, Inline, Input, Link, Stack, Steps, Text, useSignal, Wrap } from '@wisp/ui';
import {
  addMachine,
  connect,
  disconnect,
  discover,
  letIn,
  listMachines,
  PEER,
  removeMachine,
  STATUS,
  stopMachine,
  TOPIC,
  updateMachine,
  type MachineForm,
  type PeerBody,
  type PeerView,
  type StatusBody,
} from '../commands.ts';
import { t } from '../i18n.ts';
import { DEFAULT_PORT, foundOf, foundTitle, nameFor, portOf, removeAsk, stopAsk, type Found } from '../view.ts';
import { MachineCard, type CardAct } from './Card.tsx';

type Doc<T> = { readonly id: string; readonly body: T };
type Ask = { readonly title: string; readonly body: string; readonly ok: string; readonly danger: boolean; readonly run: () => void };
const say = t as (k: string, v?: Readonly<Record<string, string | number>>) => string;
const quiet = (p: Promise<unknown>): void => {
  p.catch(() => {}); // the shell's onError shows the rollback toast
};

/** Add and Edit (v1 form): its address and name, then Advanced (wisp's port there, a start command, connect at start). */
function MachineFormView(props: {
  readonly m?: PeerBody;
  readonly hosts: readonly Found[];
  readonly picked?: Found | undefined;
  readonly defaultCommand: string;
  readonly cancel: boolean;
  readonly onSave: (f: MachineForm) => Promise<unknown>;
  readonly onCancel: () => void;
}): JSX.Element {
  const [target, setTarget] = createSignal(props.picked?.target ?? props.m?.address ?? '');
  const [name, setName] = createSignal(props.picked?.name ?? props.m?.name ?? '');
  const [port, setPort] = createSignal(String(props.m?.port ?? DEFAULT_PORT));
  const [command, setCommand] = createSignal(props.m?.command ?? '');
  const [auto, setAuto] = createSignal(props.m?.autoConnect !== false);
  const [adv, setAdv] = createSignal(!!props.m && (props.m.port !== DEFAULT_PORT || !!props.m.command));
  const [busy, setBusy] = createSignal(false);
  const save = (): void => {
    if (!target().trim() || busy()) return;
    setBusy(true);
    const f = { address: target().trim(), name: name().trim() || nameFor(target(), props.hosts), port: portOf(port()), command: command().trim(), autoConnect: auto() };
    void props.onSave(f).finally(() => setBusy(false));
  };
  return (
    <Stack gap="3" part="machines.form">
      <Wrap gap="3" align="start">
        <Field label={t('machines.add.address')} hint={t('machines.add.address.hint')}>
          <Input mono value={target()} onInput={setTarget} placeholder={t('machines.add.address.placeholder')} spellcheck={false} autocomplete="off" autofocus />
        </Field>
        <Field label={t('machines.add.name')}>
          <Input value={name()} onInput={setName} placeholder={nameFor(target(), props.hosts)} spellcheck={false} />
        </Field>
      </Wrap>
      <Show
        when={adv()}
        fallback={
          <Inline>
            <Button size="sm" variant="ghost" icon="chevron" onClick={() => setAdv(true)} part="machines.form.advanced">
              {t('machines.advanced')}
            </Button>
          </Inline>
        }
      >
        <Wrap gap="3" align="start">
          <Field label={t('machines.port')}>
            <Input mono type="number" inputMode="numeric" value={port()} onInput={setPort} />
          </Field>
          <Field label={t('machines.command')}>
            <Input mono value={command()} onInput={setCommand} placeholder={props.defaultCommand} spellcheck={false} />
          </Field>
        </Wrap>
        <Checkbox checked={auto()} onChange={setAuto} label={t('machines.autoConnect')} />
      </Show>
      <Text size="sm" tone="muted">
        {props.m ? t('machines.form.editHint') : t('machines.form.hint')}
      </Text>
      <Inline gap="2" justify="end">
        <Show when={props.cancel}>
          <Button size="sm" variant="ghost" onClick={props.onCancel}>
            {t('machines.cancel')}
          </Button>
        </Show>
        <Button size="sm" variant="primary" {...(!props.m && { icon: 'server' as const })} disabled={!target().trim() || busy()} onClick={save} part="machines.form.save">
          {props.m ? t('machines.save') : t('machines.add.go')}
        </Button>
      </Inline>
    </Stack>
  );
}

/** How it works, for someone who has never done this: the phone app's three steps. */
function HowTo(): JSX.Element {
  return (
    <Stack gap="2" part="machines.howto">
      <Steps
        items={[
          { title: t('machines.howto.1'), detail: t('machines.howto.1.text'), status: 'pending' },
          { title: t('machines.howto.2'), detail: t('machines.howto.2.text'), status: 'pending' },
          { title: t('machines.howto.3'), detail: t('machines.howto.3.text'), status: 'pending' },
        ]}
      />
      <Text size="sm" tone="muted">
        {t('machines.howto.ts')}{' '}
        <Link href="https://tailscale.com/download" external>
          Tailscale
        </Link>{' '}
        <Link href="https://trywisp.dev/guides/connect-machines-with-tailscale.html" external>
          {t('machines.guide')}
        </Link>
      </Text>
    </Stack>
  );
}

export function MachinesDialog(props: { readonly client: PluginClient; readonly onClose: () => void; readonly withGrid?: boolean; readonly focusAdd?: boolean }): JSX.Element {
  const c = props.client;
  const peer = c.home;
  const shell = useShell();
  const scope = c.scope.child('machines-manager');
  onCleanup(() => scope.dispose());
  c.watch(peer, TOPIC, scope);
  const peers = useSignal(c.entities.list<Doc<PeerBody>>(PEER));
  const statuses = useSignal(c.entities.list<Doc<StatusBody>>(STATUS));
  const [hosts] = createResource(() => c.run(discover, { peer }).catch((): Found[] => []));
  // what the rows don't carry (Update to X, working tasks, the log): read again when a card's state moves
  const sig = createMemo(() => (statuses() as readonly Doc<StatusBody>[]).map((s) => `${s.id}:${s.body.state}`).join('|'));
  const [views, { refetch }] = createResource(sig, () => c.run(listMachines, { peer }).catch((): PeerView[] => []));
  const [editing, setEditing] = createSignal<string | null>(props.focusAdd ? '' : null);
  const [picked, setPicked] = createSignal<Found | undefined>();
  const [howto, setHowto] = createSignal(false);
  const [ask, setAsk] = createSignal<Ask | undefined>();
  // a sandbox belongs to its owner (ADR-0047): never a machine you manage here
  const list = (): PeerBody[] =>
    (peers() as readonly Doc<PeerBody>[])
      .map((p) => p.body)
      .filter((p) => !p.data?.['sandbox'])
      .sort((a, b) => a.name.localeCompare(b.name));
  const stateOf = (id: string): StatusBody | undefined => (statuses() as readonly Doc<StatusBody>[]).find((s) => s.body.id === id || s.id === id)?.body;
  const viewOf = (id: string): PeerView | undefined => views()?.find((v) => v.id === id);
  const found = (): Found[] => foundOf(hosts() ?? [], list());
  const defaultCommand = (): string => views()?.[0]?.defaultCommand ?? 'wisp';
  const copy = (cmd: string): void => void shell.platform.copy(cmd).then((ok) => ok && shell.toast.show(t('machines.copied')));
  const stop = (m: PeerBody, verb: 'restart' | 'update' | 'stop'): void => {
    const v = viewOf(m.id);
    const run = (): void =>
      quiet(
        c.run(stopMachine, { peer, id: m.id, restart: verb !== 'stop' }).then(() => {
          void refetch(); // Update to X goes once it runs this version
          if (verb === 'stop') shell.toast.show(t('machines.stopped', { name: m.name }));
        }),
      );
    const q = stopAsk({ name: m.name, working: v?.working ?? 0, verb, ...(v?.outdated && { version: v.outdated }) }, say);
    if (q) setAsk({ ...q, run });
    else run();
  };
  const act = (m: PeerBody, a: CardAct): void => {
    if (a === 'connect') quiet(c.run(connect, { peer, id: m.id }));
    else if (a === 'disconnect') quiet(c.run(disconnect, { peer, id: m.id }));
    else if (a === 'edit') setEditing(m.id);
    else if (a === 'restart' || a === 'update' || a === 'stop') stop(m, a);
    else if (a === 'remove') setAsk({ ...removeAsk(m, say), danger: true, run: () => quiet(c.run(removeMachine, { peer, id: m.id })) });
  };
  const doLetIn = (m: PeerBody, password: string): Promise<void> =>
    c.run(letIn, { peer, id: m.id, password }).then((r) => {
      if (!r.ok) throw new Error(t('machines.letin.failed'));
      shell.toast.show(t('machines.letin.done'));
    });
  const add = (f: MachineForm): Promise<unknown> =>
    c.run(addMachine, { peer, ...f }).then(() => {
      setEditing(null);
      setPicked(undefined);
    }, () => undefined);
  const save = (id: string, f: MachineForm): Promise<unknown> =>
    c.run(updateMachine, { peer, id, ...f }).then(
      () => {
        setEditing(null);
        void refetch(); // its command, port and log may change while its state doesn't
      },
      () => undefined,
    );
  const pick = (h: Found): void => {
    setPicked(h);
    setEditing(null);
    queueMicrotask(() => setEditing('')); // a fresh form, filled in; connecting still waits for the button
  };
  const addOpen = (): boolean => list().length === 0 || editing() === '';
  return (
    <>
      <Dialog open onOpenChange={(o) => !o && props.onClose()} title={t('machines.title')} description={t('machines.manage.description')} size="lg" part="machines.manage.dialog">
        <Stack gap="4">
          <Show when={props.withGrid}>
            <Slot input="shell.settings:machines" layout="contents" />
          </Show>
          <Show when={list().length === 0} fallback={<Inline><Button size="sm" variant="ghost" icon="info" onClick={() => setHowto(!howto())} part="machines.howto.open">{t('machines.howto')}</Button></Inline>}>
            <HowTo />
          </Show>
          <Show when={list().length > 0 && howto()}>
            <HowTo />
          </Show>
          <For each={list()}>
            {(m) => (
              <MachineCard
                m={m}
                s={stateOf(m.id)}
                view={viewOf(m.id)}
                onAct={(a) => act(m, a)}
                onLetIn={(p) => doLetIn(m, p)}
                onCopy={copy}
                editing={
                  <Show when={editing() === m.id}>
                    <MachineFormView m={m} hosts={hosts() ?? []} defaultCommand={defaultCommand()} cancel onSave={(f) => save(m.id, f)} onCancel={() => setEditing(null)} />
                  </Show>
                }
              />
            )}
          </For>
          <Show when={found().length > 0}>
            <Stack gap="2" part="machines.found">
              <Text weight="semibold" size="sm">
                {t('machines.found')}
              </Text>
              <Wrap gap="2">
                <For each={found()}>
                  {(h) => (
                    <Button size="sm" variant="ghost" icon="server" title={foundTitle(h, say)} onClick={() => pick(h)} part="machines.found.host">
                      {h.name}
                    </Button>
                  )}
                </For>
              </Wrap>
            </Stack>
          </Show>
          <Show
            when={addOpen()}
            fallback={
              <Inline>
                <Button size="sm" variant="ghost" icon="plus" onClick={() => setEditing('')} part="machines.add.open">
                  {t('machines.add.new')}
                </Button>
              </Inline>
            }
          >
            <Stack gap="2" part="machines.add">
              <Text weight="semibold">{list().length ? t('machines.add.another') : t('machines.add.first')}</Text>
              <MachineFormView hosts={hosts() ?? []} picked={picked()} defaultCommand={defaultCommand()} cancel={list().length > 0} onSave={add} onCancel={() => setEditing(null)} />
            </Stack>
          </Show>
        </Stack>
      </Dialog>
      <Show when={ask()}>
        {(q) => (
          <Dialog
            open
            role="alertdialog"
            size="sm"
            onOpenChange={(o) => !o && setAsk(undefined)}
            title={q().title}
            description={q().body}
            part="machines.ask"
            footer={
              <Inline gap="2" justify="end">
                <Button size="sm" variant="ghost" onClick={() => setAsk(undefined)}>
                  {t('machines.cancel')}
                </Button>
                <Button
                  size="sm"
                  variant={q().danger ? 'danger' : 'primary'}
                  onClick={() => {
                    const run = q().run;
                    setAsk(undefined);
                    run();
                  }}
                >
                  {q().ok}
                </Button>
              </Inline>
            }
          >
            {null}
          </Dialog>
        )}
      </Show>
    </>
  );
}
