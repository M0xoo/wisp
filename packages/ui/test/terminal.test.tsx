// <Terminal> in happy-dom: it paints what the screen holds once per frame, repaints only rows that
// changed, sends keys and text as bytes, and hands an ended terminal's keys to onEndedKey.
import { createSignal } from 'solid-js';
import { describe, expect, it } from 'vitest';
import { Screen } from '../src/terminal/screen.ts';
import { Terminal, type TerminalHandle } from '../src/terminal/Terminal.tsx';
import { mount, part } from './helpers.tsx';

const LABELS = { input: 'Terminal input', keys: 'Keys', paste: 'Paste' };
const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));
const liveRows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[data-kit="term-live"] > [data-kit="term-row"]')];
const input = (): HTMLTextAreaElement => {
  const ta = document.querySelector<HTMLTextAreaElement>('[data-kit="term-input"]');
  if (!ta) throw new Error('no input');
  return ta;
};

describe('<Terminal>', () => {
  it('paints the screen, then only the rows a write changed', async () => {
    const s = new Screen(20, 4);
    mount(() => <Terminal screen={s} onData={() => {}} labels={LABELS} />);
    s.write('one\r\ntwo\r\nthree');
    await frame();
    expect(liveRows().map((r) => r.textContent?.trimEnd())).toEqual(['one', 'two', 'three', '']);
    const kept = liveRows()[0]?.firstChild;
    s.write('!');
    await frame();
    expect(liveRows()[2]?.textContent?.startsWith('three!')).toBe(true);
    expect(liveRows()[0]?.firstChild).toBe(kept); // row 0 was not repainted
    expect(part('ui.terminal')).not.toBeNull();
  });

  it('coalesces many writes into one frame and repaints only the row they touched', async () => {
    const s = new Screen(20, 4);
    mount(() => <Terminal screen={s} onData={() => {}} labels={LABELS} />);
    await frame();
    const kept = liveRows().slice(1).map((r) => r.firstChild);
    const raf = globalThis.requestAnimationFrame;
    let frames = 0;
    globalThis.requestAnimationFrame = (f) => (frames++, raf(f));
    for (let i = 0; i < 15; i++) s.write('x');
    globalThis.requestAnimationFrame = raf;
    await frame();
    expect(frames).toBe(1);
    expect(liveRows()[0]?.textContent?.trimEnd()).toBe('x'.repeat(15));
    expect(liveRows().slice(1).map((r) => r.firstChild)).toEqual(kept);
  });

  it('sends keys as bytes and text as typed; the app cursor mode follows the program', async () => {
    const s = new Screen(20, 4);
    const sent: string[] = [];
    mount(() => <Terminal screen={s} onData={(d) => sent.push(d)} labels={LABELS} mac={false} />);
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    s.write('\x1b[?1h');
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true }));
    input().dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'hi', bubbles: true, cancelable: true }));
    expect(sent).toEqual(['\x1b[A', '\x1bOA', '\x03', 'hi']);
  });

  it('keeps the page’s own keys out: a keydown never bubbles past the terminal', () => {
    const s = new Screen(20, 4);
    let heard = 0;
    document.addEventListener('keydown', () => heard++);
    mount(() => <Terminal screen={s} onData={() => {}} labels={LABELS} />);
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(heard).toBe(0);
  });

  it('an ended terminal hands keys and clicks to onEndedKey and sends nothing', () => {
    const s = new Screen(20, 4);
    const sent: string[] = [];
    let ended = 0;
    mount(() => <Terminal screen={s} onData={(d) => sent.push(d)} labels={LABELS} ended onEndedKey={() => ended++} />);
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }));
    input().dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'a', bubbles: true, cancelable: true }));
    part('ui.terminal.screen')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(sent).toEqual([]);
    expect(ended).toBe(3);
  });

  it('the key row: Esc, and Ctrl applying to the next key only', () => {
    const s = new Screen(20, 4);
    const sent: string[] = [];
    mount(() => <Terminal screen={s} onData={(d) => sent.push(d)} labels={LABELS} keyRow />);
    const keys = [...document.querySelectorAll<HTMLButtonElement>('[data-kit="term-key"]')];
    expect(keys.map((k) => k.textContent)).toEqual(['Esc', '^C', 'Tab', '⇧Tab', 'Ctrl', '←', '↑', '↓', '→', 'Paste']);
    keys[0]?.click();
    keys[4]?.click();
    expect(keys[4]?.getAttribute('aria-pressed')).toBe('true');
    input().dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'c', bubbles: true, cancelable: true }));
    input().dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'c', bubbles: true, cancelable: true }));
    expect(sent).toEqual(['\x1b', '\x03', 'c']);
    expect(keys[4]?.getAttribute('aria-pressed')).toBe('false');
  });

  it('a bracketed paste when the program asked for one', () => {
    const s = new Screen(20, 4);
    const sent: string[] = [];
    mount(() => <Terminal screen={s} onData={(d) => sent.push(d)} labels={LABELS} />);
    s.write('\x1b[?2004h');
    const e = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: { getData(t: string): string } };
    Object.defineProperty(e, 'clipboardData', { value: { getData: () => 'a\nb' } });
    input().dispatchEvent(e);
    expect(sent).toEqual(['\x1b[200~a\rb\x1b[201~']);
  });

  it('shows the waiting line until the program draws, and a new screen starts over', async () => {
    const a = new Screen(20, 4);
    const b = new Screen(20, 4);
    const [screen, setScreen] = createSignal(a);
    let handle: TerminalHandle | undefined;
    mount(() => <Terminal screen={screen()} onData={() => {}} labels={LABELS} waiting="Opening…" ref={(h) => (handle = h)} />);
    expect(document.querySelector('[data-kit="term-wait"]')?.textContent).toContain('Opening…');
    a.write('drawn');
    await frame();
    expect(document.querySelector('[data-kit="term-wait"]')).toBeNull();
    setScreen(b);
    expect(document.querySelector('[data-kit="term-wait"]')).not.toBeNull();
    await frame();
    expect(liveRows().every((r) => r.textContent?.trim() === '')).toBe(true);
    expect(handle?.size()).toBeNull(); // happy-dom has no layout: no grid to report
  });

  it('focus reports go out only when the program asked', () => {
    const s = new Screen(20, 4);
    const sent: string[] = [];
    mount(() => <Terminal screen={s} onData={(d) => sent.push(d)} labels={LABELS} />);
    input().dispatchEvent(new FocusEvent('focus'));
    s.write('\x1b[?1004h');
    input().dispatchEvent(new FocusEvent('blur'));
    input().dispatchEvent(new FocusEvent('focus'));
    expect(sent).toEqual(['\x1b[O', '\x1b[I']);
    expect(part('ui.terminal')?.hasAttribute('data-focused')).toBe(true);
  });
});
