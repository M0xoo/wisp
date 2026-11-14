// Painting a Screen into the DOM: once per frame, only rows that changed. Scrollback rows never
// change, so they're added once at the end and dropped off the top as the scrollback trims; the
// live screen's rows are repainted only when their identity, version or cursor column moved.
// Framework-free so it can be measured on its own (spikes/terminal).

import { BOLD, DIM, HIDDEN, INVERSE, ITALIC, STRIKE, UNDER, type Color, type Pen, type Row } from './cells.ts';
import type { Screen } from './screen.ts';

/** The 16 ANSI colours for the terminal's dark screen (--term-bg); the rest of the 256 are computed. */
export const ANSI: readonly string[] = ['#1e1e1e', '#f0524f', '#5fb34a', '#d9a521', '#4f8ef7', '#c26fe0', '#2fb6c4', '#c8c8c6', '#6e6e6e', '#ff7672', '#7fd667', '#f2c94c', '#7aa9ff', '#dc95f2', '#5fd6e2', '#f2f2f0'];

const hex2 = (v: number): string => v.toString(16).padStart(2, '0');

export function color256(n: number): string {
  if (n < 16) return ANSI[n] ?? ANSI[7] ?? '';
  if (n >= 232) {
    const v = hex2(8 + (n - 232) * 10);
    return `#${v}${v}${v}`;
  }
  const i = n - 16;
  const c = (k: number): string => hex2(k ? 55 + k * 40 : 0);
  return `#${c(Math.floor(i / 36))}${c(Math.floor(i / 6) % 6)}${c(i % 6)}`;
}

export const colorOf = (c: Color): string | null => (c === null ? null : typeof c === 'number' ? color256(c) : c);

/** A cell's attributes: flags as data-f words, colours inline (a program picks any of 16M). */
export function attrsOf(p: Pen): string {
  let fg = colorOf(p.fg);
  let bg = colorOf(p.bg);
  if (p.f & INVERSE) [fg, bg] = [bg ?? 'var(--term-bg)', fg ?? 'var(--term-ink)'];
  const css: string[] = [];
  if (fg) css.push(`color:${fg}`);
  if (bg) css.push(`background:${bg}`);
  if (p.f & HIDDEN) css.push('color:transparent');
  const f: string[] = [];
  if (p.f & BOLD) f.push('b');
  if (p.f & DIM) f.push('d');
  if (p.f & ITALIC) f.push('i');
  if (p.f & UNDER) f.push('u');
  if (p.f & STRIKE) f.push('s');
  return `${f.length ? ` data-f="${f.join(' ')}"` : ''}${css.length ? ` style="${css.join(';')}"` : ''}`;
}

const escCell = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const plain = (p: Pen): boolean => p.fg === null && p.bg === null && p.f === 0;

/**
 * One row as HTML: runs of cells with the same pen in one span, wide characters in a two-column
 * box, the cursor's cell at `cx` (or -1) marked data-cur.
 */
export function rowHtml(r: Row, cx: number): string {
  let out = '';
  let run = '';
  let runPen: Pen | null = null;
  const flush = (): void => {
    if (run) out += runPen === null || plain(runPen) ? run : `<span${attrsOf(runPen)}>${run}</span>`;
    run = '';
  };
  const n = r.c.length;
  for (let x = 0; x < n; x++) {
    const w = r.w[x];
    if (w === 0) continue;
    const p = r.p[x];
    if (!p) continue;
    const ch = escCell(r.c[x] || ' ');
    if (x === cx || w === 2) {
      flush();
      out += `<span${x === cx ? ' data-cur' : ''}${w === 2 ? ' data-w2' : ''}${attrsOf(p)}>${ch}</span>`;
      runPen = null;
      continue;
    }
    if (p !== runPen) {
      flush();
      runPen = p;
    }
    run += ch;
  }
  flush();
  return out || ' ';
}

/** The background of the screen's four corners when they share one, else null. */
export function edgeBg(rows: readonly Row[]): string | null {
  const top = rows[0];
  const bottom = rows[rows.length - 1];
  if (!top || !bottom) return null;
  const pens = [top.p[0], top.p[top.p.length - 1], bottom.p[0], bottom.p[bottom.p.length - 1]];
  const bgs = pens.map((p) => (!p || p.bg === null || p.f & INVERSE ? null : colorOf(p.bg)));
  const first = bgs[0] ?? null;
  return first !== null && bgs.every((b) => b === first) ? first : null;
}

/** Scrollback rows painted at once when many come in; older ones follow in chunks while idle. */
export const BACK_NOW = 300;
export const BACK_CHUNK = 500;

export interface PaintStats {
  /** live rows repainted this frame */
  rows: number;
  /** scrollback rows added this frame */
  back: number;
}

