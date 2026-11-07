// Escape sequences: ESC, CSI (moves, erase, scroll, modes, SGR), OSC (title, colour queries).
// Each case is the xterm behaviour agent TUIs rely on; the primitives are in edit.ts.

import { BLINK, BOLD, DIM, HIDDEN, INVERSE, ITALIC, PLAIN, STRIKE, UNDER, type Color } from './cells.ts';
import { deleteChars, deleteLines, erase, insertChars, moveTo, restore, rowFromTop, save, scrollDown, scrollUp, setAlt } from './edit.ts';
import type { Screen } from './screen.ts';

export function runEsc(s: Screen, ch: string): void {
  s.state = 'ground';
  switch (ch) {
    case '[':
      s.state = 'csi';
      s.buf = '';
      return;
    case ']':
      s.state = 'osc';
      s.buf = '';
      return;
    case 'P':
    case '_':
    case '^':
    case 'X':
      s.state = 'str';
      return;
    case '(':
    case ')':
      s.state = 'charset';
      s.buf = ch;
      return;
    case '*':
    case '+':
    case '#':
    case '%':
    case ' ':
      s.state = 'skip';
      return;
    case '7':
      return save(s);
    case '8':
      return restore(s);
    case 'D':
      return s.index();
    case 'E':
      s.x = 0;
      return s.index();
    case 'M':
      return s.reverseIndex();
    case 'c':
      return s.reset();
  }
}

interface Args {
  readonly prefix: string;
  readonly inter: string;
  readonly list: readonly number[];
  /** the i-th parameter, `d` when missing or 0 */
  n(i: number, d?: number): number;
  /** the i-th parameter as given, `d` when missing */
  raw(i: number, d?: number): number;
}

function parse(body: string): Args {
  const prefix = /^[?>=<]/.test(body) ? body.charAt(0) : '';
  const inter = /[ -/]+$/.exec(body)?.[0] ?? '';
  const ps = body.slice(prefix.length, body.length - inter.length);
  const list = ps ? ps.split(';').map((a) => (a === '' ? Number.NaN : Number.parseInt(a, 10))) : [];
  const at = (i: number): number => list[i] ?? Number.NaN;
  return {
    prefix,
    inter,
    list,
    n: (i, d = 1) => (Number.isFinite(at(i)) && at(i) > 0 ? at(i) : d),
    raw: (i, d = 0) => (Number.isFinite(at(i)) ? at(i) : d),
  };
}

export function runCsi(s: Screen, body: string, final: string): void {
  const a = parse(body);
  if (a.inter) {
    if (final === 'p' && a.inter === '!') return softReset(s);
    if (final === 'p' && a.inter === '$') return s.onReply(`\x1b[${a.prefix}${a.raw(0)};${a.prefix === '?' ? modeState(s, a.raw(0)) : 0}$y`); // DECRQM
    return; // DECSCUSR (cursor style) and the like
  }
  if (a.prefix) {
    if (final === 'h' || final === 'l') return void (a.prefix === '?' && decMode(s, a.list, final === 'h'));
    if (final === 'c' && a.prefix === '>') return s.onReply('\x1b[>0;10;1c');
    if (final === 'n' && a.prefix === '?' && a.raw(0) === 6) return s.onReply(`\x1b[?${s.y + 1};${s.x + 1}R`);
    return; // ?u (kitty keyboard query): no answer means no support, and DA settles it
  }
  if (!cursorCsi(s, a, final)) editCsi(s, a, final);
}

