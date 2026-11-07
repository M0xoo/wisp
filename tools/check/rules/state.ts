// ARCHITECTURE.md rule 5 (plan §4.6.8, ADR-0006): state has one home. In ui packages (packages/ui,
// plugins/*/ui, apps/web): no module-level let/var, no fetch outside @wisp/client, no history/location
// outside navigation (packages/client/src/nav*), no bare setTimeout/setInterval outside a scope helper
// (a file named *scope*), so every timer is cleared when its scope is disposed.

import ts from 'typescript';
import { finding } from '../core/report.ts';
import { declaredNames, globalRef, isShipped, lineOf, visit } from '../core/source.ts';
import type { Ctx, Finding, Rule } from '../core/types.ts';

const ID = 'state';
const FETCH = new Set(['fetch']);
const NAV = new Set(['history', 'location']);
const TIMERS = new Set(['setTimeout', 'setInterval']);

function exempt(file: string): { fetch: boolean; nav: boolean; timers: boolean } {
  const base = file.split('/').pop() ?? '';
  return {
    fetch: file.startsWith('packages/client/'),
    nav: /^packages\/client\/src\/nav/.test(file),
    timers: /scope/i.test(base),
  };
}

function checkFile(ctx: Ctx, file: string): Finding[] {
  const out: Finding[] = [];
  const sf = ctx.source(file);
  const skip = exempt(file);
  const shadowed = declaredNames(sf);
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st) && !(st.declarationList.flags & ts.NodeFlags.Const)) {
      out.push(finding(file, lineOf(sf, st), ID, 'module-level let: server data goes in the entity store, the rest in a signal'));
    }
  }
  visit(sf, (n) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (!skip.fetch && globalRef(callee, FETCH, shadowed)) out.push(finding(file, lineOf(sf, n), ID, 'fetch outside @wisp/client: read through the client store, write through commands'));
      const timer = skip.timers ? undefined : globalRef(callee, TIMERS, shadowed);
      if (timer) out.push(finding(file, lineOf(sf, n), ID, `bare ${timer}: use the scope's timeout()/interval() so dispose clears it`));
    }
    // `location.href` and `window.location.href`: the object of a property access is the global
    if (!skip.nav && (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) && ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n) {
      const ref = globalRef(n, NAV, shadowed);
      if (ref) out.push(finding(file, lineOf(sf, n), ID, `${ref}. outside navigation: use navigate(intent)`));
    }
  });
  return out;
}

export const state: Rule = {
  id: ID,
  description: 'ui packages: no module-level let, fetch, history/location or bare timers',
  run(ctx) {
    const out: Finding[] = [];
    for (const file of ctx.files) {
      const pkg = ctx.pkgOf(file);
      if (!pkg?.ui || !isShipped(file, pkg.dir)) continue;
      out.push(...checkFile(ctx, file));
    }
    return out;
  },
};
