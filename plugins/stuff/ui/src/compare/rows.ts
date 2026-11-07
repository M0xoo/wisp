// Compare's table (v1 compareRows): the same rows in the same order whatever the runs hold, so
// nothing jumps while they work. Cells are data, not HTML: the view colours the +/− and ✓/✗ parts.

import { byAge, runMetrics, type T } from './metrics.ts';
import { DASH, planShares } from './plan-shares.ts';
import { pct, tokenWords } from './receipt.ts';
import type { Metrics, Run } from './types.ts';

export type RowKey = 'time' | 'cost' | 'tokens' | 'cache' | 'steps' | 'plan' | 'files' | 'tests' | 'asks';

export interface Cell {
  /** the cell as plain text: what's read out, and the whole cell when there are no parts */
  readonly text: string;
  readonly tip?: string;
  /** Files: the count, then the lines added and taken out, each coloured */
  readonly files?: { readonly n: number; readonly add: number; readonly del: number };
  /** Tests: green when none failed */
  readonly tests?: { readonly passed: number; readonly failed: number };
}

export interface Row {
  readonly key: RowKey;
  readonly label: string;
  readonly tip?: string;
  readonly cells: Cell[];
}

/** What the page's duration shows: "950ms", "40s", "1m 35s", "1h 5m". */
export function duration(t: T, ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 1) return t('stuff.compare.dur.ms', { ms });
  if (s < 60) return t('stuff.compare.dur.s', { s });
  const m = Math.floor(s / 60);
  if (m < 60) return t('stuff.compare.dur.m', { m, s: String(s % 60).padStart(2, '0') });
  return t('stuff.compare.dur.h', { h: Math.floor(m / 60), m: m % 60 });
}

const testsText = (x: { readonly passed: number; readonly failed: number }): string => `${x.passed} ✓${x.failed ? ` ${x.failed} ✗` : ''}`;

export function compareRows(t: T, sessions: readonly Run[], now = Date.now()): Row[] {
  const metrics = byAge(sessions).map(runMetrics);
  const { cells: plan } = planShares(t, sessions, now);
  const row = (key: RowKey, html: (m: Metrics, i: number) => Cell | string | null, tip?: string): Row => ({
    key,
    label: t(`stuff.compare.row.${key}`),
    ...(tip !== undefined && { tip }),
    cells: metrics.map((m, i) => {
      const c = html(m, i);
      return c === null ? { text: DASH } : typeof c === 'string' ? { text: c } : c;
    }),
  });
  const rows = [
    row('time', (m) => (m.time !== null ? duration(t, m.time) : null)),
    row('cost', (m) => (m.cost !== null ? { text: `$${m.cost.toFixed(2)}`, ...(m.costPartial && { tip: t('stuff.compare.costPartial') }) } : null)),
    row('tokens', (m) => (m.tokens ? tokenWords(m.tokens) : null)),
    row('cache', (m) => (m.cache != null ? pct(m.cache) : null)),
    row('steps', (m) => (m.steps != null ? String(m.steps) : null), t('stuff.compare.row.stepsTip')),
    row('plan', (_m, i) => {
      const p = plan[i];
      return p ? { text: p.text, ...(p.tip && { tip: p.tip }) } : null;
    }),
    row('files', (m) => {
      const f = { n: m.files ?? 0, add: m.add ?? 0, del: m.del ?? 0 };
      return { text: `${f.n} +${f.add} −${f.del}`, files: f };
    }),
    row('tests', (m) => (m.tests ? { text: testsText(m.tests), tests: m.tests } : null)),
    row('asks', (m) => String(m.asks ?? 0)),
  ];
  return rows;
}
