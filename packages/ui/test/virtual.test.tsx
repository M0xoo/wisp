import { afterEach, describe, expect, test } from 'vitest';
import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { Each, VirtualList } from '../src/layout/VirtualList.tsx';
import { anchorAt, atTail, computeRange, offsets, restoreAnchor, rowAt, TAIL_SLACK } from '../src/layout/virtual-math.ts';

/** A small seeded PRNG (mulberry32), so a failing case can be replayed from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const int = (r: () => number, max: number): number => Math.floor(r() * (max + 1));

describe('virtual-math (property tests, 500 seeded cases each)', () => {
  test('offsets are monotonic and end at the sum', () => {
    for (let seed = 1; seed <= 500; seed++) {
      const r = rng(seed);
      const heights = Array.from({ length: int(r, 60) }, () => int(r, 120));
      const o = offsets(heights);
      expect(o.length, `seed ${seed}`).toBe(heights.length + 1);
      for (let i = 1; i < o.length; i++) expect((o[i] ?? 0) >= (o[i - 1] ?? 0), `seed ${seed}`).toBe(true);
      expect(o[o.length - 1]).toBe(heights.reduce((a, b) => a + b, 0));
    }
  });

  test('a range covers the viewport and spacers + rows add up to the total', () => {
    for (let seed = 1; seed <= 500; seed++) {
      const r = rng(seed);
      const heights = Array.from({ length: int(r, 80) }, () => 1 + int(r, 90));
      const o = offsets(heights);
      const total = o[o.length - 1] ?? 0;
      const view = int(r, 700);
      const top = int(r, total + 200) - 50;
      const overscan = int(r, 5);
      const g = computeRange(o, top, view, overscan);
      const rendered = (o[g.end] ?? 0) - (o[g.start] ?? 0);
      expect(g.padTop + rendered + g.padBottom, `seed ${seed}`).toBe(total);
      expect(g.start <= g.end && g.end <= heights.length, `seed ${seed}`).toBe(true);
      const clamped = Math.min(Math.max(0, top), Math.max(0, total - view));
      expect(g.padTop <= clamped, `seed ${seed}: top spacer reaches into the viewport`).toBe(true);
      expect(total - g.padBottom >= Math.min(total, clamped + view), `seed ${seed}: viewport bottom uncovered`).toBe(true);
    }
  });

  test('an anchor restores to the same scrollTop when nothing changed', () => {
    for (let seed = 1; seed <= 500; seed++) {
      const r = rng(seed);
      const o = offsets(Array.from({ length: 1 + int(r, 40) }, () => 1 + int(r, 60)));
      const top = int(r, o[o.length - 1] ?? 0);
      expect(restoreAnchor(o, anchorAt(o, top)), `seed ${seed}`).toBe(top);
    }
  });

  test('a row growing above the anchor moves the restored scrollTop by exactly the growth', () => {
    const before = offsets([50, 50, 50, 50]);
    const a = anchorAt(before, 120); // row 2, 20px in
    expect(a).toEqual({ index: 2, delta: 20 });
    expect(restoreAnchor(offsets([50, 80, 50, 50]), a)).toBe(150);
  });

  test('rowAt, empty lists and the tail slack', () => {
    expect(rowAt(offsets([10, 10, 10]), 15)).toBe(1);
    expect(computeRange(offsets([]), 0, 500, 3)).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0, total: 0 });
    expect(TAIL_SLACK).toBe(40);
    expect(atTail(960, 500, 1500)).toBe(true);
    expect(atTail(959, 500, 1500)).toBe(false);
  });
});

interface Row {
  readonly id: string;
  readonly text: string;
}

const rows = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, text: `Row ${i}` }));

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = '';
});

function mount(fn: () => ReturnType<typeof VirtualList>): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  dispose = render(fn, host);
  return host;
}

const nodeFor = (host: HTMLElement, id: string): Element | null => host.querySelector(`[data-id="${id}"]`);

describe('VirtualList', () => {
  test('renders its data-part, rows and spacers, not every row', () => {
    const host = mount(() => (
      <VirtualList items={rows(5000)} key={(r) => r.id} estimate={30} viewport={300}>
        {(r) => <span data-id={r().id}>{r().text}</span>}
      </VirtualList>
    ));
    expect(host.querySelector('[data-part="ui.virtual-list"]')).not.toBeNull();
    const count = host.querySelectorAll('[data-kit="virtual-row"]').length;
    expect(count).toBeGreaterThan(5);
    expect(count).toBeLessThan(40);
    const spacers = host.querySelectorAll<HTMLElement>('[data-kit="virtual-spacer"]');
    expect(spacers.length).toBe(2);
    expect(spacers[1]?.style.height).not.toBe('0px');
  });

  test('a reorder moves the same DOM nodes in place', () => {
    const [items, setItems] = createSignal(rows(10));
    const host = mount(() => (
      <VirtualList items={items()} key={(r) => r.id} estimate={30} viewport={600}>
        {(r) => <span data-id={r().id}>{r().text}</span>}
      </VirtualList>
    ));
    const before = items().map((r) => nodeFor(host, r.id));
    expect(before.every((n) => n !== null)).toBe(true);
    setItems([...items()].reverse());
    const after = items().map((r) => nodeFor(host, r.id));
    // Same node per key, now in the new order.
    for (const r of items()) expect(nodeFor(host, r.id)).toBe(before[Number(r.id.slice(1))]);
    const order = [...host.querySelectorAll('[data-id]')].map((n) => n.getAttribute('data-id'));
    expect(order).toEqual(items().map((r) => r.id));
    expect(after.length).toBe(10);
  });

  test('an updated item keeps its node and shows the new value', () => {
    const [items, setItems] = createSignal(rows(3));
    const host = mount(() => (
      <VirtualList items={items()} key={(r) => r.id} viewport={600}>
        {(r) => <span data-id={r().id}>{r().text}</span>}
      </VirtualList>
    ));
    const node = nodeFor(host, 'r1');
    setItems(items().map((r) => (r.id === 'r1' ? { ...r, text: 'Renamed' } : r)));
    expect(nodeFor(host, 'r1')).toBe(node);
    expect(node?.textContent).toBe('Renamed');
  });

  test('passes each row its index in the whole list', () => {
    const host = mount(() => (
      <VirtualList items={rows(4)} key={(r) => r.id} viewport={600}>
        {(r, i) => <span data-id={r().id}>{i()}</span>}
      </VirtualList>
    ));
    expect(nodeFor(host, 'r3')?.textContent).toBe('3');
  });

  test('bottom anchor marks the list as a transcript', () => {
    const host = mount(() => (
      <VirtualList items={rows(50)} key={(r) => r.id} anchor="bottom" viewport={200} part="task.transcript">
        {(r) => <span data-id={r().id}>{r().text}</span>}
      </VirtualList>
    ));
    expect(host.querySelector('[data-part="task.transcript"]')?.getAttribute('data-anchor')).toBe('bottom');
  });
});

describe('Each', () => {
  test('keeps keyed nodes in place on reorder, without an element of its own', () => {
    const [items, setItems] = createSignal(rows(5));
    const host = document.createElement('ul');
    document.body.append(host);
    dispose = render(() => <Each items={items()} key={(r) => r.id}>{(r) => <li data-id={r().id}>{r().text}</li>}</Each>, host);
    const first = nodeFor(host, 'r0');
    setItems([...items()].reverse());
    expect(host.lastElementChild).toBe(first);
    expect(host.children.length).toBe(5);
  });
});
