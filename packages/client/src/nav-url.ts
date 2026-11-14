// Navigation mirrored in the URL (plan §4.6.4), so refresh, Back, a shared link and a phone
// notification land in the same state. encode/decode are pure; the History adapter is the only
// thing that touches `history`/`location`, and only `createNavigation` calls it.
//
//   /                         home            ?side=changes:<task> | shell:… | pr:… | view:<ext>
//   /task/<id>                a task          ?o=<kind>:<ext>[:<json params>]   (repeated, bottom first)
//   /crew/<id>                a crew member   ?p=<json params>                  (a view's params)
//   /view/<ext>               a plugin view

import { initialNav, navigate, pushes, sameNav, type Intent, type Main, type Nav, type Overlay, type Side } from './nav.ts';
import type { Scope } from './scope.ts';
import { signal, untracked, type Readable } from './signals.ts';
import type { CrewId, ExtensionId, Json, SessionId, Warn } from './types.ts';
import type { ViewRegistry } from './views.ts';

const EXT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ID = /^\S+$/; // any id; the path segment is URI-encoded

function parseJson(s: string | null): Json | undefined {
  if (s === null) return null;
  try {
    return JSON.parse(s) as Json;
  } catch {
    return undefined;
  }
}

export function encodeNav(nav: Omit<Nav, 'layout'>): string {
  const q = new URLSearchParams();
  let path = '/';
  const m = nav.main;
  if (m.kind === 'task') path = `/task/${encodeURIComponent(m.id)}`;
  else if (m.kind === 'crew') path = `/crew/${encodeURIComponent(m.id)}`;
  else if (m.kind === 'view') {
    path = `/view/${m.id}`;
    if (m.params !== null) q.set('p', JSON.stringify(m.params));
  }
  const s = nav.side;
  if (s.kind === 'view') q.set('side', `view:${s.id}`);
  else if (s.kind !== 'none') q.set('side', `${s.kind}:${s.id}`);
  if (s.kind === 'changes' && s.file) q.set('file', s.file);
  for (const o of nav.overlays) q.append('o', o.params === null ? `${o.kind}:${o.id}` : `${o.kind}:${o.id}:${JSON.stringify(o.params)}`);
  const qs = q.toString();
  return qs ? `${path}?${qs}` : path;
}

function decodeMain(path: string, q: URLSearchParams): Main {
  const parts = path.split('/');
  if (parts.length !== 3) return { kind: 'home' };
  const [, kind, raw = ''] = parts;
  const id = safeDecode(raw);
  if (kind === 'task' && ID.test(id)) return { kind: 'task', id: id as SessionId };
  if (kind === 'crew' && ID.test(id)) return { kind: 'crew', id: id as CrewId };
  if (kind === 'view' && EXT.test(id)) {
    const params = parseJson(q.get('p'));
    if (params !== undefined) return { kind: 'view', id: id as ExtensionId, params };
  }
  return { kind: 'home' };
}

/** A file of the task's folder in the Changes side's file view: relative, no way out. */
function withFile(side: Side, file: string | null): Side {
  if (side.kind !== 'changes' || !file || file.startsWith('/') || file.split('/').includes('..')) return side;
  return { ...side, file };
}

function decodeSide(raw: string | null): Side {
  if (raw === null) return { kind: 'none' };
  const i = raw.indexOf(':');
  const kind = raw.slice(0, i);
  const id = raw.slice(i + 1);
  if (i < 0 || !ID.test(id)) return { kind: 'none' };
  if (kind === 'view') return EXT.test(id) ? { kind: 'view', id: id as ExtensionId } : { kind: 'none' };
  if (kind === 'changes' || kind === 'shell' || kind === 'pr' || kind === 'preview') return { kind, id: id as SessionId };
  return { kind: 'none' };
}

function decodeOverlay(raw: string): Overlay | undefined {
  const [kind, id, ...rest] = raw.split(':');
  if (kind !== 'viewer' && kind !== 'dialog' && kind !== 'sheet') return undefined;
  if (id === undefined || !EXT.test(id)) return undefined;
  const params = rest.length === 0 ? null : parseJson(rest.join(':'));
  return params === undefined ? undefined : { kind, id: id as ExtensionId, params };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return '';
  }
}

/** Never throws: a broken or hostile URL lands on Home. */
export function decodeNav(url: string): Omit<Nav, 'layout'> {
  const qi = url.indexOf('?');
  const path = qi < 0 ? url : url.slice(0, qi);
  const q = new URLSearchParams(qi < 0 ? '' : url.slice(qi + 1));
  const overlays = q
    .getAll('o')
    .map(decodeOverlay)
    .filter((o): o is Overlay => o !== undefined);
  return { main: decodeMain(path, q), side: withFile(decodeSide(q.get('side')), q.get('file')), overlays };
}

// ---------- the history adapter ----------

