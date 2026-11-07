// The app: the frame (top bar, list, main, side), the overlay stack, the toasts and the task
// switcher. Layout comes from navigation only (nav.layout, from the width); which page a phone
// shows follows what's open: a side pane, else a task or view, else the list.

import { createMemo, lazy, type JSX } from 'solid-js';
import type { Readable } from '@wisp/client';
import { Frame, Toasts, useSignal, type FramePage } from '@wisp/ui';
import { useShell } from '../context.tsx';
import { ClientsProvider, type Clients } from '../slot.tsx';
import { TopBar } from './TopBar.tsx';
import { ListPane, MainPane, SidePane } from './Panes.tsx';
import { Overlays } from './Overlays.tsx';

const Switcher = lazy(() => import('../switcher/Switcher.tsx'));

export function App(props: { readonly clients: Clients; readonly recent: Readable<readonly string[]> }): JSX.Element {
  const shell = useShell();
  const nav = useSignal(shell.nav);
  const listOpen = useSignal(() => shell.sidebar.open());
  const width = useSignal(() => shell.sidebar.width());
  const page = createMemo<FramePage>(() => {
    const n = nav();
    if (n.side.kind !== 'none') return 'side';
    return n.main.kind === 'home' ? 'list' : 'main';
  });
  // the desktop app gets ⌃Tab (Chrome keeps it for its tabs); the module loads on first use
  const switcher = shell.platform.kind === 'desktop';
  return (
    <ClientsProvider value={props.clients}>
      <Frame
        layout={nav().layout}
        page={page()}
        listOpen={listOpen()}
        sideOpen={nav().side.kind !== 'none'}
        vars={{ '--sb-w': `${width()}px` }}
        onListResize={(px, done) => (done ? shell.sidebar.setWidth(px) : undefined)}
        listLabel={shell.t('shell.list')}
        mainLabel={shell.t('shell.main')}
        sideLabel={shell.t('shell.side')}
        top={<TopBar />}
        list={<ListPane />}
        main={<MainPane />}
        side={<SidePane />}
      />
      <Overlays />
      <Toasts toaster={shell.toast} />
      {switcher ? <Switcher recent={props.recent} /> : null}
    </ClientsProvider>
  );
}
