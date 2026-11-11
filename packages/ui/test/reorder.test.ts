// v1 #772: items of one list dragged (or moved with Alt+arrows) into your own order; a drop from another list is ignored.
import { expect, test } from 'vitest';
import { reorderable, reordered } from '../src/core/reorder.ts';

const ev = <T extends object>(o: T): T & { preventDefault: () => void; currentTarget: HTMLElement } => ({ preventDefault: () => undefined, currentTarget: document.createElement('button'), ...o });
/** one drag's DataTransfer, shared by its start and its drop, as a browser's is */
const transfer = () => {
  const data = new Map<string, string>();
  return {
    setData: (t: string, v: string) => void data.set(t, v),
    getData: (t: string) => data.get(t) ?? '',
    get types() {
      return [...data.keys()];
    },
    effectAllowed: 'all',
  };
};

test('a_dragged_or_alt_moved_item_lands_before_the_one_it_was_dropped_on_and_only_within_its_list', () => {
  expect(reordered(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
  expect(reordered(['a', 'b', 'c'], 'a', undefined)).toEqual(['b', 'c', 'a']);
  const ids = (): string[] => ['a', 'b', 'c'];
  const got: [string, string | undefined][] = [];
  const on = (id: string, before: string | undefined): void => void got.push([id, before]);
  expect(reorderable('l', 'a', ids, undefined)).toEqual({});
  const a = reorderable('l', 'a', ids, on);
  const c = reorderable('l', 'c', ids, on);
  const other = reorderable('m', 'x', () => ['x'], on);
  const one = transfer();
  a.onDragStart?.(ev({ dataTransfer: one }) as unknown as DragEvent);
  c.onDrop?.(ev({ dataTransfer: one }) as unknown as DragEvent);
  const two = transfer();
  other.onDragStart?.(ev({ dataTransfer: two }) as unknown as DragEvent);
  a.onDrop?.(ev({ dataTransfer: two }) as unknown as DragEvent);
  // keyboard: Alt+→ moves it one place on, Alt+← one back; at the end nothing happens
  a.onKeyDown?.(ev({ altKey: true, key: 'ArrowRight' }) as unknown as KeyboardEvent);
  c.onKeyDown?.(ev({ altKey: true, key: 'ArrowLeft' }) as unknown as KeyboardEvent);
  c.onKeyDown?.(ev({ altKey: true, key: 'ArrowRight' }) as unknown as KeyboardEvent);
  a.onKeyDown?.(ev({ altKey: false, key: 'ArrowRight' }) as unknown as KeyboardEvent);
  expect(got).toEqual([
    ['a', 'c'],
    ['a', 'c'],
    ['c', 'b'],
  ]);
});
