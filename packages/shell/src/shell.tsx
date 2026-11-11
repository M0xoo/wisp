// createShell: the extension host and the app (plan §6.6, §4.6). It registers plugin UIs (each with
// its own PluginClient and scope), resolves the extension tree, owns the shell's own state (theme,
// the keyboard's task, the list's width, the recent tasks) and renders the frame. Built-in screens
// come through the same register() as anyone's (plan §6.0.3): the shell's own pieces are the
// `shell` plugin in builtins.tsx.

import { render } from 'solid-js/web';
import { computed, effect, signal, untracked, type Client, type PeerId, type PluginClient } from '@wisp/client';
import { BLOCK_STRINGS, KitProvider, KIT_STRINGS, type KitString, type Toaster } from '@wisp/ui';
import type { PluginUiDef, SettingsPaneDef, ShellApi, ShellContext } from './contract.ts';
import { namespaceOf } from './define.ts';
import { SHELL_STRINGS } from './i18n/en.ts';
import type { Platform } from './platform/types.ts';
import { createRegistry, type Warn } from './registry.ts';
import { createTheme } from './theme.ts';
import { ShellProvider } from './context.tsx';
import { App } from './frame/App.tsx';
import { shellUi, SHELL_SETTINGS } from './builtins.tsx';
import { installKeys } from './keyboard.ts';
import { watchCoreTopics } from './watch.ts';
import { wireNotices } from './toasts.ts';

/** The part of `window` the shell uses; tests pass happy-dom's. */
export interface ShellWindow {
  readonly innerWidth: number;
  readonly document: Document;
  readonly localStorage?: Storage;
  matchMedia(q: string): MediaQueryList;
  addEventListener(type: string, fn: (e: Event) => void, opts?: boolean | AddEventListenerOptions): void;
  removeEventListener(type: string, fn: (e: Event) => void, opts?: boolean | EventListenerOptions): void;
}

export interface ShellOptions {
  client: Client;
  toaster: Toaster;
  platform: Platform;
  /** this client's own wisp: where the theme setting lives */
  home: PeerId;
  window: ShellWindow;
  warn?: Warn;
}

export interface Shell extends ShellApi {
  /** the shell's own plugin client (for its built-ins and tests) */
  readonly self: PluginClient;
  pluginClient(id: string): PluginClient | undefined;
  /** every plugin's Settings panes, each with the plugin that gave it (the Settings frame lists them) */
  settingsPanes(): () => readonly (SettingsPaneDef & { readonly plugin: string })[];
}

const RECENT_MAX = 20;

