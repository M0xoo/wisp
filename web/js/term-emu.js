// A small VT/xterm screen for the terminal a take over opens in the page (features/term.js).
// DOM-free: it turns the output of claude, codex and the like into rows of styled cells, and
// answers the queries they send (cursor position, device attributes, colours) through onReply.
// Enough of xterm for agent TUIs and a shell: cursor moves, erase, scroll regions, insert and
// delete, SGR colours (16, 256, truecolor), the alternate screen, bracketed paste, wide characters.

const SCROLLBACK = 5000;

// A pen is the look of a cell. Pens are shared and never changed, so a row compares them by identity.
const pens = new Map();
function pen(fg = null, bg = null, f = 0) {
  const k = `${fg}|${bg}|${f}`;
  let p = pens.get(k);
  if (!p) pens.set(k, (p = Object.freeze({ fg, bg, f })));
  return p;
}
export const PLAIN = pen();
// Flags in pen.f.
export const BOLD = 1, DIM = 2, ITALIC = 4, UNDER = 8, BLINK = 16, INVERSE = 32, HIDDEN = 64, STRIKE = 128;

// DEC special graphics (ESC ( 0): the line-drawing set.
const DEC = { j: '┘', k: '┐', l: '┌', m: '└', n: '┼', q: '─', t: '├', u: '┤', v: '┴', w: '┬', x: '│', a: '▒', '`': '◆', f: '°', g: '±', y: '≤', z: '≥', '~': '·', '{': 'π', '|': '≠', '}': '£', o: '⎺', p: '⎻', r: '⎼', s: '⎽' };