/** What a painter has put in the DOM so far, so the next frame only adds what changed. */
// size-ok: one painter's state and its three steps (scrollback, live rows, idle fill)
export class Painter {
  readonly #back: HTMLElement;
  readonly #live: HTMLElement;
  #cleared = -1;
  #from = 0;
  #upTo = 0;
  #dropped = 0;
  #rows: (Row | undefined)[] = [];
  #vers: number[] = [];
  #cx: number[] = [];
  #edge: string | null = null;

  constructor(back: HTMLElement, live: HTMLElement) {
    this.#back = back;
    this.#live = live;
  }

  /** the first scrollback row held in the DOM: > 0 while older ones wait for fillBack */
  get from(): number {
    return this.#from;
  }

  /** start over (another screen is shown here) */
  forget(): void {
    this.#cleared = -1;
    this.#rows = [];
    this.#vers = [];
    this.#cx = [];
    this.#edge = null;
    this.#back.replaceChildren();
    this.#live.replaceChildren();
  }

  paint(sc: Screen, cursor: boolean): PaintStats {
    const back = this.#paintBack(sc);
    const rows = this.#paintLive(sc, cursor);
    return { rows, back };
  }

  /** a full-screen program that paints its own background: the box's padding takes that colour too */
  edge(sc: Screen): { changed: boolean; color: string | null } {
    const e = sc.alt ? edgeBg(sc.screen) : null;
    const changed = e !== this.#edge;
    this.#edge = e;
    return { changed, color: e };
  }

  #paintBack(sc: Screen): number {
    const el = this.#back;
    el.hidden = sc.alt !== null;
    if (this.#cleared !== sc.cleared) {
      el.replaceChildren();
      this.#cleared = sc.cleared;
      this.#from = 0;
      this.#upTo = 0;
      this.#dropped = sc.dropped;
    }
    // Rows trimmed off the scrollback's top go, then the new ones are added at its end.
    const drop = sc.dropped - this.#dropped;
    this.#dropped = sc.dropped;
    if (drop > 0) {
      this.#from -= drop;
      this.#upTo = Math.max(0, this.#upTo - drop);
      let gone = Math.min(-this.#from, el.childElementCount);
      while (gone-- > 0) el.firstElementChild?.remove();
      this.#from = Math.max(0, this.#from);
    }
    if (this.#upTo >= sc.back.length) return 0;
    // Many at once (a reopened terminal, a flood): the last screenfuls now, the older ones later.
    if (sc.back.length - this.#upTo > BACK_NOW) {
      el.replaceChildren();
      this.#from = sc.back.length - BACK_NOW;
      this.#upTo = this.#from;
    }
    const added = sc.back.length - this.#upTo;
    let html = '';
    for (let i = this.#upTo; i < sc.back.length; i++) {
      const r = sc.back[i];
      if (r) html += `<div data-kit="term-row">${rowHtml(r, -1)}</div>`;
    }
    el.insertAdjacentHTML('beforeend', html);
    this.#upTo = sc.back.length;
    return added;
  }

  #paintLive(sc: Screen, cursor: boolean): number {
    const el = this.#live;
    const rows = sc.screen;
    while (el.childElementCount > rows.length) el.lastElementChild?.remove();
    while (el.childElementCount < rows.length) {
      const d = el.ownerDocument.createElement('div');
      d.setAttribute('data-kit', 'term-row');
      el.append(d);
    }
    let painted = 0;
    for (let y = 0; y < rows.length; y++) {
      const r = rows[y];
      const node = el.children[y];
      if (!r || !node) continue;
      const cx = cursor && y === sc.y ? Math.min(sc.x, sc.cols - 1) : -1;
      if (this.#rows[y] === r && this.#vers[y] === r.v && this.#cx[y] === cx) continue;
      node.innerHTML = rowHtml(r, cx);
      this.#rows[y] = r;
      this.#vers[y] = r.v;
      this.#cx[y] = cx;
      painted++;
    }
    this.#rows.length = this.#vers.length = this.#cx.length = rows.length;
    return painted;
  }

  /** one chunk of the scrollback above what's painted; false once there's nothing left */
  fillChunk(sc: Screen): boolean {
    if (this.#from <= 0) return false;
    const start = Math.max(0, this.#from - BACK_CHUNK);
    let html = '';
    for (let i = start; i < this.#from; i++) {
      const r = sc.back[i];
      if (r) html += `<div data-kit="term-row">${rowHtml(r, -1)}</div>`;
    }
    // a parsed fragment, prepended whole (insertAdjacentHTML('afterbegin') reverses it in happy-dom)
    const t = this.#back.ownerDocument.createElement('template');
    t.innerHTML = html;
    this.#back.prepend(t.content);
    this.#from = start;
    return this.#from > 0;
  }
}
