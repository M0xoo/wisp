// The keys of a prompt's @ and / menus (SuggestList, PromptSuggest): what a key does to an open list. Plain, so
// what needs only the keys (and their tests) needn't compile the components.
import type { IconName } from '../content/icons.ts';

export interface SuggestItem {
  readonly value: string;
  readonly label: string;
  /** A second, quieter part on the same line ("question", the args of a command). */
  readonly detail?: string;
  /** One line under the label. */
  readonly hint?: string;
  readonly icon?: IconName;
  /** A second way to take it: an Open button on the row (and ⌘↵ / Ctrl+↵ on the active row), e.g. a file in the
   * file view while ↵ inserts its mention. */
  readonly onOpen?: () => void;
  readonly openLabel?: string;
}

export const optionId = (list: string, i: number): string => `${list}-o${i}`;

/** What a key does to an open list: move the active row, pick it, close, or nothing. */
export function suggestKey(
  e: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'isComposing' | 'altKey' | 'metaKey' | 'ctrlKey'>,
  count: number,
  active: number,
): { readonly t: 'move'; readonly to: number } | { readonly t: 'pick' } | { readonly t: 'open' } | { readonly t: 'close' } | undefined {
  if (count === 0 || e.isComposing) return e.key === 'Escape' ? { t: 'close' } : undefined;
  if (e.key === 'ArrowDown') return { t: 'move', to: (active + 1) % count };
  if (e.key === 'ArrowUp') return { t: 'move', to: (active - 1 + count) % count };
  if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) return { t: 'pick' };
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) return { t: 'open' };
  if (e.key === 'Escape') return { t: 'close' };
  return undefined;
}

export interface PromptSuggest {
  readonly id: string;
  readonly label: string;
  readonly items: readonly SuggestItem[];
  readonly active: number;
  readonly onPick: (value: string) => void;
  readonly onActive: (index: number) => void;
  readonly onClose: () => void;
}

/** A key in the box while the menu is open: true when the menu took it (the box does nothing more). */
export function suggestKeyDown(s: PromptSuggest | undefined, e: KeyboardEvent): boolean {
  if (!s || s.items.length === 0) return false;
  const r = suggestKey(e, s.items.length, s.active);
  if (!r) return false;
  e.preventDefault();
  if (r.t === 'move') s.onActive(r.to);
  else if (r.t === 'pick') {
    const it = s.items[s.active];
    if (it) s.onPick(it.value);
  } else if (r.t === 'open') {
    const it = s.items[s.active];
    if (!it?.onOpen) return false;
    it.onOpen();
    s.onClose();
  } else s.onClose();
  return true;
}
