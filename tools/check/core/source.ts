// TypeScript AST helpers shared by the rules. Parsing only (no type checker): fast, and it works on
// files that don't typecheck yet.

import ts from 'typescript';
import type { Import } from './types.ts';

export function parse(file: string, text: string): ts.SourceFile {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : file.endsWith('.ts') || file.endsWith('.mts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
}

export function lineOf(sf: ts.SourceFile, node: ts.Node | number): number {
  const pos = typeof node === 'number' ? node : node.getStart(sf);
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

export function isCode(file: string): boolean {
  return /\.(ts|tsx|mts)$/.test(file) && !file.endsWith('.d.ts');
}

export function isTest(file: string): boolean {
  return /(^|\/)test\//.test(file) || /\.test\.tsx?$/.test(file);
}

/** Build and test configuration (vite.config.ts, vitest.config.ts): runs in Node, never shipped. */
export function isConfig(file: string): boolean {
  return /(^|\/)[\w.-]+\.config\.(ts|mts)$/.test(file);
}

/** Code that ships in the package: under its src/, not a test, not a build config (a dev gallery
 * or a script next to src/ never reaches the page). */
export function isShipped(file: string, pkgDir: string): boolean {
  return isCode(file) && file.startsWith(`${pkgDir}/src/`) && !isTest(file) && !isConfig(file);
}

export function visit(node: ts.Node, fn: (n: ts.Node) => void): void {
  fn(node);
  ts.forEachChild(node, (c) => visit(c, fn));
}

function importTypeOnly(d: ts.ImportDeclaration): boolean {
  const c = d.importClause;
  if (!c) return false; // `import 'x'` runs x
  if (c.isTypeOnly) return true;
  if (c.name) return false;
  const nb = c.namedBindings;
  return nb !== undefined && ts.isNamedImports(nb) && nb.elements.length > 0 && nb.elements.every((e) => e.isTypeOnly);
}

function exportTypeOnly(d: ts.ExportDeclaration): boolean {
  if (d.isTypeOnly) return true;
  const c = d.exportClause;
  return c !== undefined && ts.isNamedExports(c) && c.elements.length > 0 && c.elements.every((e) => e.isTypeOnly);
}

export function importsOf(sf: ts.SourceFile): Import[] {
  const out: Import[] = [];
  const add = (lit: ts.Expression | undefined, typeOnly: boolean, dynamic: boolean): void => {
    if (lit && ts.isStringLiteralLike(lit)) out.push({ spec: lit.text, line: lineOf(sf, lit), typeOnly, dynamic });
  };
  visit(sf, (n) => {
    if (ts.isImportDeclaration(n)) add(n.moduleSpecifier, importTypeOnly(n), false);
    else if (ts.isExportDeclaration(n)) add(n.moduleSpecifier, exportTypeOnly(n), false);
    else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) add(n.moduleReference.expression, n.isTypeOnly, false);
    else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument)) add(n.argument.literal, true, false);
    else if (ts.isCallExpression(n)) {
      const dyn = n.expression.kind === ts.SyntaxKind.ImportKeyword;
      const req = ts.isIdentifier(n.expression) && n.expression.text === 'require';
      if (dyn || req) add(n.arguments[0], false, dyn);
    }
  });
  return out;
}

/** Comments of the file, each once, with their position. */
export function commentsOf(sf: ts.SourceFile): { text: string; pos: number }[] {
  const seen = new Map<number, string>();
  const text = sf.getFullText();
  const take = (ranges: ts.CommentRange[] | undefined): void => {
    for (const r of ranges ?? []) seen.set(r.pos, text.slice(r.pos, r.end));
  };
  visit(sf, (n) => {
    take(ts.getLeadingCommentRanges(text, n.pos));
    take(ts.getTrailingCommentRanges(text, n.end));
  });
  return [...seen].sort((a, b) => a[0] - b[0]).map(([pos, t]) => ({ text: t, pos }));
}

/** Names declared anywhere in the file (variables, parameters, imports, functions). */
export function declaredNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  visit(sf, (n) => {
    if ((ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isFunctionDeclaration(n) || ts.isImportSpecifier(n) || ts.isImportClause(n) || ts.isNamespaceImport(n) || ts.isBindingElement(n)) && n.name && ts.isIdentifier(n.name)) {
      names.add(n.name.text);
    }
  });
  return names;
}

const GLOBALS = new Set(['window', 'globalThis', 'self', 'document']);

/** `name`, `window.name`, `globalThis.name`: a reference to the global, unless the file shadows it. */
export function globalRef(e: ts.Expression, names: ReadonlySet<string>, shadowed: ReadonlySet<string>): string | undefined {
  if (ts.isIdentifier(e)) return names.has(e.text) && !shadowed.has(e.text) ? e.text : undefined;
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && GLOBALS.has(e.expression.text) && !shadowed.has(e.expression.text)) {
    return names.has(e.name.text) ? e.name.text : undefined;
  }
  return undefined;
}

export function propName(n: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(n) || ts.isStringLiteralLike(n) || ts.isNumericLiteral(n) || ts.isPrivateIdentifier(n)) return n.text;
  if (ts.isComputedPropertyName(n) && ts.isStringLiteralLike(n.expression)) return n.expression.text;
  return undefined;
}

/** Strips `as const`, `satisfies T`, parentheses. */
export function unwrap(e: ts.Expression): ts.Expression {
  let cur = e;
  while (ts.isAsExpression(cur) || ts.isSatisfiesExpression(cur) || ts.isParenthesizedExpression(cur) || ts.isTypeAssertionExpression(cur)) cur = cur.expression;
  return cur;
}

export function objectProp(obj: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && propName(p.name) === key) return p.initializer;
  }
  return undefined;
}

export function stringProp(obj: ts.ObjectLiteralExpression, key: string): string | undefined {
  const v = objectProp(obj, key);
  return v && ts.isStringLiteralLike(v) ? v.text : undefined;
}
