// The list's structure, recomputed only when a row's place could change. A token streaming into one
// running task patches that row many times a second; its section and order stay the same, so the
// sections, the flattened rows and the virtual list's offsets must not be rebuilt for it (AGENTS.md:
// no full-list work per event). Each row's placement signature (the fields sections() reads) is
// kept per row object; a new list whose rows changed only outside those fields returns the last
// answer itself. The check is one reference compare per row, plus a signature for the rows that
// changed: about 10 µs for 5k rows (spikes/shell-list-bench).

import type { EntityKey, Plan, Row, SessionRow } from '../types.ts';
import { sections, type Filter, type Keyed, type Sections } from './sections.ts';

/** Everything sections() reads off a row. Working sorts by createdAt, so a running row's updatedAt is left out. */
export function signature(s: SessionRow): string {
  const l = s.later;
  return [
    s.state,
    s.archived ? 1 : 0,
    s.forLater ? `${s.forLater.at}${s.forLater.by ?? ''}` : '',
    s.unread ? 1 : 0,
    s.state === 'running' ? '' : s.updatedAt,
    s.createdAt,
    l?.length ? `${l.length}.${l[0]?.at}.${l.some((x) => !x.remind) ? 1 : 0}` : '',
    s.held ? `${s.held.waiting ? 1 : 0}.${s.held.until ?? ''}` : '',
    s.reminder ? 1 : 0,
    s.pending ? 1 : 0,
    s.tui ? 1 : 0,
    s.term ? 1 : 0,
    s.groupId ?? '',
    s.parentId ?? '',
    s.crew ? `${s.crew.id}.${s.crew.job ?? ''}` : '',
    s.projectId ?? '',
    (s.also ?? []).map((a) => a.projectId ?? '').join(','),
  ].join('|');
}

export interface PlacementInput {
  readonly keys: readonly EntityKey[];
  readonly rows: readonly SessionRow[];
  readonly plans: readonly Row<Plan>[];
  readonly filter: Filter;
  /** anything else the filter depends on (a predicate's inputs) */
  readonly filterKey: string;
}

export interface Placement {
  (input: PlacementInput): Sections;
  /** how many times the sections were actually rebuilt (tests, the bench) */
  readonly builds: () => number;
}

export function createPlacement(): Placement {
  const sigs = new WeakMap<object, string>();
  const sigOf = (s: SessionRow): string => {
    let g = sigs.get(s);
    if (g === undefined) {
      g = signature(s);
      sigs.set(s, g);
    }
    return g;
  };
  const last: { input?: PlacementInput; out?: Sections; sigs: string[]; builds: number } = { sigs: [], builds: 0 };

  const unchanged = (a: PlacementInput, b: PlacementInput): boolean => {
    if (a.filterKey !== b.filterKey || a.plans !== b.plans || a.keys.length !== b.keys.length) return false;
    for (let i = 0; i < a.keys.length; i++) {
      if (a.keys[i] !== b.keys[i]) return false;
      const row = a.rows[i];
      if (row === b.rows[i] || row === undefined) continue;
      if (sigOf(row) !== last.sigs[i]) return false;
    }
    return true;
  };

  const place = ((input: PlacementInput): Sections => {
    if (last.input && last.out && unchanged(input, last.input)) {
      last.input = input;
      return last.out;
    }
    const all: Keyed[] = [];
    for (let i = 0; i < input.keys.length; i++) {
      const key = input.keys[i];
      const s = input.rows[i];
      if (key !== undefined && s !== undefined) all.push({ key, s });
    }
    last.sigs = input.rows.map(sigOf);
    last.input = input;
    last.out = sections(all, input.filter, input.plans);
    last.builds++;
    return last.out;
  }) as Placement;
  Object.defineProperty(place, 'builds', { value: () => last.builds });
  return place;
}
