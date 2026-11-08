// The entry: one client, its peers, every plugin UI, the shell. First paint comes from IndexedDB
// (@wisp/client start: rows, cursors, pending commands, drafts, the last place) before any peer
// answers; then each peer resumes from its cursor. The page's own wisp is a peer like any other;
// more come from Settings (the device's `shell.peers`).

import '@wisp/ui/styles';
import { browserHistory, createClient, httpTransport, indexedDBPersist, peerId, untracked, uuidv7, type PeerConfig } from '@wisp/client';
import { commandErrorToast, createShell, detectPlatform } from '@wisp/shell';
import { createToaster } from '@wisp/ui';
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
for (const { path, def } of pluginUis()) {
  if (!def) continue;
  try {
    shell.register(def);
  } catch (err) {
    client.devtools.record({ kind: 'warn', message: `${path}: ${String(err)}` }); // one bad plugin never stops the app
  }
}

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
void client.start([{ peer: home, name: 'wisp', transport: httpTransport({ base: '' }) }]).then(() => {
  for (const p of extraPeers()) client.addPeer(p);
  const root = document.getElementById('app');
  if (root) shell.render(root);
  performance.mark('wisp:painted');
});

// what's waiting (rows, drafts) is written before the page goes away
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') void client.flush();
});
if (import.meta.env.PROD) registerWorker(platform, toaster, (k) => client.i18n.t(k));
