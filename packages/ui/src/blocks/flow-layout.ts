// The `flow` block's layout (v1 web/js/blocks.js R.flow), as pure functions: what the agent wrote
// becomes nodes in columns (longest-path layering, edges pointing back in declaration order are
// loops), a width picks how the columns sit (one row; rows that snake L→R then R→L once a column
// would get under FLOW_MIN_COL; a column under FLOW_VERTICAL_W), and measured node boxes become wires.
import { list, obj, opt, str } from './read.ts';

export const FLOW_MIN_COL = 150; // px a column needs before the row wraps
export const FLOW_GAP = 46; // px between columns
export const FLOW_ROW_GAP = 40; // px between snaking rows
export const FLOW_GUTTER = 70; // px kept on the right for loop wires once anything loops
export const FLOW_VERTICAL_W = 560; // px: under this the columns stack (v1's phone layout)

export interface FlowNode {
  readonly id: string;
  readonly label: string;
  readonly note?: string;
}

export interface FlowEdge {
  readonly from: string;
  readonly to: string;
  readonly label?: string;
  /** points back in declaration order (or at itself): a loop */
  readonly back: boolean;
}

export interface FlowGraph {
  readonly nodes: readonly FlowNode[];
  readonly edges: readonly FlowEdge[];
  /** nodes by layer, left to right */
  readonly cols: readonly (readonly FlowNode[])[];
  readonly hasBack: boolean;
}

function readNodes(v: unknown): FlowNode[] {
  const out: FlowNode[] = [];
  const seen = new Set<string>();
  list(v).forEach((n, i) => {
    const o = typeof n === 'string' || typeof n === 'number' ? { label: n } : obj(n);
    let id = opt(o['id']) ?? String(i);
    // A repeated id still draws; edges reach the first one, as in v1.
    if (seen.has(id)) id = `${id}#${i}`;
    seen.add(id);
    const label = str(o['label']) || str(o['title']) || id;
    const note = opt(o['note']);
    out.push(note === undefined ? { id, label } : { id, label, note });
  });
  return out;
}

function readEdges(v: unknown, nodes: readonly FlowNode[]): Array<{ from: string; to: string; label?: string }> {
  // No edges at all: the nodes are chained in order. An empty list means no wires.
  if (v === undefined || v === null) return nodes.slice(1).map((n, i) => ({ from: nodes[i]?.id ?? '', to: n.id }));
  return list(v).map((e) => {
    const a = Array.isArray(e) ? { from: e[0], to: e[1], label: e[2] } : obj(e);
    const label = opt(a['label']);
    const base = { from: str(a['from']), to: str(a['to']) };
    return label === undefined ? base : { ...base, label };
  });
}

export function flowGraph(b: Readonly<Record<string, unknown>>): FlowGraph {
  const nodes = readNodes(b['nodes']);
  const order = new Map(nodes.map((n, i) => [n.id, i]));
  const edges: FlowEdge[] = [];
  for (const e of readEdges(b['edges'], nodes)) {
    const a = order.get(e.from);
    const z = order.get(e.to);
    if (a === undefined || z === undefined) continue;
    edges.push({ ...e, back: z <= a });
  }
  const level = new Map(nodes.map((n) => [n.id, 0]));
  // Forward edges only go to later nodes, so one pass in order settles every layer.
  for (const n of nodes) {
    for (const e of edges) if (!e.back && e.from === n.id) level.set(e.to, Math.max(level.get(e.to) ?? 0, (level.get(n.id) ?? 0) + 1));
  }
  const cols: FlowNode[][] = [];
  for (const n of nodes) {
    const l = level.get(n.id) ?? 0;
    (cols[l] ??= []).push(n);
  }
  return { nodes, edges, cols: cols.filter((c) => c !== undefined), hasBack: edges.some((e) => e.back) };
}

export type FlowMode = 'row' | 'snake' | 'vertical';

export interface FlowPlan {
  readonly mode: FlowMode;
  readonly perRow: number;
  /** each column's grid cell when snaking (1-based), else undefined */
  readonly cells: readonly ({ readonly row: number; readonly col: number } | undefined)[];
}

/** How `colCount` columns sit in `width` px. */
export function flowPlan(colCount: number, width: number, hasBack: boolean): FlowPlan {
  if (width < FLOW_VERTICAL_W) return { mode: 'vertical', perRow: colCount, cells: [] };
  // The loop gutter is left either way, so the row count doesn't flip once wires are drawn.
  const room = width - 4 - (hasBack ? FLOW_GUTTER : 0);
  const perRow = Math.max(1, Math.floor((room + FLOW_GAP) / (FLOW_MIN_COL + FLOW_GAP)));
  if (colCount <= perRow) return { mode: 'row', perRow, cells: [] };
  const cells = Array.from({ length: colCount }, (_, i) => {
    const row = Math.floor(i / perRow);
    const pos = i % perRow;
    return { row: row + 1, col: row % 2 ? perRow - pos : pos + 1 };
  });
  return { mode: 'snake', perRow, cells };
}

export const samePlan = (a: FlowPlan, b: FlowPlan): boolean => a.mode === b.mode && a.perRow === b.perRow;

/** A node's box, relative to the stage's top-left corner. */
export interface FlowRect {
  readonly l: number;
  readonly t: number;
  readonly r: number;
  readonly b: number;
}

