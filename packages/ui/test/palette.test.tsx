// The kit's palette sheet (app/Palette.tsx): v1 web/js/palette.js's markup, driven by its caller.
import { afterEach, expect, test } from 'vitest';
import { render } from 'solid-js/web';
import { createSignal } from 'solid-js';
import { PaletteSheet, type PaletteRow } from '../src/app/Palette.tsx';

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = '';
});

const ROWS: PaletteRow[] = [
  { id: 't1', head: 'Tasks', label: [['Fix ', false], ['lo', true], ['gin', false]], sub: 'wisp · Finished · 5m', dot: 'pc-violet' },
  { id: 'c1', head: 'Crew', label: [['Ada', false]], sub: 'Reviews every PR · Only when asked', icon: 'crew' },
  { id: 'a1', head: 'Actions', label: [['New task', false]], icon: 'plus', kbd: ['N'] },
];

test('groups head their first row, the found letters are marked, a dot or an icon leads, the shortcut ends the row', () => {
  const host = document.createElement('div');
  document.body.append(host);
  const picked: number[] = [];
  const [sel, setSel] = createSignal(0);
  dispose = render(
    () => (
      <PaletteSheet value="lo" placeholder="Search" label="Command palette" rows={ROWS} selected={sel()} empty="No results" foot={{ navigate: 'navigate', open: 'open', close: 'close' }} onInput={() => {}} onKeyDown={() => {}} onPick={(i) => picked.push(i)} onHover={setSel} />
    ),
    host,
  );
  expect([...host.querySelectorAll('[data-kit="pal-group"]')].map((g) => g.textContent)).toEqual(['Tasks', 'Crew', 'Actions']);
  const rows = host.querySelectorAll<HTMLElement>('[data-kit="pal-row"]');
  expect(rows[0]?.querySelector('mark')?.textContent).toBe('lo');
  expect(rows[0]?.querySelector('[data-kit="dot"]')).not.toBeNull();
  expect(rows[1]?.querySelector('[data-kit="icon"]')).not.toBeNull();
  expect(rows[2]?.querySelector('[data-kit="pal-kbd"]')?.textContent).toBe('N');
  expect(rows[0]?.hasAttribute('data-on')).toBe(true);
  expect(host.querySelector('input')?.getAttribute('aria-activedescendant')).toBe('palette-row-0');
  rows[2]?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
  expect(rows[2]?.getAttribute('aria-selected')).toBe('true');
  expect(rows[0]?.hasAttribute('data-on')).toBe(false);
  rows[1]?.click();
  expect(picked).toEqual([1]);
  expect(host.querySelector('[data-kit="pal-foot"]')?.textContent).toContain('navigate');
});

test('no rows: the empty line instead of a listbox', () => {
  const host = document.createElement('div');
  document.body.append(host);
  dispose = render(
    () => <PaletteSheet value="zzz" placeholder="Search" label="Command palette" rows={[]} selected={0} empty="No results for “zzz”" foot={{ navigate: 'n', open: 'o', close: 'c' }} onInput={() => {}} onKeyDown={() => {}} onPick={() => {}} onHover={() => {}} />,
    host,
  );
  expect(host.querySelector('[data-kit="pal-empty"]')?.textContent).toBe('No results for “zzz”');
  expect(host.querySelector('[data-kit="pal-list"]')?.getAttribute('role')).toBe('presentation');
});
