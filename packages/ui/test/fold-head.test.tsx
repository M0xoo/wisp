// A section's heading (shell-list/FoldHead.tsx, v1 split.css .f-group > h4.sec-toggle): click, Enter or Space folds it.
import { expect, test } from 'vitest';
import { createSignal } from 'solid-js';
import { mount } from './helpers.tsx';
import { FoldHead } from '../src/shell-list/FoldHead.tsx';

test('a section folds and unfolds by click, Enter and Space, and says so to a screen reader_v1_section_fold', () => {
  const [open, setOpen] = createSignal(true);
  const host = mount(() => <FoldHead title="Working" count={3} open={open()} onToggle={() => setOpen(!open())} />);
  const h = host.querySelector('[data-kit="fold-head"]') as HTMLElement;
  expect([h.getAttribute('role'), h.tabIndex, h.getAttribute('aria-expanded')]).toEqual(['button', 0, 'true']);
  h.click();
  expect(h.getAttribute('aria-expanded')).toBe('false');
  h.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(open()).toBe(true);
  h.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
  expect(open()).toBe(false);
  h.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
  expect(open()).toBe(false);
});
