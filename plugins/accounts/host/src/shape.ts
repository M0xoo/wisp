// Narrowing what other plugins hand over as data (a turn, an activity step, a command's answer):
// the harness modules (watch, disk, live limits, usage, env masking) read v1-shaped records
// field by field, and a field that isn't what they expect counts as absent.

export type Obj = Record<string, unknown>;

export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
export const obj = (v: unknown): Obj => (isObj(v) ? v : {});
export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** "2026-11-07" in local time: v1's day keys (usage.js dayKey) */
export const dayKey = (t: number): string => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** a thrown value's words, for a log line */
export const why = (err: unknown): string => (err instanceof Error ? err.message : String(err));

