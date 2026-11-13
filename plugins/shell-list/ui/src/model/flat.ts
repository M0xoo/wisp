// The sections as one flat list of rows for one VirtualList: a heading per section that has
// anything, then its rows while it is unfolded. One scroller for the whole sidebar keeps 5k tasks
// cheap (only what's on screen is in the DOM) and keeps every heading in the flow, as in v1.

import type { EntityKey } from '../types.ts';
import { SECTION_IDS, type Entry, type SectionId, type Sections } from './sections.ts';

export type Item =
  | { readonly t: 'head'; readonly id: SectionId; readonly count: number; readonly open: boolean }
  | { readonly t: 'entry'; readonly section: SectionId; readonly entry: Entry }
  | { readonly t: 'run'; readonly section: SectionId; readonly group: string; readonly key: EntityKey; readonly last: boolean }
  | { readonly t: 'sub'; readonly section: SectionId; readonly lead: EntityKey; readonly key: EntityKey }
  /** what plugins put between the sections: the crew's section after Needs you on the phone (v1 #secCrew) */
  | { readonly t: 'slot'; readonly id: 'shell.list:crew' };

/** Done and Archived start folded; the rest start open. */
export const FOLDED_BY_DEFAULT: ReadonlySet<SectionId> = new Set(['done', 'archived']);

export interface FlatOptions {
  /** sections whose fold differs from the default */
  readonly toggled: ReadonlySet<SectionId>;
  /** the open task: a folded section keeps its row in split view, and its subagent nests under its lead */
  readonly open?: EntityKey | undefined;
  readonly split: boolean;
  /** the open task's lead, when the open task is a subagent */
  readonly openLead?: EntityKey | undefined;
  /** something fills `shell.list:crew` here (the stacked list): it goes right after Needs you, as v1's #secCrew */
  readonly crew?: boolean | undefined;
}

/** Open by default unless folded by default; a toggle flips that. */
export const isOpenSection = (id: SectionId, toggled: ReadonlySet<SectionId>): boolean => !FOLDED_BY_DEFAULT.has(id) !== toggled.has(id);

const holds = (e: Entry, key: EntityKey | undefined): boolean =>
  key !== undefined && (e.key === key || (e.kind === 'group' && e.runs.some((r) => r.key === key)));

export function itemKey(i: Item): string {
  switch (i.t) {
    case 'head':
      return `h:${i.id}`;
    case 'entry':
      return i.entry.key;
    case 'run':
      return `r:${i.key}`;
    case 'sub':
      return `s:${i.key}`;
    case 'slot':
      return `x:${i.id}`;
  }
}

function rowsOf(section: SectionId, e: Entry, o: FlatOptions): Item[] {
  const out: Item[] = [{ t: 'entry', section, entry: e }];
  if (e.kind === 'group') e.runs.forEach((r, i) => out.push({ t: 'run', section, group: e.key, key: r.key, last: i === e.runs.length - 1 }));
  // a subagent opened by itself shows nested under its lead while it is open (v1 lineage.js)
  if (o.open !== undefined && o.openLead !== undefined && holds(e, o.openLead)) out.push({ t: 'sub', section, lead: o.openLead, key: o.open });
  return out;
}

export function flatten(sec: Sections, o: FlatOptions): Item[] {
  const out: Item[] = [];
  for (const id of SECTION_IDS) {
    const list = sec[id];
    if (list.length === 0) continue;
    const open = isOpenSection(id, o.toggled);
    out.push({ t: 'head', id, count: list.length, open });
    // a folded section in split view keeps the task open beside it: its row stays
    const shown = open ? list : o.split ? list.filter((e) => holds(e, o.open) || holds(e, o.openLead)) : [];
    for (const e of shown) out.push(...rowsOf(id, e, o));
    if (id === 'needs' && o.crew) out.push({ t: 'slot', id: 'shell.list:crew' });
  }
  // nothing needs you: the crew still comes first
  if (o.crew && !out.some((i) => i.t === 'slot')) out.unshift({ t: 'slot', id: 'shell.list:crew' });
  return out;
}

/** The task rows in list order (j / k, the switcher's neighbours, the palette's "next"). */
export function taskKeys(items: readonly Item[]): EntityKey[] {
  const out: EntityKey[] = [];
  for (const i of items) {
    if (i.t === 'entry' && i.entry.kind === 'task') out.push(i.entry.key);
    else if (i.t === 'run' || i.t === 'sub') out.push(i.key);
  }
  return out;
}

/** Where a task's row is, for scrolling to it. */
export const indexOfKey = (items: readonly Item[], key: string): number =>
  items.findIndex((i) => (i.t === 'entry' && holds(i.entry, key as EntityKey)) || ((i.t === 'run' || i.t === 'sub') && i.key === key));

/** Each section's run of items: its heading and the rows under it, up to the next heading or slot. */
export function sectionGroups(items: readonly Item[]): { part: string; from: number; to: number }[] {
  const out: { part: string; from: number; to: number }[] = [];
  items.forEach((it, i) => {
    if (it.t === 'head') out.push({ part: `section.${it.id === 'forLater' ? 'forLater' : it.id}`, from: i, to: i });
    else if (it.t !== 'slot' && out.length > 0) {
      const g = out[out.length - 1];
      if (g) g.to = i;
    }
    // a slot (the crew) closes the section before it
    if (it.t === 'slot') out.push({ part: '', from: i, to: i - 1 });
  });
  // a compare task (v1 .task-item): its head and its runs' rows as one card
  items.forEach((it, i) => {
    if (it.t !== 'entry' || it.entry.kind !== 'group') return;
    let to = i;
    while (items[to + 1]?.t === 'run') to++;
    out.push({ part: 'list.compare', from: i, to });
  });
  return out.filter((g) => g.part !== '' && g.to >= g.from);
}
