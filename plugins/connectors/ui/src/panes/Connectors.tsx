// Settings → Connectors (v1 web/js/features/connectors.js, design/v1-reference/settings.connectors): the MCP
// servers every task's agent gets. Servers found in the harnesses' own configs are offered once (Review, or
// Not now); each connector is a row with its check (tools, or why it failed), its switch and its menu (Check
// again, Edit, Sign in or out, Remove); an empty list offers starting points. Every write shows at once.
import { createMemo, createSignal, For, onCleanup, Show, untrack, type JSX } from 'solid-js';
import type { PluginClient } from '@wisp/client';
import { useShell } from '@wisp/shell';
import { Button, Inline, Menu, Pill, SettingsGroup, SettingsRow, Switch, Text, useSignal } from '@wisp/ui';
import { addConnector, importFound, removeConnector, signIn, signOut, testConnector, updateConnector } from '../commands.ts';
import { homeRow, homeRows } from '../data.ts';
import { t } from '../i18n.ts';
import { bodyOf, commandLine, draftOf, emptyDraft, EXAMPLES, exampleFor, isFor, harnessName, hostOf, listOf, sourcesOf, statusOf, stillSigning, type Draft } from '../lib.ts';
import { KIND, REACH_ID, TOPIC, type ConnectorView, type FoundServer, type Reach } from '../types.ts';
import { Confirm } from './Confirm.tsx';
import { Editor } from './Editor.tsx';
import { Review } from './Review.tsx';

const quiet = (p: Promise<unknown>): void => {
  p.catch(() => {}); // the shell's onError shows the rollback toast
};

function statusLine(c: ConnectorView, signing: boolean): string {
  const s = statusOf(c, signing);
  switch (s.kind) {
    case 'signing':
      return t('connectors.status.signing');
    case 'signin':
      return t('connectors.status.signin');
    case 'checking':
      return t('connectors.status.checking');
    case 'unchecked':
      return t('connectors.status.unchecked');
    case 'ok':
      return t('connectors.status.ok', { count: s.count });
    case 'failed':
      return s.error || t('connectors.status.failed');
  }
}

/** Green when it listed its tools, red when it didn't start, neutral while checking or signing in. */
function toneOf(c: ConnectorView, signing: boolean): 'good' | 'bad' | 'warn' | 'neutral' {
  const k = statusOf(c, signing).kind;
  return k === 'ok' ? 'good' : k === 'failed' ? 'bad' : k === 'signin' ? 'warn' : 'neutral';
}

