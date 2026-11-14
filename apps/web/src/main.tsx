// The entry: one client, its peers, every plugin UI, the shell. First paint comes from IndexedDB
// (@wisp/client start: rows, cursors, pending commands, drafts, the last place) before any peer
// answers; then each peer resumes from its cursor. The page's own wisp is a peer like any other;
// more come from Settings (the device's `shell.peers`).

import '@wisp/ui/styles';
import { createSignal } from 'solid-js';
import { browserHistory, createClient, defineCommand, effect, httpTransport, indexedDBPersist, peerId, untracked, uuidv7, type PeerConfig, type PeerId } from '@wisp/client';
import { commandErrorToast, createShell, detectPlatform, remoteUiDefs, type RemoteUi } from '@wisp/shell';
import { createToaster } from '@wisp/ui';
import { shellSettingsUi } from '@wisp-plugin/shell-settings-ui';
import { startNotifier } from '@wisp-plugin/shell-home-ui';
import { pluginUis } from './plugins.ts';
import { registerWorker } from './worker.ts';

performance.mark('wisp:boot');

function clientId(): string {
  try {
    const had = localStorage.getItem('wisp.client');
    if (had) return had;
    const id = uuidv7();
    localStorage.setItem('wisp.client', id);
    return id;
  } catch {
    return uuidv7();
  }
}

/** The page's own wisp names itself in <meta name="wisp-peer">; until it does, it's `local`. */
const home = peerId(document.querySelector('meta[name="wisp-peer"]')?.getAttribute('content') || 'local');
const platform = detectPlatform(window);
const toaster = createToaster();
const client = createClient({
  clientId: clientId(),
  build: __WISP_BUILD__,
  home,
  width: window.innerWidth,
  persist: indexedDBPersist(indexedDB, IDBKeyRange),
  history: browserHistory(window),
  dev: import.meta.env.DEV,
  onError: commandErrorToast(toaster),
});
const shell = createShell({ client, toaster, platform, home, window });
// dev only: the QA gates drive the app's own state the way v1's capture drove its DOM (qa/parity.mjs)
if (import.meta.env.DEV) (window as unknown as { __wispShell?: unknown }).__wispShell = shell;
for (const { path, def } of pluginUis()) {
  if (!def) continue;
  try {
    shell.register(def);
  } catch (err) {
    client.devtools.record({ kind: 'warn', message: `${path}: ${String(err)}` }); // one bad plugin never stops the app
  }
}

// ADR-0048: what your untrusted plugins show (their UI modules run in a sandboxed frame, drawn with the kit); read
// once the home peer is there
const pluginsUi = defineCommand<{ peer: PeerId }, RemoteUi[]>({ id: 'plugins.ui', owner: (a) => a.peer, wire: () => ({}), optimistic: 'none', pending: 'none: read at start' });
function loadRemoteUis(): void {
  void shell.client
    .plugin('shell')
    .run(pluginsUi, { peer: home })
    .then((list) => {
      for (const def of remoteUiDefs(Array.isArray(list) ? list : [])) {
        try {
          shell.register(def);
        } catch (err) {
          client.devtools.record({ kind: 'warn', message: `${def.id}: ${String(err)}` });
        }
      }
    })
    .catch(() => undefined);
}

// A task finishing or asking: a toast, and a system notification when wisp isn't in front (v1 notify.js)
const homeClient = shell.pluginClient('wisp.shell-home');
if (homeClient) startNotifier({ client: homeClient, platform, toast: toaster, nav: shell.nav, focused: () => document.hasFocus() });

// Settings: the frame (an overlay view) and its own panes, given what only the shell has (ADR-0003: inputs, no
// private API): every plugin's panes, each with its plugin's client, and the translator. It has no default
// definition, so the glob above skips it: registered here, after the others, so their panes are there.
// the panes as a Solid signal fed by the registry: a pane registered later (an untrusted plugin's, ADR-0048) shows too
type PaneEntry = { pane: ReturnType<ReturnType<typeof shell.settingsPanes>>[number]; client: NonNullable<ReturnType<typeof shell.pluginClient>> };
const [paneEntries, setPaneEntries] = createSignal<readonly PaneEntry[]>([]);
effect(() => {
  setPaneEntries(
    shell.settingsPanes()().flatMap((pane) => {
      const c = shell.pluginClient(pane.plugin);
      return c ? [{ pane, client: c }] : [];
    }),
  );
});
shell.register(
  shellSettingsUi({
    panes: paneEntries,
    t: (key, vars) => client.i18n.t(key, vars),
  }),
);

/** Other wisps this device reaches (Settings → Computers): { peer, name, base }. */
function extraPeers(): PeerConfig[] {
  const list = untracked(client.settings.get('shell.peers'));
  if (!Array.isArray(list)) return [];
  const out: PeerConfig[] = [];
  for (const p of list) {
    if (typeof p !== 'object' || p === null || Array.isArray(p)) continue;
    const { peer, name, base } = p as Record<string, unknown>;
    if (typeof peer !== 'string' || typeof base !== 'string' || peer === home) continue;
    out.push({ peer: peerId(peer), name: typeof name === 'string' ? name : peer, transport: httpTransport({ base }) });
  }
  return out;
}

// start() reads IndexedDB (rows, cursors, drafts, the last place) and adds the peers; their hellos go
// out on the next task. The shell renders right then: what's on disk paints before any peer answers,
// and every view's subscription finds its peer already added (a watch on an unknown peer is dropped).
/** The machines this wisp keeps (another computer, a sandbox: wisp.machines' `machines_peer` rows) as peers of the
 * app, reached through this wisp (`/api/peer/<machine>`, its own link and token): their tasks show and open as ours.
 * One that goes is let go. */
function followMachines(): void {
  const added = new Map<string, PeerId>();
  const rows = client.entities.list<{ id: string; body?: { peer?: string | null; name?: string } }>('machines_peer');
  effect(() => {
    const now = new Map<string, { peer: PeerId; name: string }>();
    for (const r of rows()) {
      const remote = r.body?.peer;
      const machine = String(r.id).slice(String(r.id).indexOf(':') + 1);
      // the machine's own id names it here (two boxes may both call themselves "this computer")
      if (remote && machine !== home) now.set(machine, { peer: peerId(machine), name: r.body?.name ?? machine });
    }
    for (const [machine, peer] of added) {
      if (now.get(machine)?.peer === peer) continue;
      client.removePeer(peer);
      added.delete(machine);
    }
    for (const [machine, p] of now) {
      if (added.has(machine)) continue;
      client.addPeer({ peer: p.peer, name: p.name, transport: httpTransport({ base: `/api/peer/${encodeURIComponent(machine)}` }) });
      added.set(machine, p.peer);
    }
  });
}

void client.start([{ peer: home, name: 'wisp', transport: httpTransport({ base: '' }) }]).then(() => {
  for (const p of extraPeers()) client.addPeer(p);
  followMachines();
  loadRemoteUis();
  const root = document.getElementById('app');
  if (root) shell.render(root);
  performance.mark('wisp:painted');
});

// what's waiting (rows, drafts) is written before the page goes away
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') void client.flush();
});
if (import.meta.env.PROD) registerWorker(platform, toaster, (k) => client.i18n.t(k));
