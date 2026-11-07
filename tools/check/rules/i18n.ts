// Plan §5.1: every user-facing string goes through t('key'). In .tsx under plugins/*/ui and apps/web,
// JSX text and string-valued text attributes are flagged. A warning for now (the brief: "warning
// first"); it becomes an error once the shell has its catalogues.

import ts from 'typescript';
import { finding } from '../core/report.ts';
import { isTest, lineOf, visit } from '../core/source.ts';
import type { Finding, Rule } from '../core/types.ts';

const ID = 'i18n';
const TEXT_ATTRS = new Set(['title', 'placeholder', 'alt', 'label', 'aria-label', 'aria-description', 'aria-placeholder']);
const WORDS = /\p{L}{2,}/u;

function inScope(file: string): boolean {
  return file.endsWith('.tsx') && !isTest(file) && (/^plugins\/[^/]+\/ui\//.test(file) || file.startsWith('apps/web/'));
}

function quote(s: string): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length > 40 ? `${t.slice(0, 37)}…` : t;
}

export const i18n: Rule = {
  id: ID,
  description: "JSX text in plugin ui and apps/web goes through t('key')",
  run(ctx) {
    const out: Finding[] = [];
    for (const file of ctx.files.filter(inScope)) {
      const sf = ctx.source(file);
      visit(sf, (n) => {
        if (ts.isJsxText(n) && WORDS.test(n.text)) {
          out.push(finding(file, lineOf(sf, n.getStart(sf) + (n.text.length - n.text.trimStart().length)), ID, `"${quote(n.text)}" in JSX: use t('key')`, 'warn'));
        }
        if (ts.isJsxAttribute(n) && n.initializer && ts.isStringLiteral(n.initializer) && WORDS.test(n.initializer.text)) {
          const name = ts.isIdentifier(n.name) ? n.name.text : `${n.name.namespace.text}:${n.name.name.text}`;
          if (TEXT_ATTRS.has(name)) out.push(finding(file, lineOf(sf, n), ID, `${name}="${quote(n.initializer.text)}": use t('key')`, 'warn'));
        }
      });
    }
    return out;
  },
};
