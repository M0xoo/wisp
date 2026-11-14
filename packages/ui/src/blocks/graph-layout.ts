// The `graph` block's layout (v1 layoutGraph and R.graph's drawing math), pure: commits → lanes,
// rows, edges, tails and conflict numbers, then the SVG's wires and dots. Lane 0 is the base (what
// is merged into); the other branches take lanes in order of first appearance. Commits are newest
// first; a commit without `parents` descends from the next older commit on its lane, or from where
// its branch forked off the base.
import { bool, list, obj, str } from './read.ts';

export interface GraphCommit {
  readonly hash: string;
  readonly message: string;
  readonly branch: string;
  readonly author: string;
  readonly when: string;
  readonly note: string;
  readonly conflict: boolean;
  readonly merge: boolean;
  /** undefined: not given (the parent is implied) */
  readonly parents: readonly string[] | undefined;
}

export interface GraphRow {
  /** index in commits */
  readonly i: number;
  readonly c: GraphCommit;
  /** its row in the picture (the merge target, when there is one, is row 0) */
  readonly row: number;
  readonly lane: number;
}

export interface GraphEdge {
  readonly from: GraphRow;
  readonly to: GraphRow;
  /** whose colour the wire takes */
  readonly lane: number;
  /** late: stays in the child's lane and curves in near the parent (a fork); early: curves out at once (a merge) */
  readonly bend: 'late' | 'early';
}

export interface GraphLayout {
  readonly rows: readonly GraphRow[];
  readonly lanes: readonly string[];
  /** the head branch's lane: what is being merged */
  readonly head: number;
  readonly edges: readonly GraphEdge[];
  /** rows with no parent drawn: their lane runs on, dashed, to the bottom */
  readonly tails: readonly GraphRow[];
  /** row index (GraphRow.i) → its conflict number, 1… */
  readonly conflictNo: ReadonlyMap<number, number>;
  /** row indexes that are the newest commit of their lane: they carry the branch's tag */
  readonly tips: ReadonlySet<number>;
  readonly into: string;
  /** 1 when the merge target takes row 0 */
  readonly off: 0 | 1;
}

export function readCommit(v: unknown): GraphCommit | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const o = obj(v);
  const parents = Array.isArray(o['parents']) ? list(o['parents']).map(str).filter(Boolean) : undefined;
  return {
    hash: str(o['hash']),
    message: str(o['message']),
    branch: str(o['branch']),
    author: str(o['author']),
    when: str(o['when']),
    note: str(o['note']),
    conflict: bool(o['conflict']),
    merge: bool(o['merge']),
    parents,
  };
}

/** Two hashes name the same commit when one is a prefix of the other (`d29f50` ~ `d29f50a1`). */
export const sameHash = (a: string, z: string): boolean => a !== '' && z !== '' && (a.startsWith(z) || z.startsWith(a));

function parentsOf(r: GraphRow, i: number, rows: readonly GraphRow[]): GraphRow[] {
  const find = (h: string): GraphRow | undefined => rows.find((o) => sameHash(o.c.hash, h));
  const given = (r.c.parents ?? []).map(find).filter((p): p is GraphRow => p !== undefined && p !== r);
  if (given.length) return given;
  const below = rows.slice(i + 1);
  const p = below.find((o) => o.lane === r.lane) ?? (r.lane !== 0 ? below.find((o) => o.lane === 0) : undefined);
  return p ? [p] : [];
}

export function layoutGraph(commitsIn: readonly unknown[], intoIn: string, headIn: string): GraphLayout {
  const commits = commitsIn.map(readCommit).filter((c): c is GraphCommit => c !== undefined);
  const into = intoIn;
  const lanes: string[] = [];
  const laneOf = (name: string): number => {
    const i = lanes.indexOf(name);
    return i >= 0 ? i : lanes.push(name) - 1;
  };
  const base = into || (commits.find((c) => c.branch)?.branch ?? '');
  laneOf(base);
  const off: 0 | 1 = into ? 1 : 0;
  const rows: GraphRow[] = commits.map((c, i) => ({ i, c, row: i + off, lane: laneOf(c.branch || base) }));
  const head = headIn ? laneOf(headIn) : lanes.length > 1 ? 1 : 0;
  const edges: GraphEdge[] = [];
  const tails: GraphRow[] = [];
  rows.forEach((r, i) => {
    const parents = parentsOf(r, i, rows);
    parents.forEach((p, k) => edges.push({ from: r, to: p, lane: k === 0 ? r.lane : p.lane, bend: k === 0 ? 'late' : 'early' }));
    if (!parents.length) tails.push(r);
  });
  const conflictNo = new Map<number, number>();
  for (const r of rows) if (r.c.conflict) conflictNo.set(r.i, conflictNo.size + 1);
  const tips = new Set<number>();
  lanes.forEach((_, l) => {
    const tip = rows.find((r) => r.lane === l);
    if (tip) tips.add(tip.i);
  });
  return { rows, lanes, head, edges, tails, conflictNo, tips, into, off };
}

