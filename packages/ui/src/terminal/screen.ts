// A small VT/xterm screen (v1's web/js/term-emu.js, ported): it turns the output of claude, codex,
// a shell and the like into rows of styled cells, and answers the queries they send (cursor
// position, device attributes, colours) through onReply. Enough of xterm for agent TUIs and a
// shell: cursor moves, erase, scroll regions, insert and delete, SGR colours (16, 256, truecolor),
// the alternate screen, bracketed paste, wide characters. DOM-free; the escape sequences
// themselves are dispatched in sequences.ts.

import { charWidth, DEC_GRAPHICS, penCache, PLAIN, rowFactory, rowText, type Pen, type PenCache, type Row, type RowFactory } from './cells.ts';
import { insertChars, resizeScreen, scrollDown, scrollUp } from './edit.ts';
import { runCsi, runEsc, runOsc } from './sequences.ts';

export const SCROLLBACK = 5000;

export interface Modes {
  appCursor: boolean;
  wrap: boolean;
  cursor: boolean;
  paste: boolean;
  /** 0, or the mouse mode a program asked for (1000 clicks, 1002 drags, 1003 all motion) */
  mouse: 0 | 1000 | 1002 | 1003;
  sgrMouse: boolean;
  origin: boolean;
  insert: boolean;
  focus: boolean;
  /** synchronized output (2026): the program is drawing a frame, paint it whole */
  sync: boolean;
}

export interface ScreenOptions {
  /** what the terminal answers the program, typed back into it */
  readonly onReply?: (text: string) => void;
  /** the colours programs ask for (OSC 10 / 11), as #rrggbb */
  readonly colors?: { readonly fg: string; readonly bg: string };
  readonly now?: () => number;
  readonly scrollback?: number;
}

type State = 'ground' | 'esc' | 'csi' | 'osc' | 'osc-esc' | 'str' | 'str-esc' | 'charset' | 'skip';
export type Charset = Readonly<Record<string, string>> | null;

export interface Saved {
  x: number;
  y: number;
  pen: Pen;
  wrapNext: boolean;
  origin: boolean;
  charset: [Charset, Charset];
  gl: 0 | 1;
}

const freshModes = (): Modes => ({ appCursor: false, wrap: true, cursor: true, paste: false, mouse: 0, sgrMouse: false, origin: false, insert: false, focus: false, sync: false });

export class Screen {
  cols: number;
  rows: number;
  onReply: (text: string) => void;
  readonly colors: { readonly fg: string; readonly bg: string };
  readonly now: () => number;
  readonly limit: number;
  readonly pens: PenCache = penCache();
  readonly rowsOf: RowFactory = rowFactory();
  normal: Row[] = [];
  /** the alternate screen's rows while it's on */
  alt: Row[] | null = null;
  /** scrollback, oldest first (normal screen only) */
  back: Row[] = [];
  /** scrollback rows dropped off the top so far: painters count from this */
  dropped = 0;
  /** bumped when the scrollback is wiped or reshaped: painters start over */
  cleared = 0;
  version = 0;
  x = 0;
  y = 0;
  wrapNext = false;
  pen: Pen = PLAIN;
  top = 0;
  bottom = 0;
  saved: Saved | null = null;
  modes: Modes = freshModes();
  /** when the program began a synchronized frame */
  syncAt = 0;
  charset: [Charset, Charset] = [null, null];
  gl: 0 | 1 = 0;
  title = '';
  state: State = 'ground';
  buf = '';
  readonly #watchers = new Set<() => void>();

  constructor(cols = 80, rows = 24, o: ScreenOptions = {}) {
    this.cols = cols;
    this.rows = rows;
    this.onReply = o.onReply ?? (() => {});
    this.colors = o.colors ?? { fg: '#e8e8e6', bg: '#141414' };
    this.now = o.now ?? (() => Date.now());
    this.limit = o.scrollback ?? SCROLLBACK;
    this.reset();
  }

  /** the rows on screen now: the alternate screen's while it's on */
  get screen(): Row[] {
    return this.alt ?? this.normal;
  }

