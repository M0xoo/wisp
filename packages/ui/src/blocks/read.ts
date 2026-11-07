// Reading an agent-written block: every field is untrusted, so these never throw and never return
// a type other than the one asked for. A block reads `str(b.title)`, not `b.title as string`.

/** A string field: numbers become text, anything else ''. */
export function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

/** A string field or undefined (absent, empty, or not text). */
export function opt(v: unknown): string | undefined {
  const s = str(v);
  return s === '' ? undefined : s;
}

/** A finite number, or undefined. Numeric strings ("42", "1.5") count. */
export function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

export function bool(v: unknown): boolean {
  return v === true || v === 'true';
}

/** An array field, or []. */
export function list(v: unknown): readonly unknown[] {
  return Array.isArray(v) ? v : [];
}

/** An object field, or {}. */
export function obj(v: unknown): Readonly<Record<string, unknown>> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** One of a set of words, or the fallback. */
export function oneOf<const T extends string>(v: unknown, words: readonly T[], fallback: T): T {
  return typeof v === 'string' && (words as readonly string[]).includes(v) ? (v as T) : fallback;
}

/** Items that are objects (agents sometimes write a bare string: `as` maps it). */
export function items<T>(v: unknown, as: (o: Readonly<Record<string, unknown>>) => T | undefined, fromString?: (s: string) => T | undefined): T[] {
  const out: T[] = [];
  for (const x of list(v)) {
    const got = typeof x === 'string' ? fromString?.(x) : typeof x === 'object' && x !== null && !Array.isArray(x) ? as(x as Record<string, unknown>) : undefined;
    if (got !== undefined) out.push(got);
  }
  return out;
}
