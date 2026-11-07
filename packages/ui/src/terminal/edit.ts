// The screen's editing primitives: scrolling, erasing, inserting and deleting cells, cursor moves,
// save/restore and the alternate screen. Every escape sequence (sequences.ts) is built from these.

import { PLAIN, type Pen, type Row } from './cells.ts';
import type { Screen } from './screen.ts';

/** Erased cells keep the current background (xterm's behaviour), nothing else. */
export function bgPen(s: Screen): Pen {
  return s.pen.bg === null ? PLAIN : s.pens.pen(null, s.pen.bg, 0);
}

function reuse(s: Screen, r: Row): Row | null {
  if (r.c.length !== s.cols) return null;
  r.c.fill(' ');
  r.p.fill(bgPen(s));
  r.w.fill(1);
  r.wrapped = false;
  return r;
}

/**
 * Rows leave the top of the scroll region. Off the top of the whole normal screen they go to the
 * scrollback; a full scrollback's oldest row is blanked and used again (no garbage per line).
 */
export function scrollUp(s: Screen, count: number, top = s.top, bottom = s.bottom): void {
  const rows = s.screen;
  const n = Math.min(count, bottom - top + 1);
  const whole = top === 0 && bottom === rows.length - 1;
  const toBack = !s.alt && top === 0 && bottom === s.rows - 1;
  for (let i = 0; i < n; i++) {
    const gone = whole ? rows.shift() : rows.splice(top, 1)[0];
    let fresh: Row | null = null;
    if (toBack && gone) {
      s.back.push(gone);
      if (s.back.length > s.limit) {
        const old = s.back.shift();
        fresh = old ? reuse(s, old) : null;
        s.dropped++;
      }
    }
    fresh ??= s.blank(bgPen(s));
    if (whole) rows.push(fresh);
    else rows.splice(bottom, 0, fresh);
  }
  // Rows that moved are new at their place to a painter (it compares rows by identity): only the
  // blank ones need marking.
  for (let y = bottom - n + 1; y <= bottom; y++) s.touch(y);
}

export function scrollDown(s: Screen, count: number, top = s.top, bottom = s.bottom): void {
  const rows = s.screen;
  const n = Math.min(count, bottom - top + 1);
  for (let i = 0; i < n; i++) {
    rows.splice(bottom, 1);
    rows.splice(top, 0, s.blank(bgPen(s)));
  }
  for (let y = top; y <= bottom; y++) s.touch(y);
}

/** Deleted lines (CSI M) are gone, not scrollback. */
export function deleteLines(s: Screen, count: number): void {
  if (s.y < s.top || s.y > s.bottom) return;
  const rows = s.screen;
  const k = Math.min(count, s.bottom - s.y + 1);
  for (let i = 0; i < k; i++) {
    rows.splice(s.y, 1);
    rows.splice(s.bottom, 0, s.blank(bgPen(s)));
  }
  for (let y = s.y; y <= s.bottom; y++) s.touch(y);
  s.x = 0;
}

export function erase(s: Screen, y: number, start: number, end: number): void {
  const r = s.screen[y];
  if (!r) return;
  const p = bgPen(s);
  const from = Math.max(0, start);
  const to = Math.min(s.cols, end);
  if (from > 0 && r.w[from] === 0) {
    r.c[from - 1] = ' ';
    r.w[from - 1] = 1;
  }
  if (to < s.cols && r.w[to] === 0) {
    r.c[to] = ' ';
    r.w[to] = 1;
  }
  for (let x = from; x < to; x++) {
    r.c[x] = ' ';
    r.p[x] = p;
    r.w[x] = 1;
  }
  if (to >= s.cols) r.wrapped = false;
  s.touch(y);
}

export function insertChars(s: Screen, count: number): void {
  const r = s.screen[s.y];
  if (!r) return;
  const x = s.x;
  const n = Math.min(count, s.cols - x);
  const p = bgPen(s);
  r.c.splice(s.cols - n, n);
  r.c.splice(x, 0, ...new Array<string>(n).fill(' '));
  r.p.splice(s.cols - n, n);
  r.p.splice(x, 0, ...new Array<Pen>(n).fill(p));
  r.w.copyWithin(x + n, x, s.cols - n);
  r.w.fill(1, x, x + n);
  s.touch(s.y);
}

export function deleteChars(s: Screen, count: number): void {
  const r = s.screen[s.y];
  if (!r) return;
  const n = Math.min(count, s.cols - s.x);
  const p = bgPen(s);
  r.c.splice(s.x, n);
  r.c.push(...new Array<string>(n).fill(' '));
  r.p.splice(s.x, n);
  r.p.push(...new Array<Pen>(n).fill(p));
  r.w.copyWithin(s.x, s.x + n);
  r.w.fill(1, s.cols - n);
  s.touch(s.y);
}

