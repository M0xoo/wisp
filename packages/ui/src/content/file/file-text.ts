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

/** The text's metrics, as the editor lays it out: where its first character starts and how big one is (monospace). */
export interface TextBox {
  readonly padTop: number;
  readonly padLeft: number;
  readonly lineHeight: number;
  readonly charWidth: number;
}

/** The line and column (1-based) under a point inside the text box, or undefined off a name (v1 editor.js hoverOn:
 *  only a word character asks the language server). */
export function nameCellAt(text: string, x: number, y: number, m: TextBox, tabSize = 2): { readonly line: number; readonly col: number } | undefined {
  if (m.lineHeight <= 0 || m.charWidth <= 0 || x < m.padLeft) return undefined;
  const line = Math.floor((y - m.padTop) / m.lineHeight) + 1;
  const cell = Math.floor((x - m.padLeft) / m.charWidth); // 0-based, on screen
  const l = text.split('\n')[line - 1];
  if (line < 1 || !l) return undefined;
  // a tab takes the cells up to its next stop (the editor's tab-size): the screen cell back to the character
  let at = 0;
  let i = 0;
  for (; i < l.length; i++) {
    const w = l[i] === '\t' ? tabSize - (at % tabSize) : 1;
    if (cell < at + w) break;
    at += w;
  }
  if (i >= l.length || !/[\w$]/.test(l[i] ?? '')) return undefined;
  return { line, col: i + 1 };
}

/** A hover's words as the tip shows them: the server's markdown fences dropped (v1 editor.js), '' for nothing. */
export function hoverWords(raw: string | undefined): string {
  return (raw ?? '').replace(/^```\w*\n?|\n?```$/gm, '').trim();
}
