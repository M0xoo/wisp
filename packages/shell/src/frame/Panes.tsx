// The three panes. Each is one area a plugin fills (the contract's shell.sidebar:list,
// shell.screen:*, shell.side:*), or a plugin view named by navigation. Until a plugin fills an area
// the shell shows a small built-in: the list, a task's activity, a note on Home. Screens are keyed
// by what they show, so opening another task builds its screen afresh (its scopes, its
// subscriptions) and the old one's end with it.

import { Match, Show, Switch, createMemo, lazy, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import type { EntityKey, Nav } from '@wisp/client';
import { EmptyState, Stack, useSignal } from '@wisp/ui';
import { useShell } from '../context.tsx';
import { Area, Slot, useViewClient } from '../slot.tsx';
import { SESSION, type SessionRow } from '../rows.ts';
import { FallbackList } from './FallbackList.tsx';
import { PeerBanner } from './PeerBanner.tsx';

const FallbackTask = lazy(() => import('./FallbackTask.tsx'));

function useSession(id: () => string | undefined): () => (SessionRow & { agent: string }) | undefined {
  const shell = useShell();
  const row = createMemo(() => {
    const key = id();
    return key === undefined ? undefined : shell.client.entities.row<SessionRow>(SESSION, key as EntityKey);
  });
  return () => row()?.() as (SessionRow & { agent: string }) | undefined;
}

export function ListPane(): JSX.Element {
  return (
    <Stack gap="0" grow part="shell.list.pane">
      <PeerBanner />
      <Slot input="shell.list:top" layout="stack" />
      <Area input="shell.sidebar:list" fallback={<FallbackList />} />
    </Stack>
  );
}

function ViewOf(props: { readonly kind: string; readonly params: unknown }): JSX.Element {
  const shell = useShell();
  const def = createMemo(() => shell.view(props.kind));
  return (
    <Show when={def()} keyed fallback={<EmptyState icon="info" title={shell.t('shell.view.missing')} compact />}>
      {(d) => {
        const client = useViewClient(d.kind);
        return <Dynamic component={d.component} client={client} params={d.parse(props.params)} />;
      }}
    </Show>
  );
}

const mainKey = (n: Nav): string => (n.main.kind === 'home' ? 'home' : n.main.kind === 'view' ? `view:${n.main.id}:${JSON.stringify(n.main.params)}` : `${n.main.kind}:${n.main.id}`);

export function MainPane(): JSX.Element {
  const shell = useShell();
  const nav = useSignal(shell.nav);
  const key = createMemo(() => mainKey(nav()));
  return (
    <Show when={key()} keyed>
      {(_k) => {
        const main = nav().main;
        switch (main.kind) {
          case 'home':
            return <Area input="shell.screen:home" fallback={<EmptyState icon="spark" title={shell.t('shell.fallback.home.title')}>{shell.t('shell.fallback.home.body')}</EmptyState>} />;
          case 'task': {
            const id = main.id;
            const session = useSession(() => id);
            return <Area input="shell.screen:task" id={id} session={session} fallback={<FallbackTask id={id} />} />;
          }
          case 'crew':
            return <Area input="shell.screen:crew" id={main.id} fallback={<EmptyState icon="crew" title={shell.t('shell.view.missing')} compact />} />;
          case 'view':
            return <ViewOf kind={main.id} params={main.params} />;
        }
      }}
    </Show>
  );
}

export function SidePane(): JSX.Element {
  const shell = useShell();
  const nav = useSignal(shell.nav);
  const side = createMemo(() => nav().side);
  const key = createMemo(() => {
    const s = side();
    return s.kind === 'none' ? '' : `${s.kind}:${s.id}`;
  });
  return (
    <Show when={key()} keyed>
      {(_k) => {
        const s = side();
        return (
          <Switch>
            <Match when={s.kind === 'view' && s}>{(v) => <ViewOf kind={v().id} params={null} />}</Match>
            <Match when={s.kind !== 'view' && s.kind !== 'none' && s}>
              {(p) => {
                const id = p().id;
                const session = useSession(() => id);
                return <Area input={`shell.side:${p().kind}`} id={id} session={session} fallback={<EmptyState icon="panel" title={shell.t('shell.view.missing')} compact />} />;
              }}
            </Match>
          </Switch>
        );
      }}
    </Show>
  );
}
