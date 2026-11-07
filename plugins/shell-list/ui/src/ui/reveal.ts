// Bringing a row into view when the keyboard moves to it (j / k, the palette, a link). The list is
// virtual, so the row may not exist yet: scroll near it by the estimate first, then let the browser
// put the real row at the nearest edge once it renders. Never scrolls when the row is already in view.

import { indexOfKey, type Item } from '../model/flat.ts';

export function revealIn(box: HTMLElement, items: readonly Item[], key: string, estimate: number): void {
  const row = (): Element | null => box.querySelector(`[data-row-key="${CSS.escape(key)}"]`);
  const shown = row();
  if (shown) {
    shown.scrollIntoView({ block: 'nearest' });
    return;
  }
  const i = indexOfKey(items, key);
  if (i < 0) return;
  box.scrollTop = Math.max(0, i * estimate - box.clientHeight / 2);
  requestAnimationFrame(() => row()?.scrollIntoView({ block: 'nearest' }));
}
