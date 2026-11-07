// The phone's start (plan §7.3). apps/web's entry calls this when it runs inside the Android app,
// instead of connecting to the wisp that served it (on a phone the bundle comes from the APK):
//
//   import { bootPhone, onPhone } from '@wisp/mobile';
//   if (onPhone(window)) {
//     const { client, platform } = await bootPhone({ build: BUILD, createShell: (client, platform) => registerPlugins(client, platform) });
//     render(() => <Shell client={client} platform={platform} />, root);
//   }
//
// `createShell` runs before `client.start`: plugins register their views first, so the restored URL
// may name one (createClient's start). bootPhone then paints from IndexedDB, starts every saved
// computer as a peer, follows the saved list, sends Android's Back to navigation (leaving the app
// when there is nothing to go back to) and writes pending rows and drafts when the app is hidden.
//
// `home` is PHONE, a peer that is never added: no wisp runs on a phone. Device-scoped settings live
// on the phone; a server-scoped setting has no home here and waits (the shell should offer those per
// computer instead).

import { browserHistory, createClient, indexedDBPersist, sameNav, untracked, uuidv7, type Client, type ClientOptions, type IdbFactory, type IdbKeyRangeStatic, type Target, type WindowLike } from '@wisp/client';
import { androidPlatform, type Platform, type PlatformWindow } from '@wisp/shell/platform';
import { capacitorBridge, exposePlugins, type CapacitorLike, type NativeBridge } from './bridge.ts';
import { migrateV1, type StorageLike } from './migrate.ts';
import { followComputers, phonePeers, PHONE } from './peers.ts';

export type PhoneWindow = PlatformWindow &
  WindowLike & {
    readonly Capacitor?: PlatformWindow['Capacitor'] & CapacitorLike;
    readonly innerWidth: number;
    readonly localStorage?: StorageLike;
    readonly indexedDB?: IdbFactory;
    readonly IDBKeyRange?: IdbKeyRangeStatic;
  };

export interface PhoneOptions {
  build: string;
  window?: PhoneWindow;
  /** the native side; capacitorBridge(window.Capacitor) by default (tests pass a fake) */
  bridge?: NativeBridge;
  /** registers the plugins' UI before the client starts */
  createShell?: (client: Client, platform: Platform) => void | Promise<void>;
  /** anything else createClient takes (onError for the toast, dev, warn, timers) */
  client?: Partial<Omit<ClientOptions, 'clientId' | 'build' | 'home'>>;
}

export interface Phone {
  readonly client: Client;
  readonly platform: Platform;
  readonly bridge: NativeBridge;
}

/** In the Android app: Capacitor's native bridge is there. */
export function onPhone(w: { readonly Capacitor?: CapacitorLike }): boolean {
  return w.Capacitor?.isNativePlatform?.() === true;
}

// One id per install, so the peers keep this client's subscriptions and pending commands apart.
function clientIdOf(storage: StorageLike | undefined): string {
  const saved = storage?.getItem('wisp.client');
  if (saved) return saved;
  const id = uuidv7();
  storage?.setItem('wisp.client', id);
  return id;
}

const isTarget = (v: unknown): v is Target => {
  const to = typeof v === 'object' && v !== null ? (v as { to?: unknown }).to : undefined;
  return to === 'main' || to === 'side' || to === 'overlay';
};

/** androidPlatform, with a tapped notification coming from Alerts.java through the bridge. */
export function phonePlatform(w: PlatformWindow, bridge: NativeBridge): Platform {
  return { ...androidPlatform(w), onOpen: (fn) => bridge.onOpen((t) => isTarget(t) && fn(t)) };
}

export async function bootPhone(o: PhoneOptions): Promise<Phone> {
  const w = o.window ?? (globalThis as unknown as PhoneWindow);
  exposePlugins(w.Capacitor); // androidPlatform reads Capacitor.Plugins.{WispSsh,LocalNotifications}
  const bridge = o.bridge ?? capacitorBridge(w.Capacitor);
  const platform = phonePlatform(w, bridge);
  const persist = w.indexedDB && w.IDBKeyRange ? { persist: indexedDBPersist(w.indexedDB, w.IDBKeyRange) } : {};
  const client = createClient({ history: browserHistory(w), ...persist, width: w.innerWidth, ...o.client, clientId: clientIdOf(w.localStorage), build: o.build, home: PHONE });
  await o.createShell?.(client, platform);
  await migrateV1(w.localStorage, bridge).catch((err: unknown) => o.client?.warn?.('v1 computers not copied', String(err)));
  const computers = await bridge.list();
  await client.start(await phonePeers(bridge, computers));
  followComputers(client, bridge, client.scope, computers);
  client.scope.add(bridge.onBack(() => back(client, bridge)));
  const hidden = (): void => {
    if (w.document.visibilityState === 'hidden') void client.flush();
  };
  w.document.addEventListener('visibilitychange', hidden);
  client.scope.add(() => w.document.removeEventListener('visibilitychange', hidden));
  return { client, platform, bridge };
}

/** Back closes what's open (an overlay, the side, a task); with nothing left the app goes behind. */
export function back(client: Pick<Client, 'nav'>, bridge: Pick<NativeBridge, 'leave'>): void {
  const before = untracked(client.nav.nav);
  client.nav.navigate({ t: 'back' });
  if (sameNav(before, untracked(client.nav.nav))) void bridge.leave().catch(() => {});
}
