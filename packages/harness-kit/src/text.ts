// Small text helpers every harness parser uses (v1 server/util.js clip, adapters/common.js flatten).

/** One line, at most n characters (whitespace collapsed). */
export function clip(s: unknown, n = 80): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** A tool result's content (a string, or a list of `{text}` parts) as one string. */
export function flatten(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c: unknown) => (isRecord(c) && typeof c['text'] === 'string' ? c['text'] : '')).join('\n');
  return '';
}

export const lower = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `v` as a record, or an empty one: parsers read untrusted CLI JSON field by field. */
export const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});
export const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
