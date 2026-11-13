// F-page-25 (v1 editor.js hoverOn): FileView asks onHover after the pointer rests 600 ms on a name, shows the words in
// a tip, drops an answer that comes after the pointer moved on, and hides on a key.
import { afterEach, expect, test, vi } from 'vitest';
import { render } from 'solid-js/web';
import { FileView } from '../src/content/file/FileView.tsx';

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('resting_on_a_name_shows_the_language_servers_words_and_a_move_or_key_hides_them', async () => {
  vi.useFakeTimers();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ font: '', measureText: (s: string) => ({ width: s.length * 8 }) } as never);
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  const asked: { line: number; col: number }[] = [];
  const host = document.createElement('div');
  document.body.append(host);
  dispose = render(() => <FileView text={'let squash = 1;'} lang="ts" aria-label="a.ts" onHover={(at) => (asked.push(at), Promise.resolve('```ts\nconst squash: 1\n```'))} />, host);
  const area = host.querySelector('textarea') as HTMLTextAreaElement;
  vi.spyOn(area, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0 } as DOMRect);
  // jsdom: no padding, line-height `normal` (20 px); x 8*5+1 is col 6 (the q of squash)
  area.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 41, clientY: 5 }));
  await vi.advanceTimersByTimeAsync(599);
  expect(asked).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(asked).toEqual([{ line: 1, col: 6 }]);
  expect(host.querySelector('[data-kit="fv-hover"]')?.textContent).toBe('const squash: 1');
  area.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a' }));
  expect(host.querySelector('[data-kit="fv-hover"]')).toBeNull();
  // on a blank: nothing asked
  area.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 8 * 3 + 1, clientY: 5 }));
  await vi.advanceTimersByTimeAsync(700);
  expect(asked).toHaveLength(1);
});
