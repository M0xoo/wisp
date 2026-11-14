// PathField (v1 projects.js .path-input + .suggest): the server's folder suggestions under a typed path.
import { expect, test, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { mount } from './helpers.tsx';
import { PathField } from '../src/controls/PathField.tsx';

const key = (el: Element | null, k: string): void => {
  el?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
};
const type = (el: HTMLInputElement | null, text: string): void => {
  if (!el) return;
  el.value = text;
  el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
};
const options = (): string[] => [...document.querySelectorAll('[data-kit="path-option"]')].map((o) => o.textContent ?? '');

test('typing asks for folders after a pause; arrows pick, Tab goes into one, Enter picks it, a git URL asks nothing_v1_path_input', async () => {
  vi.useFakeTimers();
  const asked: string[] = [];
  const suggest = (q: string): Promise<readonly string[]> => {
    asked.push(q);
    return Promise.resolve(q.startsWith('~/code/') ? ['~/code/web', '~/code/wiki'] : ['~/code', '~/notes']);
  };
  const picked: string[] = [];
  const entered: string[] = [];
  const [value, setValue] = createSignal('');
  mount(() => <PathField value={value()} onInput={setValue} suggest={suggest} skip={(q) => q.startsWith('https://')} onPick={(p) => picked.push(p)} onEnter={(v) => entered.push(v)} aria-label="Folder" />);
  const input = document.querySelector<HTMLInputElement>('input');
  expect(input?.getAttribute('role')).toBe('combobox');

  type(input, '~/c');
  type(input, '~/co');
  expect(asked).toEqual([]);
  await vi.advanceTimersByTimeAsync(120);
  expect(asked).toEqual(['~/co']); // one ask, after the last keystroke
  await vi.advanceTimersByTimeAsync(0);
  expect(options()).toEqual(['~/code', '~/notes']);
  expect(input?.getAttribute('aria-expanded')).toBe('true');

  // ↓ highlights the first; Tab puts it in the box with a / and asks again under it
  key(input, 'ArrowDown');
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector('[data-kit="path-option"][data-on]')?.textContent).toBe('~/code');
  key(input, 'Tab');
  expect(value()).toBe('~/code/');
  await vi.advanceTimersByTimeAsync(120);
  await vi.advanceTimersByTimeAsync(0);
  expect(options()).toEqual(['~/code/web', '~/code/wiki']);

  // ↓ ↓ then Enter picks the second; the list closes
  key(input, 'ArrowDown');
  key(input, 'ArrowDown');
  key(input, 'Enter');
  await vi.advanceTimersByTimeAsync(0);
  expect(picked).toEqual(['~/code/wiki']);
  expect(options()).toEqual([]);

  // Enter with nothing highlighted is what's typed
  setValue('/opt/x');
  key(input, 'Enter');
  expect(entered).toEqual(['/opt/x']);

  // a git URL: no suggestions asked
  const before = asked.length;
  type(input, 'https://github.com/a/b');
  await vi.advanceTimersByTimeAsync(200);
  expect(asked.length).toBe(before);
  vi.useRealTimers();
});
