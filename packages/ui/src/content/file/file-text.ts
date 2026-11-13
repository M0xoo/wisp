// What FileView reads off its text (a path's language, the line and the name at an offset): plain, so their
// tests needn't compile the component.

/** The language for a file name's extension (`a/b.test.ts` → `ts`). */
export function langOfPath(path: string): string | undefined {
  const name = path.split('/').pop() ?? '';
  if (/^(Dockerfile|Makefile)$/i.test(name)) return name.toLowerCase();
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : undefined;
}

/** The line (1-based) an offset in `text` is on. */
export function lineAt(text: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < Math.min(offset, text.length); i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** The name around an offset (letters, digits, _ and $), or undefined. */
export function nameAt(text: string, offset: number): string | undefined {
  const w = /[A-Za-z0-9_$]/;
  let a = offset;
  let b = offset;
  while (a > 0 && w.test(text[a - 1] ?? '')) a--;
  while (b < text.length && w.test(text[b] ?? '')) b++;
  const name = text.slice(a, b);
  return name && !/^[0-9]/.test(name) ? name : undefined;
}