export default function Connectors(props: { readonly client: PluginClient }): JSX.Element {
  const c = props.client;
  const shell = useShell();
  const peer = c.home;
  const scope = c.scope.child('connectors-pane');
  onCleanup(() => scope.dispose());
  c.watch(peer, TOPIC, scope);
  const list = useSignal(homeRows<ConnectorView>(c, KIND.connector));
  const found = useSignal(homeRows<FoundServer>(c, KIND.found));
  const reach = useSignal(homeRow<Reach>(c, KIND.reach, REACH_ID));
  const [editing, setEditing] = createSignal<{ draft: Draft; id?: string } | undefined>();
  const [reviewing, setReviewing] = createSignal(false);
  const [removing, setRemoving] = createSignal<ConnectorView | undefined>();
  const [signing, setSigning] = createSignal<Record<string, number>>({});
  // opened for an issue source (the issue picker's Connect Linear… / Jira…: Settings' params `connector`): yours
  // to sign in again, or a new one filled in (v1 openConnectorFor)
  untrack(() => {
    const asked = (shell.nav().overlays.at(-1)?.params as { connector?: unknown } | undefined)?.connector;
    if (typeof asked !== 'string') return;
    const have = (list() as ConnectorView[]).find((x) => isFor(asked, x));
    if (have) setEditing({ draft: draftOf(have), id: have.id });
    else {
      const ex = exampleFor(asked);
      if (ex) setEditing({ draft: ex.draft });
    }
  });
  const rows = createMemo(() => [...(list() as ConnectorView[])].sort((a, b) => a.name.localeCompare(b.name)));
  const names = (): ReadonlyMap<string, string> => new Map();
  const isSigning = (x: ConnectorView): boolean => {
    const at = signing()[x.id];
    return at !== undefined && stillSigning(x, at, Date.now());
  };

  const save = (d: Draft, id?: string): void => {
    const body = bodyOf(d);
    quiet(id === undefined ? c.run(addConnector, { peer, ...body }) : c.run(updateConnector, { peer, id, ...body }));
    setEditing(undefined);
  };
  const login = (x: ConnectorView): void => {
    const platform = shell.platform;
    setSigning({ ...signing(), [x.id]: Date.now() });
    // the sign-in comes back to this page (the shell's platform knows its origin: local, a machine, the grid)
    c.run(signIn, { peer, id: x.id, origin: platform.origin }).then(
      (r) => {
        platform.openExternal(r.url);
      },
      () => setSigning({ ...signing(), [x.id]: 0 }),
    );
  };
  const act = (x: ConnectorView, v: string): void => {
    if (v === 'test') quiet(c.run(testConnector, { peer, id: x.id }));
    else if (v === 'edit') setEditing({ draft: draftOf(x), id: x.id });
    else if (v === 'signin') login(x);
    else if (v === 'signout') quiet(c.run(signOut, { peer, id: x.id }));
    else if (v === 'remove') setRemoving(x);
  };
  const menu = (x: ConnectorView) => [
    { value: 'test', label: t('connectors.menu.test'), icon: 'replay' as const },
    { value: 'edit', label: t('connectors.menu.edit'), icon: 'pen' as const },
    ...(x.transport === 'remote' ? [x.signed_in ? { value: 'signout', label: t('connectors.menu.signout'), icon: 'lock' as const } : { value: 'signin', label: t('connectors.menu.signin'), icon: 'external' as const }] : []),
    { kind: 'separator' as const },
    { value: 'remove', label: t('connectors.menu.remove'), icon: 'trash' as const, danger: true },
  ];
  const where = (x: ConnectorView): string => (x.transport === 'local' ? commandLine(x) : hostOf(x.url));
  const reachLine = (): string => listOf((reach()?.harnesses ?? []).map((h) => harnessName(h, names())), t('connectors.and'));

  return (
    <>
      <Text as="p" tone="muted" part="connectors.lede">
        {t('connectors.lede')}
      </Text>
      <Show when={found().length > 0}>
        <SettingsGroup part="connectors.found">
          <SettingsRow
            part="connectors.found.row"
            title={t('connectors.found.title', { count: found().length, from: listOf(sourcesOf(found() as FoundServer[]), t('connectors.and')) })}
            description={found()
              .map((f) => f.name)
              .join(', ')}
            control={
              <Inline gap="2">
                <Button size="sm" variant="ghost" part="connectors.found.skip" onClick={() => quiet(c.run(importFound, { peer, names: [], dismiss: found().map((f) => f.name) }))}>
                  {t('connectors.found.skip')}
                </Button>
                <Button size="sm" part="connectors.found.review" onClick={() => setReviewing(true)}>
                  {t('connectors.found.review')}
                </Button>
              </Inline>
            }
          />
        </SettingsGroup>
      </Show>
      <SettingsGroup
        part="connectors.list"
        title={t('connectors.yours')}
        description={t('connectors.yours.description')}
        actions={
          <Button size="sm" variant="ghost" icon="plus" part="connectors.add" onClick={() => setEditing({ draft: emptyDraft() })}>
            {t('connectors.add')}
          </Button>
        }
      >
        <Show
          when={rows().length > 0}
          fallback={
            <SettingsRow
              part="connectors.empty"
              title={t('connectors.empty.title')}
              description={t('connectors.empty.description')}
              control={
                <Inline gap="2">
                  <For each={EXAMPLES}>
                    {(e) => (
                      <Button size="sm" variant="secondary" part="connectors.example" onClick={() => setEditing({ draft: { ...e.draft, env: [...e.draft.env], headers: [...e.draft.headers] } })}>
                        {e.label}
                      </Button>
                    )}
                  </For>
                </Inline>
              }
            />
          }
        >
          <For each={rows()}>
            {(x) => (
              <SettingsRow
                part="connectors.row"
                title={x.name}
                description={
                  <Inline gap="2">
                    <Text tone="muted" truncate>
                      {where(x)}
                    </Text>
                    <Pill tone={toneOf(x, isSigning(x))} dot live={x.testing || isSigning(x)}>
                      {statusLine(x, isSigning(x))}
                    </Pill>
                  </Inline>
                }
                control={
                  <Inline gap="2">
                    <Show when={statusOf(x, isSigning(x)).kind === 'signin'}>
                      <Button size="sm" part="connectors.signin" onClick={() => login(x)}>
                        {t('connectors.menu.signin')}
                      </Button>
                    </Show>
                    <Switch aria-label={t('connectors.on', { name: x.name })} checked={x.enabled} onChange={(on) => quiet(c.run(updateConnector, { peer, id: x.id, enabled: on }))} />
                    <Menu part="connectors.row.menu" trigger={{ icon: 'dots', 'aria-label': t('connectors.menu', { name: x.name }), variant: 'ghost', size: 'sm' }} items={menu(x)} onSelect={(v) => act(x, v)} />
                  </Inline>
                }
              />
            )}
          </For>
        </Show>
      </SettingsGroup>
      <Text as="p" tone="muted" part="connectors.reach">
        {t('connectors.reach', { harnesses: reachLine() })}
      </Text>
      <Show when={editing()}>{(e) => <Editor draft={e().draft} editing={e().id !== undefined} onSave={(d) => save(d, e().id)} onClose={() => setEditing(undefined)} />}</Show>
      <Review
        open={reviewing()}
        found={found() as FoundServer[]}
        onImport={(names) => {
          setReviewing(false);
          quiet(c.run(importFound, { peer, names, dismiss: [] }));
        }}
        onClose={() => setReviewing(false)}
      />
      <Confirm
        open={removing() !== undefined}
        question={t('connectors.remove.ask', { name: removing()?.name ?? '' })}
        detail={t('connectors.remove.detail')}
        ok={t('connectors.menu.remove')}
        danger
        onAnswer={(yes) => {
          const x = removing();
          setRemoving(undefined);
          if (yes && x) quiet(c.run(removeConnector, { peer, id: x.id }));
        }}
      />
    </>
  );
}
