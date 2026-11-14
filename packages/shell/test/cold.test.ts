import { expect, test } from 'vitest';
import { about, coldHint, compactItem, type ColdOut } from '../src/frame/cold.ts';
import { SHELL_STRINGS as en } from '../src/i18n/en.ts';

const t = (k: string, v?: Readonly<Record<string, string | number>>): string => ((en as Record<string, string>)[k] ?? k).replace(/\{(\w+)\}/g, (_, x: string) => String(v?.[x] ?? ''));

test('a_large_idle_tasks_cold_cache_and_compact_now_say_what_v1_said_and_when', () => {
  expect([about(483_214), about(1_234_000), about(96_000)]).toEqual(['480k', '1.2M', '100k']);
  const warm: ColdOut = { cache: { tokens: 483_214, ttlMs: 3_600_000, coldAt: 10_000, cold: false }, compact: { tokens: 483_214, compact: 0.41, cold: 3.87, until: 9_000 } };
  // warm: no line; Compact now with both prices
  expect(coldHint(warm, 5_000, t)).toBeUndefined();
  expect(compactItem(warm, 5_000, t)?.note).toBe('About $0.41 now, $3.87 once the cache is cold');
  // the clock passes coldAt before the peer says so: the line shows, the offer is gone (a dead cache costs what it saves)
  expect(coldHint(warm, 10_000, t)?.long).toBe('Cache gone cold: this reply re-reads about 480k');
  expect(coldHint(warm, 10_000, t)?.short).toBe('Cache cold: re-reads about 480k');
  expect(compactItem(warm, 9_000, t)).toBeUndefined();
  // a model with no price: the size alone
  expect(compactItem({ cache: null, compact: { tokens: 250_000, compact: null, cold: null, until: 9_000 } }, 1, t)?.note).toBe('About 250k tokens');
  expect(coldHint(undefined, 1, t)).toBeUndefined();
});
