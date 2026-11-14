import { expect, test } from 'vitest';
import { allowed, candidates, displayCombo, imeArtifact, matches, parseCombo, type Owned } from '../src/keys.ts';

const key = (k: string, mods: Partial<{ meta: boolean; ctrl: boolean; alt: boolean; shift: boolean }> = {}, code?: string) => ({
  key: k, metaKey: !!mods.meta, ctrlKey: !!mods.ctrl, altKey: !!mods.alt, shiftKey: !!mods.shift, ...(code && { code }),
});

test('mod is ⌘ on a Mac and Ctrl elsewhere', () => {
  expect(matches('mod+k', key('k', { meta: true }), true)).toBe(true);
  expect(matches('mod+k', key('k', { ctrl: true }), true)).toBe(false);
  expect(matches('mod+k', key('k', { ctrl: true }), false)).toBe(true);
  expect(displayCombo('mod+k', true)).toEqual(['⌘', 'K']);
  expect(displayCombo('mod+k', false)).toEqual(['Ctrl', 'K']);
});

test('Shift counts for letters, not for keys that already need it', () => {
  expect(matches('shift+r', key('R', { shift: true }), true)).toBe(true);
  expect(matches('r', key('R', { shift: true }), true)).toBe(false);
  expect(matches('?', key('?', { shift: true }), true)).toBe(true);
  expect(matches('ctrl+`', key('`', { ctrl: true }, 'Backquote'), true)).toBe(true);
  expect(parseCombo('esc').key).toBe('escape');
});

test('the Safari IME guard: a 229 Enter that only picked a word', () => {
  expect(imeArtifact({ ...key('Enter'), keyCode: 229, isComposing: false })).toBe(true);
  expect(imeArtifact({ ...key('Enter'), keyCode: 13 })).toBe(false);
  expect(imeArtifact({ ...key('a'), keyCode: 229 })).toBe(false);
});

const s = (id: string, keys: string, more: Partial<Owned> = {}): Owned => ({ id, keys, label: id, plugin: 'wisp.x', run: () => {}, ...more });
const idle = { typing: false, overlay: false, focused: undefined, apple: true };

test("single keys wait while typing or under an overlay; 'always' doesn't", () => {
  const list = [s('n', 'n'), s('k', 'mod+k', { when: 'always' })];
  expect(candidates(list, key('n'), { ...idle, typing: true })).toEqual([]);
  expect(candidates(list, key('n'), { ...idle, overlay: true })).toEqual([]);
  expect(candidates(list, key('n'), idle).map((x) => x.id)).toEqual(['n']);
  expect(candidates(list, key('k', { meta: true }), { ...idle, typing: true }).map((x) => x.id)).toEqual(['k']);
});

test("'task' shortcuts need a focused task; later registrations are tried first", () => {
  const list = [s('a', 'e', { when: 'task' }), s('b', 'e', { when: 'task' })];
  expect(candidates(list, key('e'), idle)).toEqual([]);
  expect(candidates(list, key('e'), { ...idle, focused: 'p:1' }).map((x) => x.id)).toEqual(['b', 'a']);
});

test("a user plugin can't take a key wisp uses itself", () => {
  expect(allowed(s('x', 'e', { plugin: 'acme' }))).toBe(false);
  expect(allowed(s('x', 'mod+k', { plugin: 'acme' }))).toBe(false);
  expect(allowed(s('x', 'g', { plugin: 'acme' }))).toBe(true);
  expect(allowed(s('x', 'e', { plugin: 'wisp.task' }))).toBe(true);
});