// --- the picture ------------------------------------------------------------

export const GRAPH_ROW = 30;
export const GRAPH_LANE = 16;

export type MergeState = 'conflict' | 'ready' | 'merged' | 'blocked' | 'pending' | '';
export const MERGE_STATES: readonly Exclude<MergeState, ''>[] = ['conflict', 'ready', 'merged', 'blocked', 'pending'];

/** The merge's state: the agent's word, else conflicts if any, else ready when there is a target. */
export function mergeOf(v: unknown, conflicts: number, into: string): MergeState {
  if (typeof v === 'string' && (MERGE_STATES as readonly string[]).includes(v)) return v as MergeState;
  return conflicts ? 'conflict' : into ? 'ready' : '';
}

/** A lane's colour slot: 'base', '1'…'4' cycling, or 'merged' for a merged head. */
export function laneTone(lane: number, head: number, merged: boolean): string {
  if (lane === 0) return 'base';
  if (merged && lane === head) return 'merged';
  return String(((lane - 1) % 4) + 1);
}

export const laneX = (lane: number): number => 9 + lane * GRAPH_LANE;
export const rowY = (row: number): number => row * GRAPH_ROW + GRAPH_ROW / 2;

/** A wire from a child down to its parent: straight in one lane, else one soft bend. */
export function wirePath(x1: number, y1: number, x2: number, y2: number, bend: 'late' | 'early'): string {
  if (x1 === x2) return `M${x1} ${y1}V${y2}`;
  const r = GRAPH_ROW * 0.8;
  return bend === 'early'
    ? `M${x1} ${y1}C${x1} ${y1 + r} ${x2} ${y1 + r * 0.2} ${x2} ${y1 + r}V${y2}`
    : `M${x1} ${y1}V${y2 - r}C${x1} ${y2 - r * 0.2} ${x2} ${y2 - r} ${x2} ${y2}`;
}

export interface Wire {
  readonly d: string;
  /** a lane's colour slot (laneTone), or the merge state's for the pending merge wire */
  readonly tone: string;
  /** wire: drawn in; tail: dashed run-off; pending: the merge that hasn't happened */
  readonly kind: 'wire' | 'tail' | 'pending';
  /** its place in the drawing order (entry delay) */
  readonly k: number;
}

export interface Dot {
  readonly i: number;
  readonly x: number;
  readonly y: number;
  readonly tone: string;
  readonly kind: 'conflict' | 'merge' | 'plain';
  readonly row: number;
}

export interface GraphPicture {
  readonly width: number;
  readonly height: number;
  readonly wires: readonly Wire[];
  readonly dots: readonly Dot[];
  /** where the merge target sits (row 0, lane 0), when there is one */
  readonly target: { readonly x: number; readonly y: number } | undefined;
}

function targetWires(g: GraphLayout, merge: MergeState, tone: (l: number) => string): Wire[] {
  const out: Wire[] = [];
  const headTip = g.head !== 0 ? g.rows.find((r) => r.lane === g.head) : undefined;
  const baseTip = g.rows.find((r) => r.lane === 0);
  if (baseTip) out.push({ d: `M${laneX(0)} ${rowY(0)}V${rowY(baseTip.row)}`, tone: 'base', kind: 'tail', k: 0 });
  if (headTip) {
    const d = wirePath(laneX(0), rowY(0), laneX(headTip.lane), rowY(headTip.row), 'early');
    out.push(merge === 'merged' ? { d, tone: tone(g.head), kind: 'wire', k: 0 } : { d, tone: merge || 'base', kind: 'pending', k: 0 });
  }
  return out;
}

export function graphPicture(g: GraphLayout, merge: MergeState): GraphPicture {
  const merged = merge === 'merged';
  const tone = (l: number): string => laneTone(l, g.head, merged);
  const width = laneX(Math.max(0, g.lanes.length - 1)) + 10;
  const height = (g.rows.length + g.off) * GRAPH_ROW + 10;
  const wires: Wire[] = g.edges.map((e, k) => ({ d: wirePath(laneX(e.from.lane), rowY(e.from.row), laneX(e.to.lane), rowY(e.to.row), e.bend), tone: tone(e.lane), kind: 'wire', k }));
  for (const r of g.tails) wires.push({ d: `M${laneX(r.lane)} ${rowY(r.row)}V${height}`, tone: tone(r.lane), kind: 'tail', k: 0 });
  if (g.into) wires.push(...targetWires(g, merge, tone));
  const dots: Dot[] = g.rows.map((r) => ({
    i: r.i,
    x: laneX(r.lane),
    y: rowY(r.row),
    tone: tone(r.lane),
    kind: r.c.conflict ? 'conflict' : r.c.merge || (r.c.parents?.length ?? 0) > 1 ? 'merge' : 'plain',
    row: r.row,
  }));
  return { width, height, wires, dots, target: g.into ? { x: laneX(0), y: rowY(0) } : undefined };
}
