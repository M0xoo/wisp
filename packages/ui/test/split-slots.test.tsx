// Split builds each side once: its slots are getters, and reading one again (the splitter machine
// re-reads its panels on every resize) used to build a second copy, leaking the copy's portals.
import { expect, test } from 'vitest';
import { createSignal } from 'solid-js';
import { mount, tick } from './helpers.tsx';
import { Split, Text } from '../src/index.ts';

test('a side is built once, however often the split resizes or stacks', async () => {
  let built = 0;
  const Side = () => {
    built++;
    return <Text part="side.text">side</Text>;
  };
  const [size, setSize] = createSignal(30);
  const [stacked, setStacked] = createSignal(false);
  mount(() => <Split defaultSize={size()} stacked={stacked()} start={<Side />} end={<Text>end</Text>} />);
  await tick();
  const node = document.querySelector('[data-part="side.text"]');
  for (const s of [40, 50, 60]) setSize(s);
  setStacked(true);
  await tick();
  setStacked(false);
  await tick();
  expect(built).toBe(1);
  expect(document.querySelector('[data-part="side.text"]')).toBe(node);
});
