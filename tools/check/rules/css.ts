// ARCHITECTURE.md rule 4 (plan §5, ADR-0007): CSS lives in packages/ui only. Outside the kit: no .css
// files, no CSS imports, no class/className, and style= only for custom properties (`--sb-w`).
// Inside the kit: px values from the token scale, no :has() anchored on a large box, no selector
// ending in an :is()/:where() list (both match right to left over the whole subtree), no !important.
// Two uses of !important are what layered CSS needs and stay allowed: inside `@layer reset` (an
// important declaration in the lowest layer beats every layer above it: `[hidden]` must hide), and
// inside a user-preference query (prefers-reduced-motion, forced-colors), which must win everywhere.
// Anywhere else it needs a written reason: a `/* !important: <why> */` comment on the line above or
// on the same line (overriding a style a library sets inline is the usual one).
// Layout (design/layout.md §6): no flex-wrap outside Wrap, no wrapping white-space on control parts
// (css-layout.ts).

import ts from 'typescript';
import { scanCss, splitTop } from '../core/css-scan.ts';
import { layoutProblems } from './css-layout.ts';
import { finding } from '../core/report.ts';
import { isCode, lineOf, propName, visit } from '../core/source.ts';
import { pxScale, TOKENS_DIR } from '../core/tokens.ts';
import type { Ctx, Finding, Rule } from '../core/types.ts';

const ID = 'css';
const KIT = 'packages/ui/';
const STYLE_FILE = /\.(css|scss|sass|less|styl)$/;
const STYLE_IMPORT = /\.(css|scss|sass|less|styl)(\?.*)?$/;

function inKit(file: string): boolean {
  return file.startsWith(KIT);
}

function customPropsOnly(e: ts.Expression): boolean {
  if (!ts.isObjectLiteralExpression(e)) return false;
  return e.properties.every((p) => ts.isPropertyAssignment(p) && (propName(p.name)?.startsWith('--') ?? false));
}

function jsxAttrs(ctx: Ctx, file: string): Finding[] {
  const out: Finding[] = [];
  const sf = ctx.source(file);
  visit(sf, (n) => {
    if (!ts.isJsxAttribute(n)) return;
    const name = ts.isIdentifier(n.name) ? n.name.text : n.name.name.text;
    if (name === 'class' || name === 'className') out.push(finding(file, lineOf(sf, n), ID, `${name}= outside the kit: use a @wisp/ui component and its props`));
    if (name === 'style') {
      const init = n.initializer;
      const expr = init && ts.isJsxExpression(init) ? init.expression : undefined;
      if (!expr || !customPropsOnly(expr)) out.push(finding(file, lineOf(sf, n), ID, "style= may set only CSS custom properties ({ '--x': v }) outside the kit"));
    }
  });
  return out;
}

