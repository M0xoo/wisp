// New task's Run on (src/frame/where.ts, v1 launcher.js where-btn): this computer, then the others, one picked.
import { expect, test } from 'vitest';
import { whereItems } from '../src/frame/where.ts';

test('Run on lists this computer first and the others after, only the picked one checked_v1_run_on', () => {
  const t = (k: string): string => (k === 'shell.card.thisComputer' ? 'This computer' : k);
  const name = (p: string): string => ({ studio: 'Studio', box: 'Cloud' })[p] ?? p;
  const items = whereItems(['laptop', 'studio', 'box'], 'studio', 'laptop', name, t);
  expect(items.map((i) => [(i as { value: string }).value, (i as { label: string }).label, (i as { checked?: boolean }).checked])).toEqual([
    ['laptop', 'This computer', false],
    ['studio', 'Studio', true],
    ['box', 'Cloud', false],
  ]);
  expect(whereItems(['laptop'], 'laptop', 'laptop', name, t)).toHaveLength(1);
});
