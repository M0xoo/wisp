// The terminal's screen (src/terminal/screen.ts): v1's test/pty.test.js Screen cases, ported, plus
// the edge cases the port found. DOM-free.
import { describe, expect, it } from 'vitest';
import { BOLD, PLAIN, UNDER, type Row } from '../src/terminal/cells.ts';
import { Screen } from '../src/terminal/screen.ts';

const rows = (s: Screen): string[] => s.screen.map((r) => s.text(r));
const at = (s: Screen, y: number): Row => {
  const r = s.screen[y];
  if (!r) throw new Error(`no row ${y}`);
  return r;
};

describe('Screen', () => {
  it('text, cursor moves, erase, colours and the queries agents send', () => {
    const replies: string[] = [];
    const s = new Screen(20, 4, { onReply: (r) => replies.push(r) });
    s.write('hello\r\nworld\x1b[31mred\x1b[0m\x1b[2;3Hx\x1b[K');
    expect(rows(s)).toEqual(['hello', 'wox', '', '']);
    s.write('\x1b[1;1H\x1b[2K\x1b[38;2;255;0;10mT\x1b[48;5;196mU\x1b[1;4mV');
    const r = at(s, 0);
    expect(r.p[0]?.fg).toBe('#ff000a');
    expect(r.p[1]?.bg).toBe(196);
    expect((r.p[2]?.f ?? 0) & BOLD && (r.p[2]?.f ?? 0) & UNDER).toBeTruthy();
    s.write('\x1b[6n\x1b[c\x1b]11;?\x07');
    expect(replies).toEqual(['\x1b[1;4R', '\x1b[?62;22c', '\x1b]11;rgb:1414/1414/1414\x1b\\']);
  });

  it('wrapping, scrollback, scroll regions, the alternate screen and wide characters', () => {
    const s = new Screen(5, 3);
    s.write('abcdefg');
    expect(rows(s)).toEqual(['abcde', 'fg', '']);
    s.write('\r\n1\r\n2\r\n3');
    expect(s.back.map((r) => s.text(r))).toEqual(['abcde', 'fg']);
    expect(rows(s)).toEqual(['1', '2', '3']);
    // A region: lines leaving it are gone, not scrollback.
    s.write('\x1b[1;2r\x1b[2;1H\n');
    expect(rows(s)).toEqual(['2', '', '3']);
    expect(s.back.length).toBe(2);
    s.write('\x1b[r\x1b[?1049h\x1b[Halt');
    expect(rows(s)).toEqual(['alt', '', '']);
    s.write('\x1b[?1049l');
    expect(rows(s)).toEqual(['2', '', '3']);
    s.write('\x1b[3J\x1b[2J\x1b[H界x');
    expect(s.back.length).toBe(0);
    expect([at(s, 0).w[0], at(s, 0).w[1], at(s, 0).c[2]]).toEqual([2, 0, 'x']);
    // DEC line drawing.
    s.write('\x1b[2;1H\x1b(0lqk\x1b(Bq');
    expect(s.text(at(s, 1))).toBe('┌─┐q');
  });

  it('a resize keeps what is on screen and the cursor on it', () => {
    const s = new Screen(10, 4);
    s.write('a\r\nb\r\nc\r\nd');
    s.resize(6, 2);
    expect(rows(s)).toEqual(['c', 'd']);
    expect(s.y).toBe(1);
    s.resize(6, 4);
    expect(rows(s)).toEqual(['a', 'b', 'c', 'd']); // the scrollback comes back down
  });

  it('a full scrollback drops its oldest rows and keeps scrolling in place', () => {
    const s = new Screen(8, 3);
    let out = '';
    for (let i = 0; i < 5010; i++) out += `\x1b[${i % 2 ? 44 : 0}m${i}\r\n`;
    s.write(out);
    expect(s.back.length).toBe(5000);
    expect(s.dropped).toBe(8);
    expect(s.text(s.back[0] as Row)).toBe('8');
    expect(s.text(s.back.at(-1) as Row)).toBe('5007');
    expect(rows(s)).toEqual(['5008', '5009', '']);
    // The row that comes in at the bottom is blank, in the background in use (here: blue).
    expect(at(s, 2).c.every((c) => c === ' ') && at(s, 2).p.every((p) => p.bg === 4)).toBe(true);
    expect(new Set([...s.back, ...s.screen]).size).toBe(5003); // no row is in two places
  });

  it('synchronized output, focus reports and the modes a program asks about', () => {
    const replies: string[] = [];
    let now = 1000;
    const s = new Screen(10, 3, { onReply: (r) => replies.push(r), now: () => now });
    s.write('\x1b[?2026h');
    expect(s.modes.sync).toBe(true);
    expect(s.syncAt).toBe(1000);
    now = 1100;
    s.write('\x1b[?2026$p\x1b[?2026l\x1b[?2026$p\x1b[?1004h\x1b[?1004$p\x1b[?9999$p\x1b[4$p');
    expect(s.modes.sync).toBe(false);
    expect(s.modes.focus).toBe(true);
    expect(replies).toEqual(['\x1b[?2026;1$y', '\x1b[?2026;2$y', '\x1b[?1004;1$y', '\x1b[?9999;0$y', '\x1b[4;0$y']);
  });

  it('marks only the rows that changed', () => {
    const s = new Screen(10, 4);
    s.write('a\r\nb\r\nc');
    const before = s.screen.map((r) => r.v);
    s.write('\x1b[1;1Hz');
    const after = s.screen.map((r) => r.v);
    expect(after[0]).not.toBe(before[0]);
    expect(after.slice(1, 2)).toEqual(before.slice(1, 2)); // row 1 untouched
    expect(after[3]).toBe(before[3]);
  });

  it('watchers hear each write, resize and reset, and stop when unsubscribed', () => {
    const s = new Screen(10, 4);
    let n = 0;
    const stop = s.watch(() => n++);
    s.write('x');
    s.resize(12, 4);
    s.resize(12, 4); // same size: nothing to say
    s.reset();
    stop();
    s.write('y');
    expect(n).toBe(3);
  });

  it('combining marks join the cell before; writing over half a wide char blanks the other half', () => {
    const s = new Screen(6, 2);
    s.write('éx');
    expect(at(s, 0).c[0]).toBe('é');
    expect(at(s, 0).c[1]).toBe('x');
    s.write('\r\n界\x1b[2;2Hy');
    expect([at(s, 1).c[0], at(s, 1).w[0], at(s, 1).c[1]]).toEqual([' ', 1, 'y']);
  });

  it('insert and delete characters, insert mode, erase keeps the background', () => {
    const s = new Screen(6, 2);
    s.write('abcdef\x1b[1;2H\x1b[2@');
    expect(s.text(at(s, 0))).toBe('a  bcd');
    s.write('\x1b[1;2H\x1b[3P');
    expect(s.text(at(s, 0))).toBe('acd');
    s.write('\x1b[1;1H\x1b[4hZ\x1b[4l');
    expect(s.text(at(s, 0))).toBe('Zacd');
    s.write('\x1b[44m\x1b[2;1H\x1b[K');
    expect(at(s, 1).p.every((p) => p.bg === 4 && p.fg === null)).toBe(true);
  });

  it('REP repeats the last character; tabs stop every 8 columns; backspace stays in the row', () => {
    const s = new Screen(20, 2);
    s.write('a\x1b[3b');
    expect(s.text(at(s, 0))).toBe('aaaa');
    s.write('\r\tX\x1b[Z\x1b[ZY');
    expect(s.text(at(s, 0))).toBe('Yaaa    X');
    s.write('\r\x08\x08Q');
    expect(s.text(at(s, 0)).charAt(0)).toBe('Q');
  });

  it('origin mode moves within the region; a cursor report counts from its top', () => {
    const replies: string[] = [];
    const s = new Screen(10, 6, { onReply: (r) => replies.push(r) });
    s.write('\x1b[2;4r\x1b[?6h\x1b[2;3H\x1b[6n');
    expect(s.y).toBe(2);
    expect(replies.at(-1)).toBe('\x1b[2;3R');
    s.write('\x1b[9;1H');
    expect(s.y).toBe(3); // clamped to the region's bottom
  });

  it('save/restore keeps the pen and charset; soft reset clears modes but not the screen', () => {
    const s = new Screen(10, 2);
    s.write('\x1b[1m\x1b(0\x1b7\x1b[0m\x1b(B\x1b[2;5H\x1b8q');
    expect(at(s, 0).c[0]).toBe('─');
    expect(at(s, 0).p[0]?.f).toBe(BOLD);
    s.write('\x1b[?7l\x1b[!p');
    expect(s.modes.wrap).toBe(true);
    expect(s.pen).toBe(PLAIN);
    expect(at(s, 0).c[0]).toBe('─');
  });

  it('OSC sets the title; DCS and APC are skipped whole; an overlong CSI is dropped', () => {
    const s = new Screen(10, 2);
    s.write('\x1b]0;my title\x07\x1bPq#0;1;2\x1b\\\x1b_hidden\x1b\\ok');
    expect(s.title).toBe('my title');
    expect(s.text(at(s, 0))).toBe('ok');
    s.write(`\x1b[${'1;'.repeat(40)}mZ`);
    expect(s.state).toBe('ground'); // it gave up on the sequence and printed the rest
    expect(rows(s).join('')).toContain('Z');
  });

  it('mouse, bracketed paste and app cursor modes follow what the program sets', () => {
    const s = new Screen(10, 2);
    s.write('\x1b[?1002h\x1b[?1006h\x1b[?2004h\x1b[?1h');
    expect(s.modes).toMatchObject({ mouse: 1002, sgrMouse: true, paste: true, appCursor: true });
    s.write('\x1b[?1002l\x1b[?2004l');
    expect(s.modes.mouse).toBe(0);
    expect(s.modes.paste).toBe(false);
  });

  it('a window-size query answers the grid; ESC c starts over', () => {
    const replies: string[] = [];
    const s = new Screen(30, 7, { onReply: (r) => replies.push(r) });
    s.write('junk\x1b[18t');
    expect(replies).toEqual(['\x1b[8;7;30t']);
    const cleared = s.cleared;
    s.write('\x1bc');
    expect(rows(s).every((r) => r === '')).toBe(true);
    expect(s.cleared).toBe(cleared + 1);
  });

  it('a shrink drops blank rows under the cursor before rows above it', () => {
    const s = new Screen(10, 6);
    s.write('a\r\nb');
    s.resize(10, 3);
    expect(rows(s)).toEqual(['a', 'b', '']);
    expect(s.back.length).toBe(0);
    s.resize(4, 3);
    expect(at(s, 0).c.length).toBe(4);
  });

  it('never throws on random input, and keeps its shape (property)', () => {
    let seed = 7;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const parts = ['\x1b[', '\x1b]', '\x1b(0', ';', 'm', 'H', 'J', 'K', 'r', '?1049h', '?1049l', '\r\n', '界', 'é', 'x', '\x08', '\t', '\x1b', '@', 'P', 'L', 'M', '3', '12', '\x07', '\x1b\\'];
    for (let run = 0; run < 40; run++) {
      const s = new Screen(3 + rnd(30), 1 + rnd(12), { scrollback: 50 });
      let text = '';
      for (let i = 0; i < 400; i++) text += parts[rnd(parts.length)];
      s.write(text);
      if (rnd(3) === 0) s.resize(2 + rnd(40), 1 + rnd(15));
      s.write(text);
      expect(s.screen.length).toBe(s.rows);
      for (const r of [...s.screen, ...s.back]) {
        expect(r.c.length).toBe(s.cols);
        expect(r.p.length).toBe(s.cols);
        expect(r.w.length).toBe(s.cols);
      }
      expect(s.x).toBeLessThan(s.cols);
      expect(s.y).toBeLessThan(s.rows);
      expect(s.back.length).toBeLessThanOrEqual(50);
    }
  });
});
