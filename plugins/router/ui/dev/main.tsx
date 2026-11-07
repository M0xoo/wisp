// `npm run dev`: this plugin's screens on the stub shell and the mock peer.
// ?theme=light|dark picks the theme; /s/<name>/ (or ?screen=<name>) opens one of seed.ts's screens.
import { render } from 'solid-js/web';
import ui from '../src/index.ts';
import { harness } from './harness.ts';
import { SCREENS, SEED } from './seed.ts';
import { StubShell, applyTheme, devToaster } from './stub-shell.tsx';

applyTheme();
const toaster = devToaster();
const h = harness({ ...SEED, width: window.innerWidth, onError: (err) => toaster.error(err.message) });
const screen = /^\/s\/([^/]+)/.exec(window.location.pathname)?.[1] ?? new URLSearchParams(window.location.search).get('screen') ?? '';
void h.ready().then(() => {
  for (const intent of SCREENS[screen] ?? []) h.client.nav.navigate(intent);
});
const root = document.getElementById('root');
if (root) render(() => <StubShell h={h} def={ui} toaster={toaster} />, root);