/** moves: true when `final` was one */
function cursorCsi(s: Screen, a: Args, final: string): boolean {
  const y = rowFromTop(s);
  switch (final) {
    case 'A':
      return (moveTo(s, s.x, y - a.n(0)), true);
    case 'B':
    case 'e':
      return (moveTo(s, s.x, y + a.n(0)), true);
    case 'C':
    case 'a':
      return (moveTo(s, s.x + a.n(0), y), true);
    case 'D':
      return (moveTo(s, Math.min(s.x, s.cols - 1) - a.n(0), y), true);
    case 'E':
      return (moveTo(s, 0, y + a.n(0)), true);
    case 'F':
      return (moveTo(s, 0, y - a.n(0)), true);
    case 'G':
    case '`':
      return (moveTo(s, a.n(0) - 1, y), true);
    case 'H':
    case 'f':
      return (moveTo(s, a.n(1) - 1, a.n(0) - 1), true);
    case 'd':
      return (moveTo(s, s.x, a.n(0) - 1), true);
    case 'I':
      for (let i = 0; i < a.n(0); i++) s.control(0x09);
      return true;
    case 'Z': {
      let x = s.x;
      for (let i = 0; i < a.n(0); i++) x = Math.max(0, (Math.ceil(x / 8) - 1) * 8);
      return (moveTo(s, x, y), true);
    }
    case 's':
      return (save(s), true);
    case 'u':
      return (restore(s), true);
  }
  return false;
}

// size-ok: one case per CSI final, each a line or two
function editCsi(s: Screen, a: Args, final: string): void {
  switch (final) {
    case '@':
      return insertChars(s, a.n(0));
    case 'J':
      return eraseDisplay(s, a.raw(0));
    case 'K': {
      const m = a.raw(0);
      if (m === 0) erase(s, s.y, s.x, s.cols);
      else if (m === 1) erase(s, s.y, 0, s.x + 1);
      else if (m === 2) erase(s, s.y, 0, s.cols);
      return;
    }
    case 'L':
      if (s.y >= s.top && s.y <= s.bottom) (scrollDown(s, a.n(0), s.y, s.bottom), (s.x = 0));
      return;
    case 'M':
      return deleteLines(s, a.n(0));
    case 'P':
      return deleteChars(s, a.n(0));
    case 'X':
      return erase(s, s.y, s.x, s.x + a.n(0));
    case 'S':
      return scrollUp(s, a.n(0));
    case 'T':
      return scrollDown(s, a.n(0));
    case 'b': {
      const r = s.screen[s.y];
      const last = s.x > 0 ? (r?.c[s.x - 1] ?? ' ') : ' ';
      for (let i = 0; i < Math.min(a.n(0), 1000); i++) s.print(last);
      return;
    }
    case 'c':
      return s.onReply('\x1b[?62;22c'); // a VT220 with ANSI colour
    case 'h':
    case 'l':
      if (a.list.includes(4)) s.modes.insert = final === 'h';
      return;
    case 'm':
      return sgr(s, a.list);
    case 'n':
      if (a.raw(0) === 5) s.onReply('\x1b[0n');
      if (a.raw(0) === 6) s.onReply(`\x1b[${rowFromTop(s) + 1};${s.x + 1}R`);
      return;
    case 'r': {
      const top = a.n(0) - 1;
      const bottom = a.n(1, s.rows) - 1;
      if (top < bottom && bottom < s.rows) {
        s.top = top;
        s.bottom = bottom;
        moveTo(s, 0, 0);
      }
      return;
    }
    case 't':
      if (a.raw(0) === 18) s.onReply(`\x1b[8;${s.rows};${s.cols}t`);
      return;
  }
}

function eraseDisplay(s: Screen, m: number): void {
  if (m === 3) {
    s.back = [];
    s.cleared++;
  } else if (m === 0) {
    erase(s, s.y, s.x, s.cols);
    for (let y = s.y + 1; y < s.rows; y++) erase(s, y, 0, s.cols);
  } else if (m === 1) {
    for (let y = 0; y < s.y; y++) erase(s, y, 0, s.cols);
    erase(s, s.y, 0, s.x + 1);
  } else if (m === 2) for (let y = 0; y < s.rows; y++) erase(s, y, 0, s.cols);
}

function softReset(s: Screen): void {
  s.pen = PLAIN;
  s.top = 0;
  s.bottom = s.rows - 1;
  Object.assign(s.modes, { appCursor: false, wrap: true, cursor: true, origin: false, insert: false });
}

