// Mount a component in happy-dom and clean up after each test.
import { afterEach } from 'vitest';
import { render } from 'solid-js/web';
import type { JSX } from 'solid-js';

const mounted: Array<() => void> = [];

afterEach(() => {
  while (mounted.length) mounted.pop()?.();
  document.body.innerHTML = '';
});

export function mount(view: () => JSX.Element): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  mounted.push(render(view, host));
  return host;
}

export const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const part = (name: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-part="${name}"]`);