export interface HistoryAdapter {
  /** the current location as `path?query` */
  read(): string;
  push(url: string): void;
  replace(url: string): void;
  /** the user moved through history (Back, Forward) */
  listen(fn: (url: string) => void): () => void;
}

/** The structural part of `window` the browser adapter needs; the app passes `window`. */
export interface WindowLike {
  location: { pathname: string; search: string };
  history: { pushState(data: unknown, unused: string, url?: string): void; replaceState(data: unknown, unused: string, url?: string): void };
  addEventListener(type: 'popstate', fn: () => void): void;
  removeEventListener(type: 'popstate', fn: () => void): void;
}

export function browserHistory(w: WindowLike): HistoryAdapter {
  return {
    read: () => w.location.pathname + w.location.search,
    push: (url) => w.history.pushState(null, '', url),
    replace: (url) => w.history.replaceState(null, '', url),
    listen(fn) {
      const on = (): void => fn(w.location.pathname + w.location.search);
      w.addEventListener('popstate', on);
      return () => w.removeEventListener('popstate', on);
    },
  };
}

/** For tests, the desktop shell before it has a URL bar, and server rendering. */
export function memoryHistory(start = '/'): HistoryAdapter & { readonly entries: readonly string[]; back(): void } {
  const entries = [start];
  let at = 0;
  const listeners = new Set<(url: string) => void>();
  return {
    get entries() {
      return entries.slice(0, at + 1);
    },
    read: () => entries[at] ?? '/',
    push(url) {
      entries.splice(at + 1, entries.length, url);
      at = entries.length - 1;
    },
    replace(url) {
      entries[at] = url;
    },
    listen(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    back() {
      if (at === 0) return;
      at -= 1;
      for (const fn of listeners) fn(entries[at] ?? '/');
    },
  };
}

// ---------- the navigation store ----------

export interface Navigation {
  readonly nav: Readable<Nav>;
  navigate(intent: Intent): void;
}

export interface NavigationOptions {
  scope: Scope;
  width: number;
  history?: HistoryAdapter;
  views?: ViewRegistry;
  warn?: Warn;
  onChange?: (url: string) => void;
  /** the page's own wisp: a task named by a bare id in a URL (`/task/<id>`, a link the CLI printed) is its */
  home?: string;
}

/** A bare session id in a decoded URL becomes the home peer's entity key (`<home>:<id>`), as the app's own
 *  navigation names it; one that names its peer is kept. Without a home, ids stay as they are. */
export function homed(nav: Omit<Nav, 'layout'>, home: string | undefined): Omit<Nav, 'layout'> {
  if (!home) return nav;
  const key = (id: string): SessionId => (id.includes(':') ? id : `${home}:${id}`) as SessionId;
  const main = nav.main.kind === 'task' ? { kind: 'task' as const, id: key(nav.main.id) } : nav.main;
  const side = nav.side.kind === 'changes' || nav.side.kind === 'shell' || nav.side.kind === 'pr' || nav.side.kind === 'preview' ? { ...nav.side, id: key(nav.side.id) } : nav.side;
  return main === nav.main && side === nav.side ? nav : { ...nav, main, side };
}

/** Views a URL or an intent names must be registered: an unknown one lands on Home. */
function knownViews(nav: Omit<Nav, 'layout'>, views: ViewRegistry | undefined): Omit<Nav, 'layout'> {
  if (!views) return nav;
  const main = nav.main.kind === 'view' && !views.accepts('main', nav.main.id, nav.main.params) ? ({ kind: 'home' } as const) : nav.main;
  const side = nav.side.kind === 'view' && !views.accepts('side', nav.side.id, null) ? ({ kind: 'none' } as const) : nav.side;
  const overlays = nav.overlays.filter((o) => views.accepts('overlay', o.id, o.params));
  return { main, side, overlays };
}

export function createNavigation(o: NavigationOptions): Navigation {
  const warn = o.warn ?? (() => {});
  const url0 = o.history?.read() ?? '/';
  const start = knownViews(homed(decodeNav(url0), o.home), o.views);
  const state = signal<Nav>({ ...initialNav(o.width), ...start });

  const commit = (next: Nav, push: boolean): void => {
    const cur = untracked(state);
    if (next === cur || sameNav(next, cur)) return;
    state(next);
    const url = encodeNav(next);
    if (o.history && url !== o.history.read()) push ? o.history.push(url) : o.history.replace(url);
    o.onChange?.(url);
  };

  if (o.history) {
    const h = o.history;
    o.scope.add(h.listen((url) => commit(navigate(untracked(state), { t: 'restore', to: knownViews(homed(decodeNav(url), o.home), o.views) }), false)));
  }

  return {
    nav: () => state(),
    navigate(intent) {
      const cur = untracked(state);
      const next = navigate(cur, intent);
      const checked = { ...next, ...knownViews(next, o.views) };
      if (!sameNav(checked, next)) warn(`navigation to an unregistered view`, intent);
      commit(sameNav(checked, cur) ? cur : checked, pushes(intent));
    },
  };
}
