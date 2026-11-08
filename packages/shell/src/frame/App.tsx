// The app: v1's frame (the kit's Stage: crew rail, the sidebar's head and list, the main pane), the
// overlay stack, the toasts and the task switcher. Layout comes from navigation only (nav.layout,
// from the width). On a phone (stack) one page shows: the list, or the main pane when a task, a
// view or New task is open (New task from the list opens Home's prompt box as its own page).

import { createMemo, createSignal, createEffect, lazy, on, type JSX } from 'solid-js';
import type { Readable } from '@wisp/client';
import { Stage, Toasts, useSignal, type StagePage } from '@wisp/ui';
import { useShell } from '../context.tsx';
import { Area, ClientsProvider, type Clients } from '../slot.tsx';
import { MainPane } from './Panes.tsx';
import { Overlays } from './Overlays.tsx';
import { Head, Rail, SidebarList } from './Sidebar.tsx';

const Switcher = lazy(() => import('../switcher/Switcher.tsx'));

export function App(props: { readonly clients: Clients; readonly recent: Readable<readonly string[]> }): JSX.Element {
  const shell = useShell();
  const nav = useSignal(shell.nav);
  // stack only: Home's prompt box as its own page (v1 body.stack-page), opened from New task
  const [launcher, setLauncher] = createSignal(false);
  createEffect(on(() => nav().main.kind, (k) => k !== 'home' && setLauncher(false)));
  const page = createMemo<StagePage>(() => (nav().main.kind === 'home' && !launcher() ? 'list' : 'main'));
  const switcher = shell.platform.kind === 'desktop';
  const onNew = (): void => {
    setLauncher(true);
    shell.navigate({ t: 'home' });
    shell.focusTargets.focus('launcher');
  };
  return (
    <ClientsProvider value={props.clients}>
      <Stage
        layout={nav().layout}
        page={page()}
        rail={<Rail />}
        head={<Head />}
        list={<Area input="shell.sidebar:list" fallback={<SidebarList onNew={onNew} homeOn={nav().main.kind === 'home'} />} />}
        main={<MainPane onBack={() => setLauncher(false)} />}
        gripLabel={shell.t('shell.side.grip')}
        listBehind={nav().main.kind === 'home'}
      />
      <Overlays />
      <Toasts toaster={shell.toast} />
      {switcher ? <Switcher recent={props.recent} /> : null}
    </ClientsProvider>
  );
}
