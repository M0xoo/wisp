// The `stats` block (v1 R.stats): a few real numbers, large, through the kit's Stats. The first
// time the answer is shown each number counts up from 0 (one after another, after the block's own
// entry); shown again it is simply the number. A value that isn't a number shows as written.
import { createMemo, type JSX } from 'solid-js';
import { Stats, type Stat } from '../composites/Stats.tsx';
import { useBlocks } from './context.tsx';
import { numberFormat, useCountUp } from './content-count.ts';
import { decimalsOf } from './content-util.ts';
import { items, num, oneOf, opt, str } from './read.ts';
import type { BlockProps } from './types.ts';

const TONES = ['good', 'bad', 'neutral'] as const;

interface StatIn {
  readonly label: string;
  readonly raw: unknown;
  readonly unit: string | undefined;
  readonly delta: string | undefined;
  readonly tone: (typeof TONES)[number];
}

export function readStats(v: unknown): StatIn[] {
  return items<StatIn>(v, (o) => ({
    label: str(o['label']),
    raw: o['value'],
    unit: opt(o['unit']),
    delta: opt(o['delta']),
    tone: oneOf(o['tone'], TONES, 'neutral'),
  }));
}

/** v1: the block's entry delay (110 ms a block, the first 10), then 250 ms, then 120 ms a number. */
const delayOf = (block: number, i: number): number => Math.min(block, 10) * 110 + 250 + i * 120;

type MutableStat = { -readonly [K in keyof Stat]: Stat[K] };

function liveStat(s: StatIn, i: number, block: number, animate: boolean): Stat {
  const n = num(s.raw);
  const format = numberFormat(decimalsOf(s.raw));
  const shown = useCountUp(() => n, { animate, delay: delayOf(block, i) });
  const stat: MutableStat = {
    label: s.label,
    tone: s.tone,
    // A getter, so the kit's Stats repaints just this number's text on each frame of the count.
    get value(): string {
      const v = shown();
      return v === undefined ? str(s.raw) : format(v);
    },
  };
  if (s.unit !== undefined) stat.unit = s.unit;
  if (s.delta !== undefined) stat.delta = s.delta;
  return stat;
}

export function StatsBlock(props: BlockProps): JSX.Element {
  const ctx = useBlocks();
  // Only the first show counts up; the block's items changing later just shows the new numbers.
  let first = ctx.reveal !== false;
  const stats = createMemo(() => {
    const animate = first;
    first = false;
    return readStats(props.block['items']).map((s, i) => liveStat(s, i, props.index, animate));
  });
  return (
    <div data-kit="cb-stats" data-part="block.stats">
      <Stats part="block.stats.list" items={stats()} />
    </div>
  );
}
