// Claude's rate_limit_event.rate_limit_info → { windows, complete?, rejected?, overage? } or null
// (v1 server/budget.js claudeLimits): how much of the account's 5-hour and weekly windows is gone.
// { status, rateLimitType, utilization, resetsAt (s), unifiedWindows: { five_hour: { utilization, resetsAt } },
//   isUsingOverage, overageStatus }. overage: this run is billed as extra usage, past the plan.
// rateLimitType "overage" is the extra-usage allowance, not a plan window: never a row.

import { num, rec } from '@wisp/harness-kit';

const H = 3600_000;
/** How long each window is when the CLI doesn't say (v1 budget.js WINDOWS). */
const WINDOW_MS: Readonly<Record<string, number>> = { five_hour: 5 * H, seven_day: 7 * 24 * H, seven_day_opus: 7 * 24 * H, seven_day_sonnet: 7 * 24 * H };

export interface LimitWindow {
  id: string;
  used: number;
  resetsAt: number | null;
  ms: number | null;
}
export interface ClaudeLimits {
  windows: LimitWindow[];
  complete?: true;
  rejected?: string;
  overage?: true;
}

const clamp = (n: number): number => Math.min(1, Math.max(0, n));
/** seconds or ms */
const toMs = (s: unknown): number | null => {
  const v = num(s);
  return v !== undefined && v > 0 ? (v < 1e12 ? v * 1000 : v) : null;
};

export function claudeLimits(raw: unknown): ClaudeLimits | null {
  if (!raw || typeof raw !== 'object') return null;
  const info = rec(raw);
  const windows: LimitWindow[] = [];
  const overage = info['isUsingOverage'] === true;
  const add = (id: unknown, w: Record<string, unknown>, used: unknown = w['utilization']): void => {
    const u = num(used);
    if (!id || typeof id !== 'string' || id === 'overage' || u === undefined || windows.some((x) => x.id === id)) return;
    windows.push({ id, used: clamp(u), resetsAt: toMs(w['resetsAt']), ms: WINDOW_MS[id] ?? null });
  };
  for (const [id, w] of Object.entries(rec(info['unifiedWindows']))) if (w && typeof w === 'object') add(id, rec(w));
  // Every window the plan has (window changes): an event with only rateLimitType names one.
  const complete = windows.length > 0;
  const rejected = info['status'] === 'rejected';
  // A refusal without a number is a full window.
  add(info['rateLimitType'], info, num(info['utilization']) !== undefined ? info['utilization'] : rejected ? 1 : Number.NaN);
  if (!windows.length) return overage ? { windows, overage } : null;
  return { windows, ...(complete && { complete }), ...(rejected && info['rateLimitType'] !== 'overage' && { rejected: String(info['rateLimitType'] || '') }), ...(overage && { overage }) };
}
