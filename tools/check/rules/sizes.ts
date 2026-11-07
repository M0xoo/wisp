// ARCHITECTURE.md rule 8 (plan §9.2): a soft cap of 400 lines per file and 60 per function. Warnings,
// never errors; a `// size-ok: <reason>` comment at the top of the file or right above the function
// records the written reason the quality bar asks for, and silences it.

import ts from 'typescript';
import { finding } from '../core/report.ts';
import { isCode, lineOf, visit } from '../core/source.ts';
import type { Finding, Rule } from '../core/types.ts';

const ID = 'sizes';
export const MAX_FILE = 400;
export const MAX_FUNCTION = 60;
const REASON = /\/\/\s*size-ok:\s*\S/;

function fnName(n: ts.FunctionLikeDeclaration): string {
  if (n.name && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name) || ts.isPrivateIdentifier(n.name))) return n.name.text;
  if (ts.isConstructorDeclaration(n)) return 'constructor';
  const p = n.parent;
  if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) return p.name.text;
  return '(anonymous)';
}

function hasReason(text: string, node: ts.Node): boolean {
  // the comment sits before the function, or before the statement that holds it (`const f = () => …`)
  for (let n: ts.Node | undefined = node; n && !ts.isSourceFile(n); n = n.parent) {
    const lead = ts.getLeadingCommentRanges(text, n.getFullStart()) ?? [];
    if (lead.some((r) => REASON.test(text.slice(r.pos, r.end)))) return true;
    if (ts.isStatement(n) || ts.isClassElement(n) || ts.isPropertyAssignment(n)) break;
  }
  return false;
}

export const sizes: Rule = {
  id: ID,
  description: `warn on files over ${MAX_FILE} lines and functions over ${MAX_FUNCTION}`,
  run(ctx) {
    const out: Finding[] = [];
    for (const file of ctx.files.filter(isCode)) {
      const text = ctx.read(file);
      const head = text.split('\n', 10).join('\n');
      const lines = text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
      const fileOk = REASON.test(head);
      if (lines > MAX_FILE && !fileOk) out.push(finding(file, 1, ID, `${lines} lines (soft cap ${MAX_FILE}): split it, or say why with // size-ok:`, 'warn'));
      const sf = ctx.source(file);
      visit(sf, (n) => {
        if (!ts.isFunctionLike(n) || !('body' in n) || !n.body) return;
        const fn = n as ts.FunctionLikeDeclaration;
        const start = lineOf(sf, fn);
        const len = lineOf(sf, fn.end) - start + 1;
        if (len > MAX_FUNCTION && !hasReason(text, fn)) out.push(finding(file, start, ID, `${fnName(fn)} is ${len} lines (soft cap ${MAX_FUNCTION})`, 'warn'));
      });
    }
    return out;
  },
};
