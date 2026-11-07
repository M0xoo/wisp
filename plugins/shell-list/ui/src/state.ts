// The list's state, built once per plugin client and shared by the list, its shortcuts and its
// palette source (they all get the same PluginClient). Server data stays in the entity store; what
// this adds is derived (the sections, memoised in placement.ts) plus one plugin store: the view
// (project filter, folded sections). The shell keeps the recent tasks (⌃Tab) itself.

import { computed, type DeepReadonly, type EntityKey, type PluginClient, type PluginStore, type Readable } from '@wisp/client';
import { createPlacement } from './model/placement.ts';
import { ALL, needsYou, SECTION_IDS, type Filter, type SectionId, type Sections } from './model/sections.ts';
import { KIND, type Agent, type Plan, type Project, type Row, type Session, type SessionRow } from './types.ts';

export interface ViewState {
  /** a project id, or 'all' (v1 wisp.filter) */
  filter: string;
  /** sections folded or unfolded against their default (v1 wisp.folded, wisp.showDone) */
  toggled: SectionId[];
  [k: string]: string | SectionId[];
}

export interface ListModel {
  readonly view: PluginStore<ViewState>;
  readonly keys: Readable<readonly EntityKey[]>;
  readonly rows: Readable<readonly SessionRow[]>;
  /** the sections under the project filter */
  readonly sections: Readable<Sections>;
  /** every task, no filter: the project counts, the title's (n), the palette */
  readonly everything: Readable<Sections>;
  readonly needsCount: Readable<number>;
  readonly projects: Readable<readonly Row<Project>[]>;
  readonly agents: Readable<ReadonlyMap<string, Row<Agent>>>;
  row(key: EntityKey): Readable<SessionRow | undefined>;
  setFilter(project: string): void;
  toggleSection(id: SectionId): void;
}

const isSection = (v: unknown): v is SectionId => typeof v === 'string' && (SECTION_IDS as readonly string[]).includes(v);

function checkView(v: unknown): ViewState | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const toggled = o['toggled'];
  if (typeof o['filter'] !== 'string' || !Array.isArray(toggled) || !toggled.every(isSection)) return undefined;
  return { filter: o['filter'], toggled };
}

/** Projects by last use, newest first (places.js recentFirst). */
const recentFirst = (a: Row<Project>, b: Row<Project>): number => (b.lastUsedAt ?? b.addedAt ?? 0) - (a.lastUsedAt ?? a.addedAt ?? 0);

// One model per plugin client: the list, the shortcuts and the palette meet here. A WeakMap, so a
// client switched off (its scope disposed, dropped by the shell) takes its model with it.
const MODELS = new WeakMap<PluginClient, ListModel>();

export function modelOf(client: PluginClient): ListModel {
  const had = MODELS.get(client);
  if (had) return had;
  const m = createModel(client);
  MODELS.set(client, m);
  return m;
}

function createModel(client: PluginClient): ListModel {
  const view = client.defineStore<ViewState>({ id: `${client.id}.view`, version: 1, defaults: { filter: 'all', toggled: [] }, check: checkView, persist: true });
  const keys = client.entities.keys(KIND.session);
  const rows = client.entities.list<Session>(KIND.session);
  const plans = client.entities.list<Plan>(KIND.plan);
  const filtered = createPlacement();
  const unfiltered = createPlacement();
  const filterOf = (v: DeepReadonly<ViewState>): Filter => ({ project: v.filter });
  const sections = computed(() => filtered({ keys: keys(), rows: rows(), plans: plans(), filter: filterOf(view.value()), filterKey: view.value().filter }));
  const everything = computed(() => unfiltered({ keys: keys(), rows: rows(), plans: plans(), filter: ALL, filterKey: 'all' }));
  const needsCount = computed(() => everything().needs.filter((e) => (e.kind === 'task' ? needsYou(e.s) : e.kind === 'group' && e.runs.some((r) => needsYou(r.s)))).length);
  const projectList = client.entities.list<Project>(KIND.project);
  const projects = computed(() => [...projectList()].sort(recentFirst));
  const agentList = client.entities.list<Agent>(KIND.agent);
  const agents = computed(() => new Map(agentList().map((a) => [a.id, a])));
  return {
    view,
    keys,
    rows,
    sections,
    everything,
    needsCount,
    projects,
    agents,
    row: (key) => client.entities.row<Session>(KIND.session, key),
    setFilter: (project) => view.set((v) => ({ filter: project, toggled: [...v.toggled] })),
    toggleSection: (id) => view.set((v) => ({ filter: v.filter, toggled: v.toggled.includes(id) ? v.toggled.filter((x) => x !== id) : [...v.toggled, id] })),
  };
}
