import { describe, expect, test, vi } from 'vitest';
import { computed, signal } from 'alien-signals';
import { createRoot, createSignal } from 'solid-js';
import { mount, part } from './helpers.tsx';
import { ExtensionSlot, Text, useSignal, type ExtensionOutput, type Subscribable } from '../src/index.ts';

describe('useSignal', () => {
  test('follows an alien-signals computed, and stops when its owner goes', () => {
    const count = signal(1);
    const doubled = computed(() => count() * 2);
    const seen: number[] = [];
    const dispose = createRoot((d) => {
      const value = useSignal(doubled);
      seen.push(value());
      count(2);
      seen.push(value());
      return d;
    });
    dispose();
    count(5);
    expect(seen).toEqual([2, 4]);
  });
  test('follows a subscribable store and unsubscribes on cleanup', () => {
    const listeners = new Set<(v: string) => void>();
    let current = 'a';
    const store: Subscribable<string> = {
      get: () => current,
      subscribe: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    };
    const dispose = createRoot((d) => {
      const value = useSignal(store);
      expect(value()).toBe('a');
      current = 'b';
      for (const l of listeners) l(current);
      expect(value()).toBe('b');
      return d;
    });
    dispose();
    expect(listeners.size).toBe(0);
  });
  test('re-renders the DOM when the signal changes', () => {
    const name = signal('Ada');
    mount(() => {
      const v = useSignal(name);
      return <Text part="who.text">{v()}</Text>;
    });
    name('Grace');
    expect(part('who.text')?.textContent).toBe('Grace');
  });
  test('a function value is stored, not called as an updater', () => {
    const fn = () => 42;
    const s = signal(fn);
    createRoot((d) => {
      expect(useSignal(s)()).toBe(fn);
      d();
    });
  });
});

describe('ExtensionSlot', () => {
  const ext = (id: string): ExtensionOutput => ({ id, render: () => <Text part={`ext.${id}`}>{id}</Text> });

  test('renders each extension under the input’s part, keyed by id', () => {
    mount(() => <ExtensionSlot input="shell.composer:left" extensions={[ext('a'), ext('b')]} />);
    const slot = part('shell.composer:left');
    expect(slot?.getAttribute('data-input')).toBe('shell.composer:left');
    expect([...(slot?.querySelectorAll('[data-extension]') ?? [])].map((e) => e.getAttribute('data-extension'))).toEqual(['a', 'b']);
  });

  test('a reorder moves the same nodes; nothing remounts', () => {
    const list = signal([ext('a'), ext('b'), ext('c')]);
    mount(() => {
      const items = useSignal(list);
      return <ExtensionSlot input="shell.list:top" extensions={items()} />;
    });
    const before = part('ext.a');
    const current = list();
    list([...current].reverse());
    const after = part('ext.a');
    expect(after).toBe(before);
    expect([...document.querySelectorAll('[data-extension]')].map((e) => e.getAttribute('data-extension'))).toEqual(['c', 'b', 'a']);
  });

  test('one extension throwing leaves the others and reports it', () => {
    const onError = vi.fn();
    const bad: ExtensionOutput = {
      id: 'bad',
      render: () => {
        throw new Error('boom');
      },
    };
    mount(() => <ExtensionSlot input="shell.task:head" extensions={[ext('ok'), bad]} onError={onError} />);
    expect(part('ext.ok')).not.toBeNull();
    expect(onError).toHaveBeenCalledWith('bad', expect.any(Error));
  });

  test('empty: the fallback shows', () => {
    mount(() => <ExtensionSlot input="shell.list:top" extensions={[]} fallback={<Text part="empty.text">none</Text>} />);
    expect(part('empty.text')).not.toBeNull();
  });
});

test('useSignal follows a getter over Solid signals too (a form draft read by a setting control)', () => {
  createRoot((dispose) => {
    const [draft, setDraft] = createSignal('a');
    const v = useSignal(() => draft());
    expect(v()).toBe('a');
    setDraft('b');
    expect(v()).toBe('b');
    dispose();
  });
});
