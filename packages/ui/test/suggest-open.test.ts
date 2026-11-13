// A suggest row with a second way to take it (a file: ↵ inserts its mention, ⌘↵ or its Open button opens it).
import { expect, test } from 'vitest';
import { suggestKey, suggestKeyDown, type PromptSuggest } from '../src/composer/suggest-keys.ts';

const k = (key: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey', boolean>> = {}) => ({
  key,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ctrlKey: false,
  isComposing: false,
  ...mods,
});

test('mod_enter_opens_the_active_row_that_can_open_and_enter_still_picks', () => {
  expect(suggestKey(k('Enter'), 2, 0)).toEqual({ t: 'pick' });
  expect(suggestKey(k('Enter', { metaKey: true }), 2, 0)).toEqual({ t: 'open' });
  expect(suggestKey(k('Enter', { ctrlKey: true }), 2, 0)).toEqual({ t: 'open' });
  const did: string[] = [];
  const s: PromptSuggest = {
    id: 'm',
    label: 'm',
    active: 0,
    items: [
      { value: 'file:a.ts', label: 'a.ts', onOpen: () => did.push('open') },
      { value: 'x', label: 'x' },
    ],
    onPick: (v) => did.push(`pick ${v}`),
    onActive: () => undefined,
    onClose: () => did.push('close'),
  };
  const ev = (e: ReturnType<typeof k>) => ({ ...e, preventDefault: () => undefined }) as unknown as KeyboardEvent;
  expect(suggestKeyDown(s, ev(k('Enter', { metaKey: true })))).toBe(true);
  expect(suggestKeyDown({ ...s, active: 1 }, ev(k('Enter', { metaKey: true })))).toBe(false);
  expect(suggestKeyDown(s, ev(k('Enter')))).toBe(true);
  expect(did).toEqual(['open', 'close', 'pick file:a.ts']);
});