  /** calls fn after each write, resize or reset; returns the unsubscribe */
  watch(fn: () => void): () => void {
    this.#watchers.add(fn);
    return () => this.#watchers.delete(fn);
  }

  #notify(): void {
    for (const fn of this.#watchers) fn();
  }

  reset(): void {
    this.normal = Array.from({ length: this.rows }, () => this.blank(PLAIN));
    this.alt = null;
    this.back = [];
    this.dropped = 0;
    this.x = 0;
    this.y = 0;
    this.wrapNext = false;
    this.pen = PLAIN;
    this.top = 0;
    this.bottom = this.rows - 1;
    this.saved = null;
    this.modes = freshModes();
    this.syncAt = 0;
    this.charset = [null, null];
    this.gl = 0;
    this.title = '';
    this.state = 'ground';
    this.buf = '';
    this.version += 1;
    this.cleared += 1;
    this.#notify();
  }

  blank(p: Pen = PLAIN): Row {
    return this.rowsOf.blank(this.cols, p);
  }

  /** marks row y changed */
  touch(y: number): void {
    const r = this.screen[y];
    if (r) r.v = ++this.version;
  }

  write(text: string): void {
    const n = text.length;
    let i = 0;
    while (i < n) {
      const c = text.charCodeAt(i);
      // Runs of plain ASCII, most of any output, skip the state machine.
      if (c >= 0x20 && c < 0x7f && this.state === 'ground' && !this.charset[this.gl] && !this.modes.insert) {
        let j = i + 1;
        while (j < n && text.charCodeAt(j) >= 0x20 && text.charCodeAt(j) < 0x7f) j++;
        this.#printAscii(text, i, j);
        i = j;
      } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < n) {
        this.#feed(text.slice(i, i + 2));
        i += 2;
      } else this.#feed(text.charAt(i++));
    }
    this.#notify();
  }

  // size-ok: the parser's state machine, one case per state
  #feed(ch: string): void {
    const code = ch.codePointAt(0) ?? 0;
    switch (this.state) {
      case 'ground':
        if (code < 0x20 || code === 0x7f) return this.control(code);
        return this.#print(ch, code);
      case 'esc':
        return runEsc(this, ch);
      case 'csi':
        if (code >= 0x40 && code <= 0x7e) {
          this.state = 'ground';
          return runCsi(this, this.buf, ch);
        }
        if (code === 0x1b) return void ((this.state = 'esc'), (this.buf = ''));
        if (code < 0x20) return this.control(code); // C0 inside CSI runs as usual
        this.buf += ch;
        if (this.buf.length > 64) this.state = 'ground';
        return;
      case 'osc':
        if (code === 0x07) return this.#endOsc();
        if (code === 0x1b) return void (this.state = 'osc-esc');
        this.buf += ch;
        if (this.buf.length > 4096) this.state = 'ground';
        return;
      case 'osc-esc':
        if (ch === '\\') return this.#endOsc();
        this.state = 'ground';
        return this.#feed(ch);
      case 'str': // DCS, APC, PM, SOS: skipped up to ST
        if (code === 0x1b) this.state = 'str-esc';
        else if (code === 0x07) this.state = 'ground';
        return;
      case 'str-esc':
        this.state = ch === '\\' ? 'ground' : 'str';
        return;
      case 'charset':
        this.charset[this.buf === '(' ? 0 : 1] = ch === '0' ? DEC_GRAPHICS : null;
        this.state = 'ground';
        return;
      case 'skip': // one more character (ESC # 8, ESC % G, …)
        this.state = 'ground';
        return;
    }
  }

  #endOsc(): void {
    this.state = 'ground';
    runOsc(this, this.buf);
  }

  control(code: number): void {
    switch (code) {
      case 0x1b:
        this.state = 'esc';
        this.buf = '';
        return;
      case 0x08:
        if (this.x > 0) this.x = Math.min(this.x, this.cols - 1) - 1;
        this.wrapNext = false;
        return this.touch(this.y);
      case 0x09:
        this.x = Math.min(this.cols - 1, (Math.floor(this.x / 8) + 1) * 8);
        this.wrapNext = false;
        return this.touch(this.y);
      case 0x0a:
      case 0x0b:
      case 0x0c:
        return this.index();
      case 0x0d:
        this.x = 0;
        this.wrapNext = false;
        return this.touch(this.y);
      case 0x0e:
        this.gl = 1;
        return;
      case 0x0f:
        this.gl = 0;
        return;
    }
  }

  /** one character at the cursor, as if the program printed it (REP repeats the last one) */
  print(ch: string): void {
    this.#print(ch, ch.codePointAt(0) ?? 0x20);
  }

  #print(input: string, code: number): void {
    const set = this.charset[this.gl];
    const ch = set?.[input] ?? input;
    const w = charWidth(code);
    if (w === 0) return this.#combine(ch);
    if (this.wrapNext || this.x + w > this.cols) {
      if (this.modes.wrap) {
        const cur = this.screen[this.y];
        if (cur) cur.wrapped = true;
        this.x = 0;
        this.index();
      } else this.x = this.cols - w;
      this.wrapNext = false;
    }
    const r = this.screen[this.y];
    if (!r) return;
    if (this.modes.insert) insertChars(this, w);
    this.#clearWide(r, this.x);
    if (w === 2) this.#clearWide(r, this.x + 1);
    r.c[this.x] = ch;
    r.p[this.x] = this.pen;
    r.w[this.x] = w;
    if (w === 2) {
      r.c[this.x + 1] = '';
      r.p[this.x + 1] = this.pen;
      r.w[this.x + 1] = 0;
    }
    this.touch(this.y);
    if (this.x + w >= this.cols) {
      this.x = this.cols - 1;
      this.wrapNext = true;
    } else this.x += w;
  }

  /** a combining mark or joiner goes onto the cell before */
  #combine(ch: string): void {
    const px = this.wrapNext ? this.cols - 1 : this.x - 1;
    const r = this.screen[this.y];
    if (!r || px < 0) return;
    const at = r.w[px] === 0 && px > 0 ? px - 1 : px;
    r.c[at] = (r.c[at] ?? '') + ch;
    this.touch(this.y);
  }

  /** #print for text[i..j), all one column wide: the row is marked changed once per run */
  #printAscii(text: string, from: number, to: number): void {
    const cols = this.cols;
    let r = this.screen[this.y];
    for (let i = from; i < to; i++) {
      if (this.wrapNext || this.x >= cols) {
        if (this.modes.wrap) {
          if (r) r.wrapped = true;
          this.x = 0;
          this.touch(this.y);
          this.index();
          r = this.screen[this.y];
        } else this.x = cols - 1;
        this.wrapNext = false;
      }
      if (!r) return;
      const x = this.x;
      if (r.w[x] !== 1) this.#clearWide(r, x);
      r.c[x] = text.charAt(i);
      r.p[x] = this.pen;
      r.w[x] = 1;
      if (x + 1 >= cols) this.wrapNext = true;
      else this.x = x + 1;
    }
    this.touch(this.y);
  }

  /** writing over half of a wide character blanks the other half */
  #clearWide(r: Row, x: number): void {
    if (x >= this.cols) return;
    if (r.w[x] === 0 && x > 0) {
      r.c[x - 1] = ' ';
      r.w[x - 1] = 1;
    }
    if (r.w[x] === 2 && x + 1 < this.cols) {
      r.c[x + 1] = ' ';
      r.w[x + 1] = 1;
    }
  }

  index(): void {
    this.wrapNext = false;
    if (this.y === this.bottom) scrollUp(this, 1);
    else if (this.y < this.rows - 1) this.y++;
    this.touch(this.y);
  }

  reverseIndex(): void {
    this.wrapNext = false;
    if (this.y === this.top) scrollDown(this, 1);
    else if (this.y > 0) this.y--;
    this.touch(this.y);
  }

  /** a row as plain text (tests, copying) */
  text(r: Row): string {
    return rowText(r);
  }

  resize(cols: number, rows: number): void {
    if (resizeScreen(this, cols, rows)) this.#notify();
  }
}