export interface FlowWire {
  readonly d: string;
  readonly back: boolean;
  readonly label?: string;
  readonly lx: number;
  readonly ly: number;
  /** the label sits beside a vertical run (start) or over a horizontal one (middle) */
  readonly anchor: 'start' | 'middle';
}

export interface FlowPad {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** Orthogonal polyline with rounded corners. */
export function orthPath(pts: readonly (readonly [number, number])[], r = 10): string {
  return pts
    .map(([x, y], i) => {
      if (i === 0) return `M${x},${y}`;
      const prev = pts[i - 1];
      const next = pts[i + 1];
      if (!prev || !next) return `L${x},${y}`;
      const [px, py] = prev;
      const [nx, ny] = next;
      const k1 = Math.min(r, Math.hypot(x - px, y - py) / 2);
      const k2 = Math.min(r, Math.hypot(nx - x, ny - y) / 2);
      const ux = Math.sign(x - px), uy = Math.sign(y - py), vx = Math.sign(nx - x), vy = Math.sign(ny - y);
      return `L${x - ux * k1},${y - uy * k1} Q${x},${y} ${x + vx * k2},${y + vy * k2}`;
    })
    .join(' ');
}

const cx = (r: FlowRect): number => (r.l + r.r) / 2;
const cy = (r: FlowRect): number => (r.t + r.b) / 2;

type Leg = Omit<FlowWire, 'back' | 'label'> & { readonly loopTop?: boolean; readonly loopBottom?: boolean };

function backLeg(a: FlowRect, z: FlowRect, mode: FlowMode, width: number, padTop: number): Leg {
  if (mode === 'snake' && Math.abs(cy(a) - cy(z)) > 4) {
    // Out to the right gutter, up, then over the top of the target so it never crosses a card.
    const x = width - 44;
    const y = z.t - 16;
    return { d: orthPath([[a.r, cy(a)], [x, cy(a)], [x, y], [cx(z), y], [cx(z), z.t]]), lx: x + 6, ly: (cy(a) + y) / 2, anchor: 'start', loopTop: z.t - padTop - 16 < 0 };
  }
  if (mode === 'vertical') {
    const x = Math.max(a.r, z.r) + 26;
    return { d: `M${a.r},${cy(a)} C${x},${cy(a)} ${x},${cy(z)} ${z.r},${cy(z)}`, lx: x + 4, ly: (cy(a) + cy(z)) / 2, anchor: 'start' };
  }
  const y = Math.max(a.b, z.b) + 34;
  return { d: `M${cx(a)},${a.b} C${cx(a)},${y} ${cx(z)},${y} ${cx(z)},${z.b}`, lx: (cx(a) + cx(z)) / 2, ly: y - 4, anchor: 'middle', loopBottom: true };
}

function forwardLeg(a: FlowRect, z: FlowRect, mode: FlowMode): Leg {
  if (mode === 'vertical' || (mode === 'snake' && z.t >= a.b)) {
    // Down: the next layer below, or a row turn into the start of the next row.
    const m = (a.b + z.t) / 2;
    return { d: `M${cx(a)},${a.b} C${cx(a)},${m} ${cx(z)},${m} ${cx(z)},${z.t}`, lx: (cx(a) + cx(z)) / 2 + 8, ly: m, anchor: 'start' };
  }
  if (cx(z) < cx(a)) {
    // A right-to-left row.
    const m = (a.l + z.r) / 2;
    return { d: `M${a.l},${cy(a)} C${m},${cy(a)} ${m},${cy(z)} ${z.r},${cy(z)}`, lx: m, ly: (cy(a) + cy(z)) / 2 - 8, anchor: 'middle' };
  }
  const m = (a.r + z.l) / 2;
  return { d: `M${a.r},${cy(a)} C${m},${cy(a)} ${m},${cy(z)} ${z.l},${cy(z)}`, lx: m, ly: (cy(a) + cy(z)) / 2 - 8, anchor: 'middle' };
}

/**
 * The wires between measured nodes, and the padding the stage needs for loops to clear the cards.
 * `padTop` is the top padding the rects were measured with, so a loop over the first row keeps it.
 */
export function flowWires(
  edges: readonly FlowEdge[],
  rect: (id: string) => FlowRect | undefined,
  plan: FlowPlan,
  width: number,
  padTop = 0,
): { readonly wires: FlowWire[]; readonly pad: FlowPad } {
  const wires: FlowWire[] = [];
  let top = false;
  let bottom = false;
  for (const e of edges) {
    const a = rect(e.from);
    const z = rect(e.to);
    if (!a || !z) continue;
    const leg = e.back ? backLeg(a, z, plan.mode, width, padTop) : forwardLeg(a, z, plan.mode);
    top ||= leg.loopTop === true;
    bottom ||= leg.loopBottom === true;
    const w = { d: leg.d, back: e.back, lx: leg.lx, ly: leg.ly, anchor: leg.anchor };
    wires.push(e.label === undefined ? w : { ...w, label: e.label });
  }
  const hasBack = edges.some((e) => e.back);
  return { wires, pad: { top: top ? 22 : 0, right: plan.mode !== 'row' && hasBack ? FLOW_GUTTER : 0, bottom: bottom ? 46 : 0 } };
}
