// AGENTS.md: no `any` (use `unknown` and narrow it), and no ts-ignore / ts-nocheck directives. tsc can't
// ban an explicit `any` without a linter, so the AST does it here. Only a real directive counts (a
// comment that starts with it, as tsc reads them), not prose that mentions one.

import ts from 'typescript';
import { finding } from '../core/report.ts';
import { commentsOf, isCode, lineOf, visit } from '../core/source.ts';
import type { Finding, Rule } from '../core/types.ts';

const ID = 'no-any';
const LINE_DIRECTIVE = /^\/\/\/?\s*@ts-(ignore|nocheck)\b/;
const BLOCK_DIRECTIVE = /^\/\*+\s*@ts-(ignore|nocheck)\b|\n\s*\*?\s*@ts-(ignore|nocheck)\b/;

export function directive(comment: string): string | undefined {
  const m = (comment.startsWith('//') ? LINE_DIRECTIVE : BLOCK_DIRECTIVE).exec(comment);
  return m ? (m[1] ?? m[2]) : undefined;
}

export const noAny: Rule = {
  id: ID,
  description: 'no explicit any, no @ts-ignore or @ts-nocheck',
  run(ctx) {
    const out: Finding[] = [];
    for (const file of ctx.files.filter(isCode)) {
      const sf = ctx.source(file);
      visit(sf, (n) => {
        if (n.kind === ts.SyntaxKind.AnyKeyword) out.push(finding(file, lineOf(sf, n), ID, 'explicit any: use unknown and narrow it'));
      });
      for (const c of commentsOf(sf)) {
        const d = directive(c.text);
        if (d) out.push(finding(file, lineOf(sf, c.pos), ID, `@ts-${d} hides a type error: fix it (or @ts-expect-error with a reason)`));
      }
    }
    return out;
  },
};