/** DECRQM's answer for DEC mode m: 1 set, 2 reset, 0 not one this screen knows (programs ask before they use one). */
function modeState(s: Screen, m: number): 0 | 1 | 2 {
  const M = s.modes;
  const alt = s.alt !== null;
  const known: Readonly<Record<number, boolean>> = { 1: M.appCursor, 6: M.origin, 7: M.wrap, 25: M.cursor, 47: alt, 1047: alt, 1049: alt, 1000: M.mouse === 1000, 1002: M.mouse === 1002, 1003: M.mouse === 1003, 1004: M.focus, 1006: M.sgrMouse, 2004: M.paste, 2026: M.sync };
  const v = known[m];
  return v === undefined ? 0 : v ? 1 : 2;
}

// size-ok: one case per DEC private mode
function decMode(s: Screen, list: readonly number[], on: boolean): void {
  for (const m of list) {
    switch (m) {
      case 1:
        s.modes.appCursor = on;
        break;
      case 6:
        s.modes.origin = on;
        moveTo(s, 0, 0);
        break;
      case 7:
        s.modes.wrap = on;
        break;
      case 25:
        s.modes.cursor = on;
        s.touch(s.y);
        break;
      case 47:
      case 1047:
        setAlt(s, on);
        break;
      case 1049:
        setAlt(s, on, { save: true });
        break;
      case 1000:
      case 1002:
      case 1003:
        s.modes.mouse = on ? m : 0;
        break;
      case 1006:
        s.modes.sgrMouse = on;
        break;
      case 2004:
        s.modes.paste = on;
        break;
      case 1004:
        s.modes.focus = on;
        break;
      case 2026:
        s.modes.sync = on;
        if (on) s.syncAt = s.now();
        break;
    }
  }
}

const FLAG_ON: Readonly<Record<number, number>> = { 1: BOLD, 2: DIM, 3: ITALIC, 4: UNDER, 5: BLINK, 6: BLINK, 7: INVERSE, 8: HIDDEN, 9: STRIKE, 21: UNDER };
const FLAG_OFF: Readonly<Record<number, number>> = { 22: BOLD | DIM, 23: ITALIC, 24: UNDER, 25: BLINK, 27: INVERSE, 28: HIDDEN, 29: STRIKE };
const hex2 = (v: number): string => (v & 255).toString(16).padStart(2, '0');

function sgr(s: Screen, input: readonly number[]): void {
  const args = input.length ? input : [0];
  let { fg, bg, f } = s.pen;
  for (let i = 0; i < args.length; i++) {
    const v = args[i];
    const a = v !== undefined && Number.isFinite(v) ? v : 0;
    const on = FLAG_ON[a];
    const off = FLAG_OFF[a];
    if (a === 0) [fg, bg, f] = [null, null, 0];
    else if (on !== undefined) f |= on;
    else if (off !== undefined) f &= ~off;
    else if (a >= 30 && a <= 37) fg = a - 30;
    else if (a === 39) fg = null;
    else if (a >= 40 && a <= 47) bg = a - 40;
    else if (a === 49) bg = null;
    else if (a >= 90 && a <= 97) fg = a - 90 + 8;
    else if (a >= 100 && a <= 107) bg = a - 100 + 8;
    else if (a === 38 || a === 48 || a === 58) {
      let c: Color = null;
      if (args[i + 1] === 5) {
        c = (args[i + 2] ?? 0) & 255;
        i += 2;
      } else if (args[i + 1] === 2) {
        c = `#${hex2(args[i + 2] ?? 0)}${hex2(args[i + 3] ?? 0)}${hex2(args[i + 4] ?? 0)}`;
        i += 4;
      }
      if (a === 38) fg = c;
      else if (a === 48) bg = c;
    }
  }
  s.pen = s.pens.pen(fg, bg, f);
}

export function runOsc(s: Screen, body: string): void {
  const i = body.indexOf(';');
  const id = i < 0 ? body : body.slice(0, i);
  const arg = i < 0 ? '' : body.slice(i + 1);
  if (id === '0' || id === '2') s.title = arg.slice(0, 200);
  // Programs that pick a light or dark theme ask for the colours.
  if ((id === '10' || id === '11') && arg === '?') {
    const hex = (id === '10' ? s.colors.fg : s.colors.bg).replace('#', '');
    const [r, g, b] = [0, 2, 4].map((k) => hex.slice(k, k + 2).repeat(2));
    s.onReply(`\x1b]${id};rgb:${r}/${g}/${b}\x1b\\`);
  }
}
