// The cells a terminal screen is made of: pens (a cell's look), rows of cells, and how wide a
// character is. DOM-free, shared by the screen (screen.ts) and the painter (paint.ts).

/** A colour: null (the terminal's own), 0–255 (the xterm palette) or '#rrggbb' (truecolor). */
export type Color = number | string | null;

/** The look of a cell. Pens are interned and frozen, so rows compare them by identity. */
export interface Pen {
  readonly fg: Color;
  readonly bg: Color;
  readonly f: number;
}

// Flags in Pen.f.
export const BOLD = 1;
export const DIM = 2;
export const ITALIC = 4;
export const UNDER = 8;
export const BLINK = 16;
export const INVERSE = 32;
export const HIDDEN = 64;
export const STRIKE = 128;

/** Pens by look. Bounded by what programs use: a few hundred even for a truecolor TUI. */
export interface PenCache {
  pen(fg?: Color, bg?: Color, f?: number): Pen;
}

export const PLAIN: Pen = Object.freeze({ fg: null, bg: null, f: 0 });

export function penCache(): PenCache {
  const pens = new Map<string, Pen>([['null|null|0', PLAIN]]);
  return {
    pen(fg = null, bg = null, f = 0) {
      const k = `${fg}|${bg}|${f}`;
      let p = pens.get(k);
      if (!p) {
        // a program cycling truecolors could grow this forever: start over past a bound
        if (pens.size > 4096) pens.clear();
        p = Object.freeze({ fg, bg, f });
        pens.set(k, p);
      }
      return p;
    },
  };
}

/**
 * One row. `c` holds a cell's text ('' for the right half of a wide character, a base plus its
 * combining marks otherwise), `p` its pen, `w` its width (1, 2, or 0 for a wide char's right
 * half). `v` moves when the row changes: a painter repaints rows whose `v` (or identity) moved.
 */
export interface Row {
  c: string[];
  p: Pen[];
  w: Uint8Array;
  wrapped: boolean;
  v: number;
}

/** Blank rows are copied from kept ones: a scrolling log makes one per line. */
export interface RowFactory {
  blank(cols: number, p: Pen): Row;
}

export function rowFactory(): RowFactory {
  const chars = new Map<number, string[]>();
  const widths = new Map<number, Uint8Array>();
  const pens = new Map<string, Pen[]>();
  return {
    blank(cols, p) {
      let c = chars.get(cols);
      let w = widths.get(cols);
      if (!c || !w) {
        if (chars.size > 8) (chars.clear(), widths.clear(), pens.clear());
        c = new Array<string>(cols).fill(' ');
        w = new Uint8Array(cols).fill(1);
        chars.set(cols, c);
        widths.set(cols, w);
      }
      const pk = `${cols}|${p.fg}|${p.bg}|${p.f}`;
      let ps = pens.get(pk);
      if (!ps) {
        if (pens.size > 64) pens.clear();
        ps = new Array<Pen>(cols).fill(p);
        pens.set(pk, ps);
      }
      return { c: c.slice(), p: ps.slice(), w: w.slice(), wrapped: false, v: 0 };
    },
  };
}

/** Columns a code point takes: 0 for combining marks and joiners, 2 for wide (East Asian, emoji). */
export function charWidth(cp: number): 0 | 1 | 2 {
  if (cp < 0x300) return 1;
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x1ab0 && cp <= 0x1aff) || (cp >= 0x20d0 && cp <= 0x20ff) || (cp >= 0xe0100 && cp <= 0xe01ef)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1fa70 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2;
  return 1;
}

/** DEC special graphics (ESC ( 0): the line-drawing set. */
export const DEC_GRAPHICS: Readonly<Record<string, string>> = { j: '┘', k: '┐', l: '┌', m: '└', n: '┼', q: '─', t: '├', u: '┤', v: '┴', w: '┬', x: '│', a: '▒', '`': '◆', f: '°', g: '±', y: '≤', z: '≥', '~': '·', '{': 'π', '|': '≠', '}': '£', o: '⎺', p: '⎻', r: '⎼', s: '⎽' };

/** A row as plain text, trailing blanks trimmed (copying, tests). */
export function rowText(r: Row): string {
  return r.c.join('').replace(/\s+$/, '');
}
