// Painting a screen (src/terminal/paint.ts): only rows that changed, scrollback added once and
// trimmed in step with the screen, older rows filled in chunks.
import { describe, expect, it } from 'vitest';
import { BOLD, INVERSE, UNDER } from '../src/terminal/cells.ts';
import { attrsOf, BACK_NOW, color256, edgeBg, Painter, rowHtml } from '../src/terminal/paint.ts';
import { Screen } from '../src/terminal/screen.ts';

function painter(): { p: Painter; back: HTMLElement; live: HTMLElement } {
  const back = document.createElement('div');
  const live = document.createElement('div');
  return { p: new Painter(back, live), back, live };
}

describe('rowHtml', () => {
  it('runs of one pen share a span; text is escaped; the cursor and wide chars get their own', () => {
    const s = new Screen(8, 1);
    s.write('<a>\x1b[1mB\x1b[0m界');
    const r = s.screen[0];
    if (!r) throw new Error('no row');
    const html = rowHtml(r, 0);
    expect(html).toContain('&lt;');
    expect(html).toContain('<span data-cur>&lt;</span>');
    expect(html).toContain('<span data-f="b">B</span>');
    expect(html).toContain('<span data-w2>界</span>');
  });

  it('inverse swaps colours, falling back to the terminal ink and background', () => {
    const s = new Screen(4, 1);
    expect(attrsOf(s.pens.pen(null, null, INVERSE))).toBe(' style="color:var(--term-bg);background:var(--term-ink)"');
    expect(attrsOf(s.pens.pen(1, null, BOLD | UNDER))).toBe(' data-f="b u" style="color:#f0524f"');
  });

  it('the 256 palette: the 16, the cube and the greys', () => {
    expect(color256(1)).toBe('#f0524f');
    expect(color256(16)).toBe('#000000');
    expect(color256(196)).toBe('#ff0000');
    expect(color256(232)).toBe('#080808');
    expect(color256(255)).toBe('#eeeeee');
  });

  it("the edge colour is the corners' shared background, else none", () => {
    const s = new Screen(4, 2);
    s.write('\x1b[44m\x1b[2J');
    expect(edgeBg(s.screen)).toBe('#4f8ef7');
    s.write('\x1b[0m\x1b[1;1H\x1b[K');
    expect(edgeBg(s.screen)).toBeNull();
  });
});

describe('Painter', () => {
  it('repaints only the rows that changed, and the cursor row when the cursor moves', () => {
    const s = new Screen(10, 4);
    const { p, live } = painter();
    s.write('a\r\nb\r\nc');
    expect(p.paint(s, true).rows).toBe(4);
    const untouched = live.children[1]?.firstChild;
    s.write('\x1b[1;1Hz');
    expect(p.paint(s, true).rows).toBe(2); // row 0 (the write, the cursor) and row 2 (the cursor left it)
    expect(live.children[1]?.firstChild).toBe(untouched);
    expect(live.children[0]?.textContent?.startsWith('z')).toBe(true);
    expect(p.paint(s, true).rows).toBe(0);
  });

  it('adds scrollback rows once, at the end, and drops the ones the screen dropped', () => {
    const s = new Screen(6, 2, { scrollback: 5 });
    const { p, back } = painter();
    s.write('1\r\n2\r\n3\r\n');
    expect(p.paint(s, false).back).toBe(2);
    expect([...back.children].map((c) => c.textContent?.trim())).toEqual(['1', '2']);
    s.write('4\r\n5\r\n6\r\n7\r\n8\r\n');
    p.paint(s, false);
    expect(back.childElementCount).toBe(5);
    expect([...back.children].map((c) => c.textContent?.trim())).toEqual(['3', '4', '5', '6', '7']);
  });

  it('a flood paints the last screenfuls now and the rest in chunks', () => {
    const s = new Screen(6, 2);
    let out = '';
    for (let i = 0; i < BACK_NOW * 3; i++) out += `${i}\r\n`;
    s.write(out);
    const { p, back } = painter();
    p.paint(s, false);
    expect(back.childElementCount).toBe(BACK_NOW);
    while (p.fillChunk(s));
    expect(back.childElementCount).toBe(s.back.length);
    expect(back.firstElementChild?.textContent?.trim()).toBe('0');
  });

  it('starts over when the scrollback is wiped, and hides it on the alternate screen', () => {
    const s = new Screen(6, 2);
    const { p, back } = painter();
    s.write('1\r\n2\r\n3');
    p.paint(s, false);
    s.write('\x1b[3J');
    p.paint(s, false);
    expect(back.childElementCount).toBe(0);
    s.write('\x1b[?1049h');
    p.paint(s, false);
    expect(back.hidden).toBe(true);
  });
});
