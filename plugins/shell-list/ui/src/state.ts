// The list's state, built once per plugin client and shared by the list, its shortcuts and its
// palette source (they all get the same PluginClient). Server data stays in the entity store; what
// this adds is derived (the sections, memoised in placement.ts) plus one plugin store: the view
// (project filter, folded sections). The shell keeps the recent tasks (⌃Tab) itself.

import { computed, defineCommand, entityKey, signal, type DeepReadonly, type EntityKey, type PeerId, type PluginClient, type PluginStore, type Readable } from '@wisp/client';
import { PROJECT_ORDER, projectList, projectOf, type ProjectView } from '@wisp/shell';
import { reordered } from '@wisp/ui';
import { createPlacement } from './model/placement.ts';
import { flatSession, LATER_TOPIC, listPlan } from './model/wire.ts';
import { ALL, needsYou, SECTION_IDS, type Filter, type SectionId, type Sections } from './model/sections.ts';
import { KIND, type Agent, type MachineRef, type Plan, type Project, type Row, type Session, type SessionRow } from './types.ts';

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
  /** in your order (v1 #772, `runtime.projectOrder`) */
  readonly projects: Readable<readonly ProjectView[]>;
  /** drag a project into another place in your order */
  readonly reorderProjects: (id: string, before: string | undefined) => void;
  readonly agents: Readable<ReadonlyMap<string, Row<Agent>>>;
  row(key: EntityKey): Readable<SessionRow | undefined>;
  setFilter(project: string): void;
  /** a crew member picked on the rail: the list holds only its jobs (v1 crew.js inPick); undefined: all */
  setCrew(id: string | undefined): void;
  readonly crew: Readable<string | undefined>;
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

/** `runtime.projectOrder`, saved at once (the chips move as you drop) and rolled back if refused. */
const setOrder = defineCommand<{ peer: PeerId; value: string[] }>({
  id: 'settings.set',
  owner: (a) => a.peer,
  wire: (a) => ({ key: PROJECT_ORDER, value: a.value }),
  optimistic: (_b, a) => [{ e: 'setting', id: entityKey(a.peer, PROJECT_ORDER), op: 'upsert', v: { key: PROJECT_ORDER, value: a.value, locked_by: null } as never }],
});

/** The machines this wisp keeps that have answered, by the peer id the app gives them (their own id). */
export function machinesByPeer(rows: readonly { id: string; body?: { peer?: string | null; name?: string; data?: Record<string, unknown> } }[]): Map<string, MachineRef> {
  const out = new Map<string, MachineRef>();
  for (const r of rows) {
    if (!r.body?.peer) continue;
    // the app names a machine's peer by the machine's own id (apps/web followMachines)
    const id = String(r.id).slice(String(r.id).indexOf(':') + 1);
    out.set(id, { id, name: r.body?.name ?? id, ...(r.body?.data?.['sandbox'] ? { kind: 'sandbox' as const } : {}) });
  }
  return out;
}

const onMachines = new WeakMap<SessionRow, { m: MachineRef | undefined; out: SessionRow }>();
/** The row with the machine it runs on (rows from this wisp: none), the same object while that doesn't change. */
export function onMachine(s: SessionRow, m: MachineRef | undefined): SessionRow {
  const had = onMachines.get(s);
  if (had && had.m?.id === m?.id && had.m?.kind === m?.kind && had.m?.name === m?.name) return had.out;
  const out = m ? ({ ...s, machine: m } as SessionRow) : s;
  onMachines.set(s, { m, out });
  return out;
}

/** The row with the project its folder is in (`projectId`), the same object while that doesn't change. */
const placed = new WeakMap<SessionRow, { ps: readonly ProjectView[]; out: SessionRow }>();
export function inProjectOf(s: SessionRow, ps: readonly ProjectView[]): SessionRow {
  const had = placed.get(s);
  if (had?.ps === ps) return had.out;
  const id = projectOf((s as { cwd?: string }).cwd, ps)?.id;
  const out = had && had.out.projectId === id ? had.out : id === s.projectId ? s : ({ ...s, projectId: id } as SessionRow);
  placed.set(s, { ps, out });
  return out;
}

function createModel(client: PluginClient): ListModel {
  const view = client.defineStore<ViewState>({ id: `${client.id}.view`, version: 1, defaults: { filter: 'all', toggled: [] }, check: checkView, persist: true });
  const keys = client.entities.keys(KIND.session);
  // the server's rows, flat (body, columns, summary: model/wire.ts)
  const raw = client.entities.list<Session>(KIND.session);
  // the projects in your order; a task is in the one that holds its folder (v1 projectFor)
  const projectRows = client.entities.list<unknown>(KIND.project);
  const settingRows = client.entities.list<{ key: string; value: unknown }>('setting');
  const projects = computed(() => projectList(projectRows(), settingRows().find((r) => r.key === PROJECT_ORDER)?.value));
  // a row from another wisp: which machine it is (a sandbox shows as Sandbox), from wisp.machines' rows
  const machineRows = client.entities.list<{ id: string; body?: { peer?: string | null; name?: string; data?: Record<string, unknown> } }>('machines_peer');
  const machines = computed(() => machinesByPeer(machineRows()));
  const rows = computed(() => {
    const ps = projects();
    const ms = machines();
    const ks = keys();
    return raw().map((r, i) => onMachine(inProjectOf(flatSession(r), ps), ms.get(String(ks[i] ?? '').split(':')[0] ?? '')));
  });
  // Scheduled and Drafts: wisp.later's plans, on its own topic
  client.watch(client.home, LATER_TOPIC as never);
  const planRows = client.entities.list<unknown>(KIND.plan);
  const plans = computed(() =>
    planRows()
      .map(listPlan)
      .filter((p): p is Plan => p !== undefined),
  );
  const filtered = createPlacement();
  const unfiltered = createPlacement();
  const crew = signal<string | undefined>(undefined);
  const filterOf = (v: DeepReadonly<ViewState>, who: string | undefined): Filter => ({ project: v.filter, ...(who !== undefined && { crew: who }) });
  const sections = computed(() => filtered({ keys: keys(), rows: rows(), plans: plans(), filter: filterOf(view.value(), crew()), filterKey: `${view.value().filter}|${crew() ?? ''}` }));
  const everything = computed(() => unfiltered({ keys: keys(), rows: rows(), plans: plans(), filter: ALL, filterKey: 'all' }));
  const needsCount = computed(() => everything().needs.filter((e) => (e.kind === 'task' ? needsYou(e.s) : e.kind === 'group' && e.runs.some((r) => needsYou(r.s)))).length);
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
    reorderProjects: (id, before) => {
      const value = reordered(
        projects().map((p) => p.id),
        id,
        before,
      );
      void client.run(setOrder, { peer: client.home, value }).catch(() => undefined);
    },
    agents,
    row: (key) => {
      const r = client.entities.row<Session>(KIND.session, key);
      // the same row the sections hold: its project and the machine it runs on (a sandbox says so)
      return computed(() => {
        const flat = flatSession(r());
        return flat ? onMachine(inProjectOf(flat, projects()), machines().get(String(key).split(':')[0] ?? '')) : flat;
      });
    },
    crew,
    setCrew: (id) => crew(id),
    setFilter: (project) => view.set((v) => ({ filter: project, toggled: [...v.toggled] })),
    toggleSection: (id) => view.set((v) => ({ filter: v.filter, toggled: v.toggled.includes(id) ? v.toggled.filter((x) => x !== id) : [...v.toggled, id] })),
  };
}
