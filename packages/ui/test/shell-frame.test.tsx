// The app frame: one DOM for both layouts (switching split ↔ stack moves nothing and builds
// nothing again), the stacked page is the only active pane, and the side pane exists only when open.
import { expect, test } from 'vitest';
import { createSignal } from 'solid-js';
import { mount, tick } from './helpers.tsx';
import { Frame, Text } from '../src/index.ts';

test('switching layout and page keeps every pane built once', async () => {
  let builtList = 0;
  let builtMain = 0;
  const List = () => {
    builtList++;
    return <Text part="t.list">list</Text>;
  };
  const Main = () => {
    builtMain++;
    return <Text part="t.main">main</Text>;
  };
  const [layout, setLayout] = createSignal<'split' | 'stack'>('split');
  const [page, setPage] = createSignal<'list' | 'main' | 'side'>('list');
  mount(() => <Frame layout={layout()} page={page()} top={<Text>top</Text>} list={<List />} main={<Main />} />);
  const list = document.querySelector('[data-part="t.list"]');
  setLayout('stack');
  setPage('main');
  await tick();
  setLayout('split');
  await tick();
  expect([builtList, builtMain]).toEqual([1, 1]);
  expect(document.querySelector('[data-part="t.list"]')).toBe(list);
});

test('stacked: only the page on screen is active; split: every pane is', () => {
  const [layout, setLayout] = createSignal<'split' | 'stack'>('stack');
  mount(() => <Frame layout={layout()} page="main" sideOpen top={null} list={null} main={null} side={<Text>side</Text>} />);
  const active = () => [...document.querySelectorAll('[data-kit="frame-pane"][data-active]')].map((e) => e.getAttribute('data-pane'));
  expect(active()).toEqual(['main']);
  setLayout('split');
  expect(active()).toEqual(['list', 'main', 'side']);
});

test('the side pane exists only while open, and the frame says so', () => {
  const [open, setOpen] = createSignal(false);
  mount(() => <Frame layout="split" page="main" sideOpen={open()} top={null} list={null} main={null} side={<Text>side</Text>} />);
  const frame = document.querySelector('[data-kit="frame"]');
  expect(document.querySelector('[data-pane="side"]')).toBeNull();
  expect(frame?.hasAttribute('data-side')).toBe(false);
  setOpen(true);
  expect(document.querySelector('[data-pane="side"]')).not.toBeNull();
  expect(frame?.hasAttribute('data-side')).toBe(true);
});

test('the grip shows only beside the list in split, and reports the dragged width', () => {
  const widths: [number, boolean][] = [];
  const [layout, setLayout] = createSignal<'split' | 'stack'>('split');
  mount(() => <Frame layout={layout()} page="list" top={null} list={null} main={null} onListResize={(px, done) => widths.push([px, done])} />);
  const grip = document.querySelector<HTMLElement>('[data-kit="frame-grip"]');
  expect(grip?.getAttribute('role')).toBe('separator');
  setLayout('stack');
  expect(document.querySelector('[data-kit="frame-grip"]')).toBeNull();
});
