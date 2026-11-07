// What the terminal sends (src/terminal/keys.ts): v1's keyBytes cases, ported, plus the rest.
import { describe, expect, it } from 'vitest';
import { compose, keyBytes, pasted, rowKeyBytes, wheelBytes, type KeyLike } from '../src/terminal/keys.ts';

const k = (key: string, mods: Omit<KeyLike, 'key'> = {}): string | null => keyBytes({ key, ...mods });

describe('keyBytes', () => {
  it('what keys send', () => {
    expect(k('Enter')).toBe('\r');
    expect(k('Enter', { shiftKey: true })).toBe('\x1b\r');
    expect(k('Backspace')).toBe('\x7f');
    expect(k('Tab', { shiftKey: true })).toBe('\x1b[Z');
    expect(k('ArrowUp')).toBe('\x1b[A');
    expect(keyBytes({ key: 'ArrowUp' }, { appCursor: true })).toBe('\x1bOA');
    expect(k('ArrowLeft', { altKey: true })).toBe('\x1b[1;3D');
    expect(k('c', { ctrlKey: true })).toBe('\x03');
    expect(k('b', { altKey: true })).toBe('\x1bb');
    expect(keyBytes({ key: 'å', altKey: true }, { mac: true })).toBeNull(); // Option types characters on a Mac
    expect(k('a')).toBeNull(); // text comes through the input event
    expect(k('v', { metaKey: true })).toBeNull();
    expect(k('F5')).toBe('\x1b[15~');
  });

  it('home/end follow app cursor mode; function keys and modifiers', () => {
    expect(keyBytes({ key: 'Home' }, { appCursor: true })).toBe('\x1bOH');
    expect(k('End')).toBe('\x1b[F');
    expect(k('F1')).toBe('\x1bOP');
    expect(k('F2', { shiftKey: true })).toBe('\x1b[1;2Q');
    expect(k('F12')).toBe('\x1b[24~');
    expect(k('F13')).toBeNull();
    expect(k('Delete', { ctrlKey: true })).toBe('\x1b[3;5~');
    expect(k('PageUp')).toBe('\x1b[5~');
    expect(k('Backspace', { altKey: true })).toBe('\x1b\x7f');
    expect(k('[', { ctrlKey: true })).toBe('\x1b');
    expect(k(' ', { ctrlKey: true })).toBe('\x00');
    expect(k('Shift')).toBeNull();
    expect(k('Dead')).toBeNull();
  });
});

describe('the rest of the input', () => {
  it('a paste is one block, bracketed when asked, and cannot end the bracket early', () => {
    expect(pasted('a\r\nb\nc', false)).toBe('a\rb\rc');
    expect(pasted('x\x1b[201~y', true)).toBe('\x1b[200~xy\x1b[201~');
    expect(pasted('', true)).toBe('');
  });

  it('the key row follows app cursor mode', () => {
    expect(rowKeyBytes('up', false)).toBe('\x1b[A');
    expect(rowKeyBytes('up', true)).toBe('\x1bOA');
    expect(rowKeyBytes('ctrlc', false)).toBe('\x03');
    expect(rowKeyBytes('stab', false)).toBe('\x1b[Z');
  });

  it('the wheel: mouse events for a program that takes the mouse, arrows otherwise', () => {
    expect(wheelBytes(2, true, [3, 4], { mouse: 1000, sgrMouse: true, appCursor: false })).toBe('\x1b[<64;3;4M\x1b[<64;3;4M');
    expect(wheelBytes(1, false, [1, 1], { mouse: 0, sgrMouse: false, appCursor: true })).toBe('\x1bOB');
  });

  it("a phone's composing: backspaces over what changed, then the rest", () => {
    expect(compose('', 'hel')).toBe('hel');
    expect(compose('hel', 'help')).toBe('p');
    expect(compose('helo', 'hello')).toBe('\x7flo');
    expect(compose('日本', '日')).toBe('\x7f');
  });
});