// Columns a code point takes: 0 for combining marks and joiners, 2 for wide (East Asian, emoji).
export function charWidth(cp) {
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

const blankRow = (cols, p = PLAIN) => ({ c: Array(cols).fill(' '), p: Array(cols).fill(p), w: Array(cols).fill(1), wrapped: false, v: 0 });

export class Screen {
  // onReply(text): what the terminal answers the program (typed back into it).
  // colors: { fg, bg } as #rrggbb, for programs that ask (OSC 10 / 11).
  constructor(cols = 80, rows = 24, { onReply = () => {}, colors = { fg: '#e8e8e6', bg: '#141414' } } = {}) {
    this.onReply = onReply;
    this.colors = colors;
    this.cols = cols;
    this.rows = rows;
    this.reset();
  }

  reset() {
    this.normal = Array.from({ length: this.rows }, () => blankRow(this.cols));
    this.alt = null; // the alternate screen's rows while it's on
    this.back = []; // scrollback, oldest first (normal screen only)
    this.dropped = 0; // scrollback rows dropped off the top so far (renderers count from this)
    this.x = 0;
    this.y = 0;
    this.wrapNext = false;
    this.pen = PLAIN;
    this.top = 0;
    this.bottom = this.rows - 1;
    this.saved = null;
    this.modes = { appCursor: false, wrap: true, cursor: true, paste: false, mouse: 0, sgrMouse: false, origin: false, insert: false };
    this.charset = [null, null]; // G0, G1: null or DEC
    this.gl = 0;
    this.title = '';
    this.state = 'ground';
    this.buf = '';
    this.version = (this.version || 0) + 1;
    this.cleared = (this.cleared || 0) + 1; // bumped when the scrollback is wiped or reshaped
  }

  get screen() {
    return this.alt || this.normal;
  }

  // Mark a row changed (renderers repaint rows whose v moved).
  #touch(y) {
    const r = this.screen[y];
    if (r) r.v = ++this.version;
  }

  write(text) {
    for (const ch of text) this.#feed(ch);
  }

  #feed(ch) {
    const code = ch.codePointAt(0);
    switch (this.state) {
      case 'ground':
        if (code < 0x20 || code === 0x7f) return this.#control(code);
        return this.#print(ch, code);
      case 'esc':
        return this.#esc(ch, code);
      case 'csi':
        if (code >= 0x40 && code <= 0x7e) {
          this.state = 'ground';
          return this.#csi(this.buf, ch);
        }
        if (code === 0x1b) return void ((this.state = 'esc'), (this.buf = ''));
        if (code < 0x20) return this.#control(code); // C0 inside CSI runs as usual
        this.buf += ch;
        if (this.buf.length > 64) this.state = 'ground';
        return;
      case 'osc':
        if (code === 0x07) return this.#osc(this.buf);
        if (code === 0x1b) return void (this.state = 'osc-esc');
        this.buf += ch;
        if (this.buf.length > 4096) this.state = 'ground';
        return;
      case 'osc-esc':
        if (ch === '\\') return this.#osc(this.buf);
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
        this.charset[this.buf === '(' ? 0 : 1] = ch === '0' ? DEC : null;
        this.state = 'ground';
        return;
      case 'skip': // one more character (ESC # 8, ESC % G, …)
        this.state = 'ground';
        return;
    }
  }

  #control(code) {
    switch (code) {
      case 0x1b:
        this.state = 'esc';
        this.buf = '';
        return;
      case 0x08:
        if (this.x > 0) this.x = Math.min(this.x, this.cols - 1) - 1;
        this.wrapNext = false;
        return this.#touch(this.y);
      case 0x09: {
        const nx = Math.min(this.cols - 1, (Math.floor(this.x / 8) + 1) * 8);
        this.x = nx;
        this.wrapNext = false;
        return this.#touch(this.y);
      }
      case 0x0a:
      case 0x0b:
      case 0x0c:
        return this.#index();
      case 0x0d:
        this.x = 0;
        this.wrapNext = false;
        return this.#touch(this.y);
      case 0x0e:
        this.gl = 1;
        return;
      case 0x0f:
        this.gl = 0;
        return;
    }
  }

  #esc(ch) {
    this.state = 'ground';
    switch (ch) {
      case '[':
        this.state = 'csi';
        this.buf = '';
        return;
      case ']':
        this.state = 'osc';
        this.buf = '';
        return;
      case 'P':
      case '_':
      case '^':
      case 'X':
        this.state = 'str';
        return;
      case '(':
      case ')':
        this.state = 'charset';
        this.buf = ch;
        return;
      case '*':
      case '+':
      case '#':
      case '%':
      case ' ':
        this.state = 'skip';
        return;
      case '7':
        return this.#save();
      case '8':
        return this.#restore();
      case 'D':
        return this.#index();
      case 'E':
        this.x = 0;
        return this.#index();
      case 'M':
        return this.#reverseIndex();
      case 'c':
        return this.reset();
      case '=':
      case '>':
        return;
    }
  }

  #print(ch, code) {
    if (this.charset[this.gl] && ch in DEC) ch = DEC[ch];
    const w = charWidth(code);
    const rows = this.screen;
    if (w === 0) {
      // A combining mark or joiner: onto the cell before.
      const px = this.wrapNext ? this.cols - 1 : this.x - 1;
      const r = rows[this.y];
      if (px >= 0) {
        const at = r.w[px] === 0 && px > 0 ? px - 1 : px;
        r.c[at] += ch;
        this.#touch(this.y);
      }
      return;
    }
    if (this.wrapNext || this.x + w > this.cols) {
      if (this.modes.wrap) {
        rows[this.y].wrapped = true;
        this.x = 0;
        this.#index();
      } else this.x = this.cols - w;
      this.wrapNext = false;
    }
    const r = this.screen[this.y];
    if (this.modes.insert) this.#insertChars(w);
    this.#clearWide(r, this.x);
    if (w === 2) this.#clearWide(r, this.x + 1);
    r.c[this.x] = ch;
    r.p[this.x] = this.pen;
    r.w[this.x] = w;
    if (w === 2) (r.c[this.x + 1] = ''), (r.p[this.x + 1] = this.pen), (r.w[this.x + 1] = 0);
    this.#touch(this.y);
    if (this.x + w >= this.cols) {
      this.x = this.cols - 1;
      this.wrapNext = true;
    } else this.x += w;
  }

  // Writing over half of a wide character blanks the other half.
  #clearWide(r, x) {
    if (x >= this.cols) return;
    if (r.w[x] === 0 && x > 0) (r.c[x - 1] = ' '), (r.w[x - 1] = 1);
    if (r.w[x] === 2 && x + 1 < this.cols) (r.c[x + 1] = ' '), (r.w[x + 1] = 1);
  }

  #index() {
    this.wrapNext = false;
    if (this.y === this.bottom) this.#scrollUp(1);
    else if (this.y < this.rows - 1) this.y++;
    this.#touch(this.y);
  }

  #reverseIndex() {
    this.wrapNext = false;
    if (this.y === this.top) this.#scrollDown(1);
    else if (this.y > 0) this.y--;
    this.#touch(this.y);
  }

  // Rows leave the top of the scroll region. Off the top of the whole normal screen, they go to
  // the scrollback.
  #scrollUp(n, top = this.top, bottom = this.bottom) {
    const rows = this.screen;
    n = Math.min(n, bottom - top + 1);
    for (let i = 0; i < n; i++) {
      const [gone] = rows.splice(top, 1);
      rows.splice(bottom, 0, blankRow(this.cols, this.#bgPen()));
      if (!this.alt && top === 0 && bottom === this.rows - 1) {
        this.back.push(gone);
        if (this.back.length > SCROLLBACK) this.back.shift(), this.dropped++;
      }
    }
    for (let y = top; y <= bottom; y++) this.#touch(y);
  }

  #scrollDown(n, top = this.top, bottom = this.bottom) {
    const rows = this.screen;
    n = Math.min(n, bottom - top + 1);
    for (let i = 0; i < n; i++) {
      rows.splice(bottom, 1);
      rows.splice(top, 0, blankRow(this.cols, this.#bgPen()));
    }
    for (let y = top; y <= bottom; y++) this.#touch(y);
  }

  // Erased cells keep the current background (xterm's behaviour), nothing else.
  #bgPen() {
    return this.pen.bg === null ? PLAIN : pen(null, this.pen.bg, 0);
  }

  #erase(y, from, to) {
    const r = this.screen[y];
    if (!r) return;
    const p = this.#bgPen();
    from = Math.max(0, from);
    to = Math.min(this.cols, to);
    if (from > 0 && r.w[from] === 0) (r.c[from - 1] = ' '), (r.w[from - 1] = 1);
    if (to < this.cols && r.w[to] === 0) (r.c[to] = ' '), (r.w[to] = 1);
    for (let x = from; x < to; x++) (r.c[x] = ' '), (r.p[x] = p), (r.w[x] = 1);
    if (to >= this.cols) r.wrapped = false;
    this.#touch(y);
  }

  #insertChars(n) {
    const r = this.screen[this.y];
    const x = this.x;
    n = Math.min(n, this.cols - x);
    for (const k of ['c', 'p', 'w']) {
      r[k].splice(this.cols - n, n);
      r[k].splice(x, 0, ...Array(n).fill(k === 'c' ? ' ' : k === 'p' ? this.#bgPen() : 1));
    }
    this.#touch(this.y);
  }

  #deleteChars(n) {
    const r = this.screen[this.y];
    n = Math.min(n, this.cols - this.x);
    for (const k of ['c', 'p', 'w']) {
      r[k].splice(this.x, n);
      r[k].push(...Array(n).fill(k === 'c' ? ' ' : k === 'p' ? this.#bgPen() : 1));
    }
    this.#touch(this.y);
  }

  #moveTo(x, y) {
    const old = this.y;
    const top = this.modes.origin ? this.top : 0;
    const bottom = this.modes.origin ? this.bottom : this.rows - 1;
    this.x = Math.max(0, Math.min(this.cols - 1, x));
    this.y = Math.max(top, Math.min(bottom, y + top));
    this.wrapNext = false;
    this.#touch(old);
    this.#touch(this.y);
  }

  #save() {
    this.saved = { x: this.x, y: this.y, pen: this.pen, wrapNext: this.wrapNext, origin: this.modes.origin, charset: [...this.charset], gl: this.gl };
  }

  #restore() {
    const s = this.saved || { x: 0, y: 0, pen: PLAIN, wrapNext: false, origin: false, charset: [null, null], gl: 0 };
    const old = this.y;
    this.x = Math.min(s.x, this.cols - 1);
    this.y = Math.min(s.y, this.rows - 1);
    this.pen = s.pen;
    this.wrapNext = s.wrapNext;
    this.modes.origin = s.origin;
    this.charset = [...s.charset];
    this.gl = s.gl;
    this.#touch(old);
    this.#touch(this.y);
  }

  #setAlt(on, { save = false, clear = false } = {}) {
    if (on === !!this.alt) return;
    if (on) {
      if (save) this.#save();
      this.alt = Array.from({ length: this.rows }, () => blankRow(this.cols));
    } else {
      this.alt = null;
      if (save) this.#restore();
    }
    if (clear && this.alt) this.alt = Array.from({ length: this.rows }, () => blankRow(this.cols));
    for (let y = 0; y < this.rows; y++) this.#touch(y);
  }

  #csi(body, final) {
    const prefix = /^[?>=<]/.test(body) ? body[0] : '';
    const inter = /[ -/]+$/.exec(body)?.[0] || '';
    const ps = body.slice(prefix.length, body.length - inter.length);
    const args = ps ? ps.split(';').map((a) => (a === '' ? NaN : parseInt(a, 10))) : [];
    const n = (i, d = 1) => (Number.isFinite(args[i]) && args[i] > 0 ? args[i] : d);
    const raw = (i, d = 0) => (Number.isFinite(args[i]) ? args[i] : d);
    if (inter) {
      if (final === 'p' && inter === '!') return this.#softReset();
      if (final === 'p' && inter === '$') return this.onReply(`\x1b[${prefix}${raw(0)};0$y`); // DECRQM: not recognised
      return; // DECSCUSR (cursor style) and the like
    }
    if (prefix === '?' || prefix === '>' || prefix === '=' || prefix === '<') {
      if (final === 'h' || final === 'l') return prefix === '?' && this.#decMode(args, final === 'h');
      if (final === 'c' && prefix === '>') return this.onReply('\x1b[>0;10;1c');
      if (final === 'n' && prefix === '?' && raw(0) === 6) return this.onReply(`\x1b[?${this.y + 1};${this.x + 1}R`);
      return; // ?u (kitty keyboard query): no answer means no support, and DA below settles it
    }
    switch (final) {
      case '@':
        return this.#insertChars(n(0));
      case 'A':
        return this.#moveTo(this.x, this.y - (this.modes.origin ? this.top : 0) - n(0));
      case 'B':
      case 'e':
        return this.#moveTo(this.x, this.y - (this.modes.origin ? this.top : 0) + n(0));
      case 'C':
      case 'a':
        return this.#moveTo(this.x + n(0), this.y - (this.modes.origin ? this.top : 0));
      case 'D':
        return this.#moveTo(Math.min(this.x, this.cols - 1) - n(0), this.y - (this.modes.origin ? this.top : 0));
      case 'E':
        return this.#moveTo(0, this.y - (this.modes.origin ? this.top : 0) + n(0));
      case 'F':
        return this.#moveTo(0, this.y - (this.modes.origin ? this.top : 0) - n(0));
      case 'G':
      case '`':
        return this.#moveTo(n(0) - 1, this.y - (this.modes.origin ? this.top : 0));
      case 'H':
      case 'f':
        return this.#moveTo(n(1) - 1, n(0) - 1);
      case 'I':
        for (let i = 0; i < n(0); i++) this.#control(0x09);
        return;
      case 'Z': {
        const k = n(0);
        let x = this.x;
        for (let i = 0; i < k; i++) x = Math.max(0, (Math.ceil(x / 8) - 1) * 8);
        return this.#moveTo(x, this.y - (this.modes.origin ? this.top : 0));
      }
      case 'd':
        return this.#moveTo(this.x, n(0) - 1);
      case 'J': {
        const m = raw(0);
        if (m === 3) {
          this.back = [];
          this.cleared++;
          return;
        }
        if (m === 0) {
          this.#erase(this.y, this.x, this.cols);
          for (let y = this.y + 1; y < this.rows; y++) this.#erase(y, 0, this.cols);
        } else if (m === 1) {
          for (let y = 0; y < this.y; y++) this.#erase(y, 0, this.cols);
          this.#erase(this.y, 0, this.x + 1);
        } else if (m === 2) for (let y = 0; y < this.rows; y++) this.#erase(y, 0, this.cols);
        return;
      }
      case 'K': {
        const m = raw(0);
        if (m === 0) this.#erase(this.y, this.x, this.cols);
        else if (m === 1) this.#erase(this.y, 0, this.x + 1);
        else if (m === 2) this.#erase(this.y, 0, this.cols);
        return;
      }
      case 'L':
        if (this.y >= this.top && this.y <= this.bottom) this.#scrollDown(n(0), this.y, this.bottom), (this.x = 0);
        return;
      case 'M':
        if (this.y >= this.top && this.y <= this.bottom) {
          // Deleted lines are gone, not scrollback.
          const rows = this.screen;
          const k = Math.min(n(0), this.bottom - this.y + 1);
          for (let i = 0; i < k; i++) rows.splice(this.y, 1), rows.splice(this.bottom, 0, blankRow(this.cols, this.#bgPen()));
          for (let y = this.y; y <= this.bottom; y++) this.#touch(y);
          this.x = 0;
        }
        return;
      case 'P':
        return this.#deleteChars(n(0));
      case 'X':
        return this.#erase(this.y, this.x, this.x + n(0));
      case 'S':
        return this.#scrollUp(n(0));
      case 'T':
        return this.#scrollDown(n(0));
      case 'b': {
        const r = this.screen[this.y];
        const last = this.x > 0 ? r.c[this.x - 1] : ' ';
        for (let i = 0; i < Math.min(n(0), 1000); i++) this.#print(last, last.codePointAt(0));
        return;
      }
      case 'c':
        return this.onReply('\x1b[?62;22c'); // a VT220 with ANSI colour
      case 'h':
      case 'l':
        if (args.includes(4)) this.modes.insert = final === 'h';
        return;
      case 'm':
        return this.#sgr(args);
      case 'n':
        if (raw(0) === 5) this.onReply('\x1b[0n');
        if (raw(0) === 6) this.onReply(`\x1b[${this.y + 1 - (this.modes.origin ? this.top : 0)};${this.x + 1}R`);
        return;
      case 'r': {
        const top = n(0) - 1;
        const bottom = n(1, this.rows) - 1;
        if (top < bottom && bottom < this.rows) {
          this.top = top;
          this.bottom = bottom;
          this.#moveTo(0, 0);
        }
        return;
      }
      case 's':
        return this.#save();
      case 'u':
        return this.#restore();
      case 't':
        if (raw(0) === 18) this.onReply(`\x1b[8;${this.rows};${this.cols}t`);
        return;
    }
  }

  #softReset() {
    this.pen = PLAIN;
    this.top = 0;
    this.bottom = this.rows - 1;
    Object.assign(this.modes, { appCursor: false, wrap: true, cursor: true, origin: false, insert: false });
  }

  #decMode(args, on) {
    for (const m of args) {
      switch (m) {
        case 1:
          this.modes.appCursor = on;
          break;
        case 6:
          this.modes.origin = on;
          this.#moveTo(0, 0);
          break;
        case 7:
          this.modes.wrap = on;
          break;
        case 25:
          this.modes.cursor = on;
          this.#touch(this.y);
          break;
        case 47:
        case 1047:
          this.#setAlt(on, { clear: m === 1047 && !on });
          break;
        case 1049:
          this.#setAlt(on, { save: true, clear: true });
          break;
        case 1000:
        case 1002:
        case 1003:
          this.modes.mouse = on ? m : 0;
          break;
        case 1006:
          this.modes.sgrMouse = on;
          break;
        case 2004:
          this.modes.paste = on;
          break;
      }
    }
  }

  #sgr(args) {
    if (!args.length) args = [0];
    let { fg, bg, f } = this.pen;
    for (let i = 0; i < args.length; i++) {
      const a = Number.isFinite(args[i]) ? args[i] : 0;
      if (a === 0) (fg = null), (bg = null), (f = 0);
      else if (a === 1) f |= BOLD;
      else if (a === 2) f |= DIM;
      else if (a === 3) f |= ITALIC;
      else if (a === 4) f |= UNDER;
      else if (a === 5 || a === 6) f |= BLINK;
      else if (a === 7) f |= INVERSE;
      else if (a === 8) f |= HIDDEN;
      else if (a === 9) f |= STRIKE;
      else if (a === 21) f |= UNDER;
      else if (a === 22) f &= ~(BOLD | DIM);
      else if (a === 23) f &= ~ITALIC;
      else if (a === 24) f &= ~UNDER;
      else if (a === 25) f &= ~BLINK;
      else if (a === 27) f &= ~INVERSE;
      else if (a === 28) f &= ~HIDDEN;
      else if (a === 29) f &= ~STRIKE;
      else if (a >= 30 && a <= 37) fg = a - 30;
      else if (a === 39) fg = null;
      else if (a >= 40 && a <= 47) bg = a - 40;
      else if (a === 49) bg = null;
      else if (a >= 90 && a <= 97) fg = a - 90 + 8;
      else if (a >= 100 && a <= 107) bg = a - 100 + 8;
      else if (a === 38 || a === 48 || a === 58) {
        let c = null;
        if (args[i + 1] === 5) (c = args[i + 2] & 255), (i += 2);
        else if (args[i + 1] === 2) (c = `#${[args[i + 2], args[i + 3], args[i + 4]].map((v) => (v & 255).toString(16).padStart(2, '0')).join('')}`), (i += 4);
        if (a === 38) fg = c;
        else if (a === 48) bg = c;
      }
    }
    this.pen = pen(fg, bg, f);
  }

  #osc(body) {
    this.state = 'ground';
    const i = body.indexOf(';');
    const id = i < 0 ? body : body.slice(0, i);
    const arg = i < 0 ? '' : body.slice(i + 1);
    if (id === '0' || id === '2') this.title = arg.slice(0, 200);
    // Programs that pick a light or dark theme ask for the colours.
    if ((id === '10' || id === '11') && arg === '?') {
      const hex = (id === '10' ? this.colors.fg : this.colors.bg).replace('#', '');
      const [r, g, b] = [0, 2, 4].map((k) => hex.slice(k, k + 2).repeat(2));
      this.onReply(`\x1b]${id};rgb:${r}/${g}/${b}\x1b\\`);
    }
  }

  // Change the size. No reflow: rows are cut or padded; a shorter screen pushes rows above the
  // cursor into the scrollback, a taller one brings them back.
  resize(cols, rows) {
    cols = Math.max(2, cols | 0);
    rows = Math.max(1, rows | 0);
    if (cols === this.cols && rows === this.rows) return;
    const fit = (r) => {
      const n = r.c.length;
      if (cols < n) {
        r.c.length = r.p.length = r.w.length = cols;
        if (r.w[cols - 1] === 2) (r.c[cols - 1] = ' '), (r.w[cols - 1] = 1);
      } else for (let x = n; x < cols; x++) r.c.push(' '), r.p.push(PLAIN), r.w.push(1);
      r.v = ++this.version;
    };
    for (const list of [this.normal, this.alt, this.back]) list?.forEach(fit);
    const blank = (r) => r.c.every((c) => c === ' ') && r.p.every((p) => p === PLAIN);
    const toBack = (r) => {
      this.back.push(r);
      if (this.back.length > SCROLLBACK) this.back.shift(), this.dropped++;
    };
    // Shorter: blank rows under the cursor go first, then rows off the top. Taller: the
    // scrollback comes back down, or blank rows are added.
    const refit = (list) => {
      const cur = list === this.screen;
      while (list.length > rows) {
        if (blank(list.at(-1)) && (!cur || this.y < list.length - 1)) list.pop();
        else {
          const [gone] = list.splice(0, 1);
          if (list === this.normal) toBack(gone);
          if (cur) this.y = Math.max(0, this.y - 1);
        }
      }
      while (list.length < rows) {
        if (list === this.normal && cur && this.back.length) list.unshift(this.back.pop()), this.y++;
        else list.push(blankRow(cols));
      }
    };
    refit(this.normal);
    if (this.alt) refit(this.alt);
    this.cols = cols;
    this.rows = rows;
    this.top = 0;
    this.bottom = rows - 1;
    this.x = Math.min(this.x, cols - 1);
    this.y = Math.max(0, Math.min(this.y, rows - 1));
    this.wrapNext = false;
    this.cleared++; // the scrollback may have changed in the middle: renderers start over
    for (let y = 0; y < rows; y++) this.#touch(y);
  }

  // A row as plain text (tests, copying).
  text(r) {
    return r.c.join('').replace(/\s+$/, '');
  }
}