/** The simple selectors of the compound right before `:has(`: 'body.dark' → ['body', '.dark']. */
function compoundBefore(sel: string, at: number): string[] {
  let i = at;
  let depth = 0;
  while (i > 0) {
    const ch = sel[i - 1] ?? '';
    if (ch === ')' || ch === ']') depth++;
    else if (ch === '(' || ch === '[') depth--;
    else if (depth === 0 && /[\s>+~]/.test(ch)) break;
    i--;
  }
  return sel.slice(i, at).match(/^[a-z][\w-]*|\*|#[\w-]+|\.[\w-]+|\[[^\]]*\]|::?[\w-]+(\([^)]*\))?/gi) ?? [];
}

const LARGE = new Set(['*', '&', 'html', 'body', ':root', 'main', '#app', '#root', '.stage', '.app', '.shell', '.layout', '.page', '.root']);

export function hasOnLargeBox(selector: string): boolean {
  for (let at = selector.indexOf(':has('); at >= 0; at = selector.indexOf(':has(', at + 1)) {
    const parts = compoundBefore(selector, at);
    if (parts.length === 0) return true; // a bare :has() is *:has()
    if (parts.some((p) => LARGE.has(p.toLowerCase()) || /^\[data-part=["']?(shell|stage|app)\b/.test(p))) return true;
  }
  return false;
}

export function endsInIsList(selector: string): boolean {
  const s = selector.trimEnd();
  if (!s.endsWith(')')) return false;
  let depth = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i] === ')') depth++;
    else if (s[i] === '(' && --depth === 0) return /:(is|where)$/.test(s.slice(0, i));
  }
  return false;
}

export function importantAllowed(within: readonly string[]): boolean {
  return within.some((p) => /^@layer\s+reset\b/.test(p) || /^@media\b.*\((prefers-reduced-motion|forced-colors|prefers-contrast)\b/.test(p));
}

/** Lines a `/* !important: reason *\/` comment ends on. */
export function importantReasons(css: string): Set<number> {
  const lines = new Set<number>();
  for (const m of css.matchAll(/\/\*[^*]*!important:\s*\S[\s\S]*?\*\//g)) lines.add(css.slice(0, (m.index ?? 0) + m[0].length).split('\n').length);
  return lines;
}

function kitCss(ctx: Ctx, file: string, scale: Set<number> | undefined): Finding[] {
  const out: Finding[] = [];
  const text = ctx.read(file);
  const { preludes, decls } = scanCss(text);
  const reasons = importantReasons(text);
  for (const p of preludes) {
    if (p.at) continue;
    for (const sel of splitTop(p.text)) {
      if (hasOnLargeBox(sel)) out.push(finding(file, p.line, ID, `:has() anchored on a large box re-matches on every change below it: ${sel}`));
      if (endsInIsList(sel)) out.push(finding(file, p.line, ID, `selector ends in an :is()/:where() list: ${sel}`));
    }
  }
  const checkPx = (text: string, line: number): void => {
    if (!scale) return;
    for (const m of text.matchAll(/(?<![\w.#-])(-?\d*\.?\d+)px\b/g)) {
      const v = Math.abs(Number(m[1]));
      if (!scale.has(v)) out.push(finding(file, line, ID, `${m[0]} is off the token scale (${TOKENS_DIR}): use a token`));
    }
  };
  // px inside a string or url() is content (an inline SVG), not a length
  const lengths = (v: string): string => v.replace(/url\([^)]*\)/g, '').replace(/"[^"]*"|'[^']*'/g, '');
  for (const d of decls) {
    const reasoned = reasons.has(d.line) || reasons.has(d.line - 1);
    if (/!\s*important/i.test(d.value) && !importantAllowed(d.within) && !reasoned) out.push(finding(file, d.line, ID, `!important in ${d.prop}: use the cascade layers`));
    if (!d.prop.startsWith('--')) checkPx(lengths(d.value), d.line);
  }
  for (const p of preludes) if (p.at) checkPx(p.text, p.line);
  for (const p of layoutProblems(decls)) out.push(finding(file, p.line, ID, p.message));
  return out;
}

export const css: Rule = {
  id: ID,
  description: 'CSS only in packages/ui; kit CSS on the token scale, no slow selectors, no !important',
  run(ctx) {
    const out: Finding[] = [];
    const kitFiles = ctx.files.filter((f) => inKit(f) && f.endsWith('.css'));
    const scale = kitFiles.length ? pxScale(ctx.root) : undefined;
    if (kitFiles.length && !scale) out.push(finding(TOKENS_DIR, 1, ID, 'no token files yet: px values in the kit are not checked', 'warn'));
    for (const file of kitFiles) out.push(...kitCss(ctx, file, scale));
    for (const file of ctx.files) {
      if (inKit(file)) continue;
      if (STYLE_FILE.test(file)) out.push(finding(file, 1, ID, 'CSS lives in packages/ui only'));
      if (!isCode(file)) continue;
      for (const imp of ctx.imports(file)) if (STYLE_IMPORT.test(imp.spec)) out.push(finding(file, imp.line, ID, `CSS import outside the kit: ${imp.spec}`));
      if (file.endsWith('.tsx')) out.push(...jsxAttrs(ctx, file));
    }
    return out;
  },
};
