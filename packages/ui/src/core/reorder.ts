// Dragging items of one list into your own order (v1 #772, the project chips): HTML drag and drop between items that
// share a list, and Alt+←/→ (Alt+↑/↓ in a column) on a focused item for the keyboard. The list says where an item
// went with `onReorder(id, before)`: before the item `before`, or at the end when it's undefined. Nothing moves in the
// DOM here: the list re-renders in its new order (keyed, so nodes move in place).

export type OnReorder = (id: string, before: string | undefined) => void;

/** What an item gets: drag handlers and its key for moving. */
export interface ReorderAttrs {
  readonly draggable?: boolean;
  readonly 'data-reorder'?: string;
  readonly onDragStart?: (e: DragEvent) => void;
  readonly onDragOver?: (e: DragEvent) => void;
  readonly onDragLeave?: (e: DragEvent) => void;
  readonly onDrop?: (e: DragEvent) => void;
  readonly onDragEnd?: () => void;
  readonly onKeyDown?: (e: KeyboardEvent) => void;
}

/** The drag carries its item on the event, under a type naming its list (a type is readable during dragover). */
const typeOf = (list: string): string => `application/x-wisp-reorder-${list.toLowerCase().replace(/[^a-z0-9.-]/g, '-')}`;
const ours = (e: DragEvent, list: string): boolean => [...(e.dataTransfer?.types ?? [])].includes(typeOf(list));

/** The attributes that make item `id` of list `list` (its ids in order: `ids()`) draggable; none without `on`. */
export function reorderable(list: string, id: string, ids: () => readonly string[], on: OnReorder | undefined): ReorderAttrs {
  if (!on) return {};
  const after = (step: number): void => {
    const all = ids();
    const i = all.indexOf(id);
    if (i < 0) return;
    const j = Math.max(0, Math.min(all.length - 1, i + step));
    if (j === i) return;
    on(id, step > 0 ? all[j + 1] : all[j]);
  };
  return {
    draggable: true,
    'data-reorder': '',
    onDragStart: (e: DragEvent) => {
      e.dataTransfer?.setData(typeOf(list), id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    },
    onDragOver: (e: DragEvent) => {
      if (!ours(e, list)) return;
      e.preventDefault();
      (e.currentTarget as HTMLElement).dataset['dropOn'] = '';
    },
    onDragLeave: (e: DragEvent) => {
      delete (e.currentTarget as HTMLElement).dataset['dropOn'];
    },
    onDrop: (e: DragEvent) => {
      delete (e.currentTarget as HTMLElement).dataset['dropOn'];
      if (!ours(e, list)) return;
      const moved = e.dataTransfer?.getData(typeOf(list)) ?? '';
      e.preventDefault();
      if (moved && moved !== id) on(moved, id);
    },
    onDragEnd: () => undefined,
    onKeyDown: (e: KeyboardEvent) => {
      if (!e.altKey) return;
      const step = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : 0;
      if (!step) return;
      e.preventDefault();
      after(step);
    },
  };
}

/** Where `id` goes in `ids` after `onReorder(id, before)`, for a list that keeps its own order. */
export function reordered(ids: readonly string[], id: string, before: string | undefined): string[] {
  const rest = ids.filter((x) => x !== id);
  const i = before === undefined ? -1 : rest.indexOf(before);
  rest.splice(i < 0 ? rest.length : i, 0, id);
  return rest;
}