// What a key sends, or null for keys the page keeps (⌘C, ⌘V, …). k: a KeyboardEvent-like object.
export function keyBytes(k, { appCursor = false, mac = false } = {}) {
  const mod = 1 + (k.shiftKey ? 1 : 0) + (k.altKey ? 2 : 0) + (k.ctrlKey ? 4 : 0);
  const csi = (final, num = '1') => (mod > 1 ? `\x1b[${num};${mod}${final}` : num === '1' ? (appCursor && 'ABCDHF'.includes(final) ? `\x1bO${final}` : `\x1b[${final}`) : `\x1b[${num}~`);
  const tilde = (num) => (mod > 1 ? `\x1b[${num};${mod}~` : `\x1b[${num}~`);
  if (k.metaKey) return null;
  switch (k.key) {
    case 'Enter':
      return k.shiftKey || k.altKey ? '\x1b\r' : '\r';
    case 'Backspace':
      return k.altKey || k.ctrlKey ? '\x1b\x7f' : '\x7f';
    case 'Tab':
      return k.shiftKey ? '\x1b[Z' : '\t';
    case 'Escape':
      return '\x1b';
    case 'ArrowUp':
      return csi('A');
    case 'ArrowDown':
      return csi('B');
    case 'ArrowRight':
      return csi('C');
    case 'ArrowLeft':
      return csi('D');
    case 'Home':
      return csi('H');
    case 'End':
      return csi('F');
    case 'PageUp':
      return tilde(5);
    case 'PageDown':
      return tilde(6);
    case 'Delete':
      return tilde(3);
    case 'Insert':
      return tilde(2);
  }
  const f = /^F(\d{1,2})$/.exec(k.key);
  if (f) {
    const i = Number(f[1]);
    if (i <= 4) return mod > 1 ? `\x1b[1;${mod}${'PQRS'[i - 1]}` : `\x1bO${'PQRS'[i - 1]}`;
    const code = { 5: 15, 6: 17, 7: 18, 8: 19, 9: 20, 10: 21, 11: 23, 12: 24 }[i];
    return code ? tilde(code) : null;
  }
  if (k.key.length !== 1 && k.key !== 'Dead') return null;
  if (k.ctrlKey && !k.altKey) {
    const ch = k.key.length === 1 ? k.key : '';
    const c = ch.toLowerCase();
    if (c >= 'a' && c <= 'z') return String.fromCharCode(c.charCodeAt(0) - 96);
    const special = { ' ': '\x00', '@': '\x00', '2': '\x00', '[': '\x1b', '3': '\x1b', '\\': '\x1c', '4': '\x1c', ']': '\x1d', '5': '\x1d', '^': '\x1e', '6': '\x1e', '_': '\x1f', '-': '\x1f', '/': '\x1f', '7': '\x1f', '?': '\x7f', '8': '\x7f' }[ch];
    return special ?? null;
  }
  // Alt as Meta, except on a Mac where Option types characters (å, ∑, …): those come as text.
  if (k.altKey && !mac && k.key.length === 1) return `\x1b${k.key}`;
  return null; // printable text comes through the input event
}
