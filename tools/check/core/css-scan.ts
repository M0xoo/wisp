// A small CSS scanner: enough to find selectors, at-rule preludes and declarations with their lines.
// Not a parser; the kit's CSS is plain and Lightning CSS validates it at build time.

export interface CssPrelude {
  text: string;
  line: number;
  at: boolean; // '@media …', '@layer …'
}
export interface CssDecl {
  prop: string;
  value: string;
  line: number;
  /** the preludes it sits in, outermost first: ['@layer reset', '[hidden]'] */
  within: string[];
}

/** Comments become spaces (newlines kept) so lines stay right. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

export function scanCss(input: string): { preludes: CssPrelude[]; decls: CssDecl[] } {
  const css = stripComments(input);
  const preludes: CssPrelude[] = [];
  const decls: CssDecl[] = [];
  let line = 1;
  let start = 0;
  let startLine = 1;
  let depth = 0; // parentheses
  let quote: string | undefined;
  const stack: string[] = [];
  const flush = (end: number, kind: 'prelude' | 'decl'): void => {
    const raw = css.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trim();
    const at = startLine + (raw.slice(0, lead).match(/\n/g)?.length ?? 0);
    if (text) {
      if (kind === 'prelude') preludes.push({ text, line: at, at: text.startsWith('@') });
      else {
        const colon = text.indexOf(':');
        if (colon > 0 && !text.startsWith('@')) decls.push({ prop: text.slice(0, colon).trim(), value: text.slice(colon + 1).trim(), line: at, within: [...stack] });
      }
    }
    if (kind === 'prelude') stack.push(text);
  };
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '\n') line++;
    if (quote) {
      if (ch === '\\') {
        if (css[i + 1] === '\n') line++;
        i++;
      }
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (ch === '{' || ch === ';' || ch === '}')) {
      flush(i, ch === '{' ? 'prelude' : 'decl');
      if (ch === '}') stack.pop();
      start = i + 1;
      startLine = line;
    }
  }
  flush(css.length, 'decl');
  return { preludes, decls };
}

/** Splits on commas outside parentheses and brackets. */
export function splitTop(s: string, sep = ','): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === sep && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