/** CUP and friends: y counts from the scroll region's top when origin mode is on. */
export function moveTo(s: Screen, x: number, y: number): void {
  const old = s.y;
  const top = s.modes.origin ? s.top : 0;
  const bottom = s.modes.origin ? s.bottom : s.rows - 1;
  s.x = Math.max(0, Math.min(s.cols - 1, x));
  s.y = Math.max(top, Math.min(bottom, y + top));
  s.wrapNext = false;
  s.touch(old);
  s.touch(s.y);
}

/** the cursor's row as a move would count it (relative to the region in origin mode) */
export const rowFromTop = (s: Screen): number => s.y - (s.modes.origin ? s.top : 0);

export function save(s: Screen): void {
  s.saved = { x: s.x, y: s.y, pen: s.pen, wrapNext: s.wrapNext, origin: s.modes.origin, charset: [s.charset[0], s.charset[1]], gl: s.gl };
}

export function restore(s: Screen): void {
  const v = s.saved ?? { x: 0, y: 0, pen: PLAIN, wrapNext: false, origin: false, charset: [null, null], gl: 0 };
  const old = s.y;
  s.x = Math.min(v.x, s.cols - 1);
  s.y = Math.min(v.y, s.rows - 1);
  s.pen = v.pen;
  s.wrapNext = v.wrapNext;
  s.modes.origin = v.origin;
  s.charset = [v.charset[0], v.charset[1]];
  s.gl = v.gl;
  s.touch(old);
  s.touch(s.y);
}

export function setAlt(s: Screen, on: boolean, o: { save?: boolean } = {}): void {
  if (on === (s.alt !== null)) return;
  if (on) {
    if (o.save) save(s);
    s.alt = Array.from({ length: s.rows }, () => s.blank());
  } else {
    s.alt = null;
    if (o.save) restore(s);
  }
  for (let y = 0; y < s.rows; y++) s.touch(y);
}

/**
 * Changes the size. No reflow: rows are cut or padded; a shorter screen pushes rows above the
 * cursor into the scrollback, a taller one brings them back.
 */
export function resizeScreen(s: Screen, cols: number, rows: number): boolean {
  const c = Math.max(2, Math.trunc(cols));
  const r = Math.max(1, Math.trunc(rows));
  if (c === s.cols && r === s.rows) return false;
  for (const list of [s.normal, s.alt, s.back]) for (const row of list ?? []) fit(s, row, c);
  refit(s, s.normal, c, r);
  if (s.alt) refit(s, s.alt, c, r);
  s.cols = c;
  s.rows = r;
  s.top = 0;
  s.bottom = r - 1;
  s.x = Math.min(s.x, c - 1);
  s.y = Math.max(0, Math.min(s.y, r - 1));
  s.wrapNext = false;
  s.cleared++; // the scrollback may have changed in the middle: painters start over
  for (let y = 0; y < r; y++) s.touch(y);
  return true;
}

function fit(s: Screen, row: Row, cols: number): void {
  const n = row.c.length;
  if (cols < n) {
    row.c.length = cols;
    row.p.length = cols;
    row.w = row.w.slice(0, cols);
    if (row.w[cols - 1] === 2) {
      row.c[cols - 1] = ' ';
      row.w[cols - 1] = 1;
    }
  } else if (cols > n) {
    const w = new Uint8Array(cols).fill(1);
    w.set(row.w);
    row.w = w;
    for (let x = n; x < cols; x++) {
      row.c.push(' ');
      row.p.push(PLAIN);
    }
  }
  row.v = ++s.version;
}

/** shorter: blank rows under the cursor go first, then rows off the top; taller: the scrollback comes back down */
function refit(s: Screen, list: Row[], cols: number, rows: number): void {
  const cur = list === s.screen;
  const blank = (row: Row | undefined): boolean => row !== undefined && row.c.every((ch) => ch === ' ') && row.p.every((p) => p === PLAIN);
  while (list.length > rows) {
    if (blank(list.at(-1)) && (!cur || s.y < list.length - 1)) list.pop();
    else {
      const gone = list.shift();
      if (gone && list === s.normal) {
        s.back.push(gone);
        if (s.back.length > s.limit) (s.back.shift(), s.dropped++);
      }
      if (cur) s.y = Math.max(0, s.y - 1);
    }
  }
  while (list.length < rows) {
    const up = list === s.normal && cur ? s.back.pop() : undefined;
    if (up) {
      list.unshift(up);
      s.y++;
    } else list.push(s.rowsOf.blank(cols, PLAIN));
  }
}