// size-ok: the factory wires the shell's parts together; each part lives in its own module
export function createShell(o: ShellOptions): Shell {
  const { client, toaster, platform } = o;
  const warn: Warn = o.warn ?? ((msg, data) => client.devtools.record({ kind: 'warn', message: data === undefined ? msg : `${msg}: ${String(data)}` }));
  const self = client.plugin('shell');
  self.strings(SHELL_STRINGS);
  const kitScope = client.scope.child('kit');
  client.i18n.register('kit', Object.fromEntries(Object.entries(KIT_STRINGS).map(([k, v]) => [`kit.${k}`, v])), kitScope);
  // the answer blocks' copy (`block.*`), the kit's like its own strings: every screen that shows blocks reads them here
  client.i18n.register('block', BLOCK_STRINGS, kitScope);
  const settings = self.settings(SHELL_SETTINGS);
  const t: ShellContext['t'] = (key, vars) => client.i18n.t(key, vars);
  const kitT = (key: KitString, vars?: Readonly<Record<string, string | number>>): string => client.i18n.t(`kit.${key}`, vars);

  const registry = createRegistry(warn);
  const clients = new Map<string, PluginClient>([['shell', self]]);
  const theme = createTheme({
    pref: settings.get('shell.theme'),
    lockedBy: settings.lockedBy('shell.theme'),
    write: (p) => settings.set('shell.theme', p),
    root: o.window.document.documentElement,
    dark: o.window.matchMedia('(prefers-color-scheme: dark)'),
    storage: o.window.localStorage,
    onLocked: (by) => toaster.show(t('shell.toast.locked', { by })),
  });
  self.scope.add(() => theme.dispose());

  const selected = signal<string | undefined>(undefined);
  const focusTargets = new Map<string, () => void>();
  const recent = signal<readonly string[]>([]);
  const nav = client.nav.nav;
  const openTask = computed(() => {
    const m = nav().main;
    return m.kind === 'task' ? m.id : undefined;
  });

  const context: ShellContext = {
    client,
    nav,
    navigate: (intent) => client.nav.navigate(intent),
    t,
    toast: toaster,
    platform,
    theme: { pref: theme.pref, resolved: theme.resolved, set: theme.set },
    selection: { get: () => selected(), set: (k) => selected(k) },
    sidebar: {
      open: () => settings.get('shell.sidebar.open')(),
      toggle: () => void settings.set('shell.sidebar.open', !untracked(settings.get('shell.sidebar.open'))),
      width: () => settings.get('shell.sidebar.width')(),
      setWidth: (px) => void settings.set('shell.sidebar.width', Math.round(Math.min(640, Math.max(220, px)))),
    },
    focusTargets: {
      provide(name, focus) {
        focusTargets.set(name, focus);
        return () => {
          if (focusTargets.get(name) === focus) focusTargets.delete(name);
        };
      },
      focus(name) {
        const fn = focusTargets.get(name);
        fn?.();
        return fn !== undefined;
      },
    },
    palette: { open: () => client.nav.navigate({ t: 'openOverlay', overlay: { kind: 'dialog', id: 'shell.palette' as never, params: null } }) },
    extensions: (input) => registry.input(input),
    settingsPanes: () => registry.settingsPanes,
    harnesses: () => registry.harnesses,
    promptSources: () => registry.prompt,
    block: (type) => registry.block(type),
    view: (kind) => registry.view(kind),
  };

  function register(def: PluginUiDef): void {
    if (registry.has(def.id)) throw new Error(`plugin UI ${def.id} is registered twice`);
    const ns = namespaceOf(def.id);
    const pc = clients.get(def.id) ?? client.plugin(ns);
    clients.set(def.id, pc);
    if (def.catalogue && Object.keys(def.catalogue).length > 0) {
      // a string is the plugin's under its namespace (`crew.x`) or its full id (`wisp.crew.x`), as an
      // extension id may be; the full-id ones are registered under the id, so each key still has one owner
      const full = `${def.id}.`;
      const byId = def.id === ns ? [] : Object.entries(def.catalogue).filter(([k]) => k.startsWith(full));
      const rest = Object.fromEntries(Object.entries(def.catalogue).filter(([k]) => !(def.id !== ns && k.startsWith(full))));
      if (Object.keys(rest).length > 0) pc.strings(rest);
      if (byId.length > 0) client.i18n.register(def.id, Object.fromEntries(byId), pc.scope);
    }
    for (const v of def.views ?? []) {
      pc.registerView({
        id: v.kind,
        slot: v.slot,
        ...(v.overlay && { overlay: v.overlay }),
        parse: (params) => {
          try {
            return v.parse(params) === undefined ? undefined : params;
          } catch {
            return undefined;
          }
        },
      });
    }
    for (const e of def.extensions ?? []) if (!e.id.startsWith(`${ns}.`) && !e.id.startsWith(`${def.id}.`)) warn(`${def.id}'s extension ${e.id} isn't prefixed with ${ns}.`);
    registry.add(def);
    pc.scope.add(() => {
      registry.remove(def.id);
      clients.delete(def.id);
    });
    def.setup?.(pc);
  }

  register(shellUi(context));
  watchCoreTopics(client, o.home, self.scope);
  wireNotices(context, self.scope);
  self.scope.add(platform.onOpen((target) => client.nav.navigate({ t: 'openFromToast', target })));

  const shell: Shell = {
    client,
    self,
    context,
    nav,
    register,
    unregister(id) {
      if (id === 'shell') return;
      clients.get(id)?.scope.dispose();
    },
    pluginClient: (id) => clients.get(id),
    settingsPanes: () => registry.settingsPanes as () => readonly (SettingsPaneDef & { readonly plugin: string })[],
    render(root) {
      const scope = self.scope.child('render');
      scope.add(trackRecent());
      scope.add(installKeys(o.window, context, registry, (id) => clients.get(id) ?? self));
      const onResize = (): void => client.nav.navigate({ t: 'resize', width: o.window.innerWidth });
      o.window.addEventListener('resize', onResize);
      scope.add(() => o.window.removeEventListener('resize', onResize));
      const stop = render(
        () => (
          <ShellProvider value={context}>
            <KitProvider t={kitT}>
              <App clients={{ client: (id) => clients.get(id) ?? self, viewOwner: (kind) => registry.viewOwner(kind), palette: registry.palette, shortcuts: registry.shortcuts }} recent={recent} />
            </KitProvider>
          </ShellProvider>
        ),
        root,
      );
      scope.add(stop);
      return () => scope.dispose();
    },
    dispose() {
      for (const [id, pc] of clients) if (id !== 'shell') pc.scope.dispose();
      self.scope.dispose();
      kitScope.dispose();
    },
  };

  /** the tasks you were on, latest first (⌃Tab's order): the open task moves to the front */
  function trackRecent(): () => void {
    return effect(() => {
      const id = openTask();
      if (id !== undefined) untracked(() => recent([id, ...recent().filter((x) => x !== id)].slice(0, RECENT_MAX)));
    });
  }

  return shell;
}
