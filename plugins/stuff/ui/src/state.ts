// My Stuff's local state, one per plugin client (the page, its cards in answers, the panes and the
// app window share it): the view picks kept in this browser, the `panes` setting, what's hidden
// waiting for its Undo, what the last list held (an agent's news), and the one pane card allowed
// open. Declared once per client: the client refuses a store or setting declared twice.

import { createSignal, type Accessor, type Setter } from 'solid-js';
import type { PluginClient, PluginStore, TypedSettings } from '@wisp/client';
import { isKind } from './kinds.ts';
import type { Grouping, KindFilter, Layout } from './model.ts';

export interface ViewPicks {
  layout: Layout | null; // yours; null: the spell's, else grid
  group: Grouping | null;
  kind: KindFilter;
  [k: string]: string | null; // Json
}

const DEFAULTS: ViewPicks = { layout: null, group: null, kind: 'all' };

function checkPicks(v: unknown): ViewPicks | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const layout = o['layout'] === 'grid' || o['layout'] === 'list' ? o['layout'] : null;
  const group = o['group'] === 'time' || o['group'] === 'task' ? o['group'] : null;
  const kind = o['kind'] === 'all' || isKind(o['kind']) ? (o['kind'] as KindFilter) : 'all';
  return { layout, group, kind };
}

type PanesDecl = readonly [{ readonly key: string; readonly type: 'string'; readonly default: ''; readonly scope: 'server' }];

export interface StuffState {
  readonly picks: PluginStore<ViewPicks>;
  readonly settings: TypedSettings<PanesDecl>;
  readonly panesKey: string;
  readonly hidden: Accessor<ReadonlySet<string>>;
  readonly setHidden: Setter<ReadonlySet<string>>;
  /** the wisp Grids an app can be published to (their hosts) */
  readonly publishTo: Accessor<readonly string[]>;
  readonly setPublishTo: Setter<readonly string[]>;
  /** id → rev as last seen, for "an agent saved …" (undefined until the first list) */
  seen: Map<string, number> | undefined;
  /** one pane card at a time, from any pane */
  readonly busy: { card: boolean };
  /** the dialog My Stuff has up (an Allow card, a pane's write card), drawn by the first ModalHost mounted */
  readonly modal: Accessor<Modal | undefined>;
  readonly setModal: Setter<Modal | undefined>;
  readonly hosts: symbol[];
}

/** An Allow card: resolves 'ok', 'alt' (Pin without) or false. A pane's card: true on Send. */
export type Modal =
  | { readonly kind: 'allow'; readonly head: string; readonly lines: readonly string[]; readonly risky: boolean; readonly ok: string; readonly alt?: string; readonly done: (a: 'ok' | 'alt' | false) => void }
  | { readonly kind: 'card'; readonly head: string; readonly rows: readonly (readonly [string, string, boolean?])[]; readonly prompt: string; readonly done: (yes: boolean) => void };

const states = new WeakMap<PluginClient, StuffState>();

export function stuffState(client: PluginClient): StuffState {
  const had = states.get(client);
  if (had) return had;
  const panesKey = `${client.id}.panes`;
  const decls: PanesDecl = [{ key: panesKey, type: 'string', default: '', scope: 'server' }];
  const [hidden, setHidden] = createSignal<ReadonlySet<string>>(new Set());
  const [publishTo, setPublishTo] = createSignal<readonly string[]>([]);
  const [modal, setModal] = createSignal<Modal | undefined>(undefined);
  const s: StuffState = {
    picks: client.defineStore<ViewPicks>({ id: `${client.id}.view`, version: 1, defaults: DEFAULTS, check: checkPicks, persist: true }),
    settings: client.settings(decls),
    panesKey,
    hidden,
    setHidden,
    publishTo,
    setPublishTo,
    seen: undefined,
    busy: { card: false },
    modal,
    setModal,
    hosts: [],
  };
  states.set(client, s);
  return s;
}
