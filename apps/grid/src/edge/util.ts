// Small things the edge's handlers share.

/** An error's own status, or `d` when it has none (v1's `err.status || d`). */
export function statusOr(err: unknown, d: number): number {
  const s = typeof err === 'object' && err !== null ? (err as { status?: unknown }).status : undefined;
  return typeof s === 'number' && s > 0 ? s : d;
}

/** An error's message. */
export const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A flag on an error (full, waitlisted). */
export const flag = (err: unknown, k: string): boolean => typeof err === 'object' && err !== null && !!(err as Record<string, unknown>)[k];

/** The first value of a header. */
export const header = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? '') : (v ?? ''));
