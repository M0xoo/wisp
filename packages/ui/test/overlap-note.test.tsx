// The overlap note's × (app/Task.tsx OverlapNote, v1 #787 .ov-x): last on the row, a restylable part, calls the host.
import { afterEach, expect, test } from 'vitest';
import { render } from 'solid-js/web';
import { OverlapNote } from '../src/app/Task.tsx';

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = '';
});

test('the overlap note has a dismiss × last on its row, and only when the host offers one_v1_overlap_close', () => {
  const host = document.createElement('div');
  document.body.append(host);
  let closed = 0;
  dispose = render(
    () => (
      <OverlapNote head="Overlaps with “b”" files="Conflicts in a.ts" moreTitle="All" open="Open" openTitle="Open that task" dismiss={{ label: 'Dismiss', title: 'Dismiss until something changes', onDismiss: () => closed++ }} />
    ),
    host,
  );
  const x = host.querySelector('[data-part="card.overlapClose"]') as HTMLButtonElement;
  expect(x.getAttribute('aria-label')).toBe('Dismiss');
  expect(x.parentElement?.lastElementChild).toBe(x);
  x.click();
  expect(closed).toBe(1);
  dispose();
  host.innerHTML = '';
  dispose = render(() => <OverlapNote head="h" files="f" moreTitle="All" open="Open" openTitle="o" />, host);
  expect(host.querySelector('[data-part="card.overlapClose"]')).toBeNull();
});
