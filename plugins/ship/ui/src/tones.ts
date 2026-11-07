// A PR's tone as the kit colours it: state colours only (design/ui.md), one map for the row, the
// pill and the pane's chips.

import type { PrTone } from './model/pr.ts';

export const TONE = { fail: 'bad', pending: 'warn', pass: 'good', merged: 'accent', closed: 'neutral' } as const satisfies Record<PrTone, string>;
export const TONE_ICON = { fail: 'x', pending: 'clock', pass: 'check', merged: 'merge', closed: 'x' } as const satisfies Record<PrTone, string>;
