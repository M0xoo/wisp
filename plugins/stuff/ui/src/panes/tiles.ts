// Home's tiles (v1 pane-bridge.js): side by side, apps pinned on home tile in columns at least
// MIN_TILE wide, sized as relative shares (a grid's fr) so they follow the window. A drag wins over
// a spell's widths and height until the spell's layout changes. Pure.

export const MIN_TILE = 300;
export const TILE_GAP = 12;
export const TILE_HEIGHT = 420;
export const TILE_MIN_HEIGHT = 200;
export const TILE_MAX_HEIGHT = 1600;
const WIDTHS_MAX = 8;

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const inner = (columns: number, room: number): number => room - TILE_GAP * (columns - 1);
const sumOf = (list: readonly number[]): number => list.reduce((a, b) => a + b, 0);
const goodShares = (v: unknown, n: number): v is number[] => Array.isArray(v) && v.length === n && v.every((x) => Number.isFinite(x) && x > 0);

/** Why the `widths` prop can't be kept, or ''. */
export function paneWidthsProblem(v: unknown): string {
  const words = 'widths is relative shares like "2,1,1"';
  if (typeof v !== 'string') return `${words}.`;
  const parts = v.split(',').map((x) => x.trim());
  if (parts.length > WIDTHS_MAX) return `${words}: at most ${WIDTHS_MAX} numbers.`;
  if (parts.some((x) => !/^\d+(\.\d+)?$/.test(x) || Number(x) <= 0 || Number(x) > 100)) return `${words}: 1 to ${WIDTHS_MAX} numbers, each above 0 and at most 100.`;
  return '';
}

/** How many columns: what's asked (else one per pane), as far as they fit, at least one. */
export function tileColumns(count: number, room: number, wanted?: number): number {
  const fit = Math.floor((room + TILE_GAP) / (MIN_TILE + TILE_GAP));
  return Math.max(1, Math.min(wanted || count, count, fit));
}

export const tileFrom = ({ columns, widths, height }: { columns?: number | string; widths?: string; height?: number | string } = {}): string =>
  [columns ?? '', widths ?? '', height ?? ''].join('|');

export interface TileSaved {
  h?: number;
  w: Record<string, number[]>;
}

/** What was saved (`{ from, h, w }`), if it's for this layout. */
export function tileSaved(stored: { from?: string; h?: unknown; w?: unknown } | null | undefined, from: string): TileSaved {
  if (stored?.from !== from) return { w: {} };
  const h = stored.h;
  const w = stored.w && typeof stored.w === 'object' ? (stored.w as Record<string, number[]>) : {};
  return typeof h === 'number' && Number.isFinite(h) && h >= TILE_MIN_HEIGHT && h <= TILE_MAX_HEIGHT ? { h, w } : { w };
}

/** The columns' shares: the drag saved for this many columns, else the spell's, else equal. */
export function tileShares(columns: number, o: { spell?: string; saved?: Record<string, unknown> } = {}): number[] {
  const mine = o.saved?.[columns];
  if (goodShares(mine, columns)) return [...mine];
  const theirs = typeof o.spell === 'string' && !paneWidthsProblem(o.spell) ? o.spell.split(',').map(Number) : null;
  return goodShares(theirs, columns) ? theirs : Array<number>(columns).fill(1);
}

/** Shares no column of which is under MIN_TILE in this room: those are raised, the others give it up. */
export function fitShares(shares: readonly number[], room: number): number[] {
  const total = sumOf(shares);
  const min = (MIN_TILE / inner(shares.length, room)) * total;
  if (!(min > 0) || min * shares.length >= total) return shares.map(() => round3(total / shares.length));
  const raised = new Set<number>();
  for (;;) {
    const free = shares.filter((_, i) => !raised.has(i));
    const scale = (total - raised.size * min) / sumOf(free);
    const under = shares.findIndex((s, i) => !raised.has(i) && s * scale < min);
    if (under < 0) return shares.map((s, i) => round3(raised.has(i) ? min : s * scale));
    raised.add(under);
  }
}

/** Where each boundary between columns sits, in px from the left: the middle of the gap. */
export function tileEdges(shares: readonly number[], room: number): number[] {
  const unit = inner(shares.length, room) / sumOf(shares);
  let at = 0;
  return shares.slice(0, -1).map((s, i) => {
    at += s * unit;
    return Math.round((at + i * TILE_GAP + TILE_GAP / 2) * 10) / 10;
  });
}

/** The boundary after column i moved dx px: the pair keeps its total, each side at least MIN_TILE. */
export function dragShares(shares: readonly number[], i: number, dx: number, room: number): number[] {
  const unit = inner(shares.length, room) / sumOf(shares);
  const a = shares[i] ?? 0;
  const pair = a + (shares[i + 1] ?? 0);
  const min = MIN_TILE / unit;
  if (!(pair >= min * 2) || !Number.isFinite(dx)) return [...shares];
  const left = Math.min(Math.max(a + dx / unit, min), pair - min);
  const out = [...shares];
  const l = round3(left);
  out[i] = l;
  out[i + 1] = round3(pair - l);
  return out;
}
