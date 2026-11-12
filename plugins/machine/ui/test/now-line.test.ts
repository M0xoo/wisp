// Settings → Usage → Machine load's Now line (LoadGroup.tsx nowLine, v1 settings.js paintLoad).
import { expect, test } from 'vitest';
import { nowLine } from '../src/LoadGroup.tsx';
import type { MachineLoad } from '../src/types.ts';
import en from '../src/i18n/en.json' with { type: 'json' };

const cat = en as Record<string, string>;
const t = (k: string, v?: Readonly<Record<string, string | number>>): string => {
  const n = v?.['count'];
  const key = typeof n === 'number' && cat[`${k}.${n === 1 ? 'one' : 'other'}`] ? `${k}.${n === 1 ? 'one' : 'other'}` : k;
  return (cat[key] ?? key).replace(/\{(\w+)\}/g, (_, w: string) => String(v?.[w] ?? ''));
};

const load = (o: Partial<MachineLoad>): MachineLoad => ({ at: 1, mem_free_pct: 71.2, cpu: 49.6, runs: 0, held: null, limits: { floor: 15 }, paused_until: 0, left_behind: 0, ...o });

test('the now line reads memory, cpu and runs as v1 did, with the runs cap when one is set_v1_paint_load', () => {
  expect(nowLine(load({}), t as never)).toBe('71% memory free · CPU at 50% of its cores · 0 runs going');
  expect(nowLine(load({ runs: 1, limits: { floor: 15, maxRuns: 4 } }), t as never)).toBe('71% memory free · CPU at 50% of its cores · 1 run of 4 going');
  // a row written before the cpu column, or a platform that can't read it: the part is left out
  expect(nowLine(load({ cpu: null, mem_free_pct: null, runs: 2 }), t as never)).toBe('2 runs going');
  const { cpu: _, ...old } = load({});
  expect(nowLine(old, t as never)).toBe('71% memory free · 0 runs going');
  // held: the reason after the reading
  expect(nowLine(load({ held: { kind: 'memory', why: 'Free memory is under 15%' } }), t as never)).toBe('71% memory free · CPU at 50% of its cores · 0 runs going. Free memory is under 15%');
  expect(nowLine(undefined, t as never)).toBe('Reading…');
});
