// ARCHITECTURE.md rule 1 (plan §3.1 rule 7, §6.0.3 rule 1):
//   packages/* ← plugins/*/api ← plugins/*/host, plugins/*/ui ← apps/*
// A plugin reaches another plugin through its api only. Page code (ui packages) never imports node:,
// and an api package holds contracts: no node:, no runtime libraries, no top-level side effects.
// api → another plugin's api is allowed: contracts may share row types; the cycles rule keeps it a DAG.

import ts from 'typescript';
import { finding } from '../core/report.ts';
import { isCode, isShipped } from '../core/source.ts';
import type { Ctx, Finding, Pkg, Rule } from '../core/types.ts';

const ID = 'layers';

function describe(p: Pkg): string {
  return p.kind === 'package' ? `package ${p.name}` : p.kind === 'app' ? `app ${p.name}` : `${p.plugin ?? '?'}'s ${p.kind.slice('plugin-'.length)} (${p.name})`;
}

/** Why `from` may not import `to`, or undefined when it may. */
export function layerViolation(from: Pkg, to: Pkg): string | undefined {
  if (from === to) return undefined;
  switch (from.kind) {
    case 'package':
      return to.kind === 'package' ? undefined : `packages may not import plugins or apps: ${describe(to)}`;
    case 'plugin-api':
      return to.kind === 'package' || to.kind === 'plugin-api' ? undefined : `an api package may import packages and other api packages only, not ${describe(to)}`;
    case 'plugin-host':
    case 'plugin-ui':
      if (to.kind === 'package' || to.kind === 'plugin-api') return undefined;
      if (to.kind === 'app') return `plugins may not import apps: ${describe(to)}`;
      if (to.plugin === from.plugin) return `a plugin's host and ui meet through its api, not ${describe(to)}`;
      return `import ${to.plugin ?? 'the plugin'}'s api, never its ${to.kind.slice('plugin-'.length)} (${to.name})`;
    case 'app':
      if (to.kind === 'app') return `apps don't import each other: ${describe(to)}`;
      if (from.ui && to.kind === 'plugin-host') return `page code may not import server code: ${describe(to)}`;
      return undefined;
  }
}

function apiBody(ctx: Ctx, file: string): Finding[] {
  const out: Finding[] = [];
  const sf = ctx.source(file);
  for (const st of sf.statements) {
    const line = sf.getLineAndCharacterOfPosition(st.getStart(sf)).line + 1;
    if (ts.isExpressionStatement(st)) out.push(finding(file, line, ID, 'api packages hold contracts only: no top-level side effects'));
    if (ts.isVariableStatement(st) && !(st.declarationList.flags & ts.NodeFlags.Const)) out.push(finding(file, line, ID, 'api packages hold contracts only: no module-level let/var'));
  }
  return out;
}

export const layers: Rule = {
  id: ID,
  description: 'packages ← plugin api ← plugin host/ui ← apps; ui and api code never imports node:',
  run(ctx) {
    const out: Finding[] = [];
    for (const file of ctx.files.filter(isCode)) {
      const own = ctx.pkgOf(file);
      if (!own) continue;
      const shipped = isShipped(file, own.dir);
      for (const imp of ctx.imports(file)) {
        const r = ctx.resolve(file, imp.spec);
        const to = r.kind === 'workspace' ? r.pkg : r.kind === 'relative' ? r.pkg : undefined;
        if (to) {
          const why = layerViolation(own, to);
          if (why) out.push(finding(file, imp.line, ID, why));
        }
        if (r.kind === 'node' && shipped && !imp.typeOnly) {
          if (own.ui) out.push(finding(file, imp.line, ID, `ui code runs in the page: no ${imp.spec}`));
          else if (own.kind === 'plugin-api') out.push(finding(file, imp.line, ID, `api packages hold contracts only: no ${imp.spec}`));
        }
        if (r.kind === 'external' && shipped && !imp.typeOnly && own.kind === 'plugin-api') {
          out.push(finding(file, imp.line, ID, `api packages hold contracts only: no runtime import of ${r.name} (use import type)`));
        }
      }
      if (own.kind === 'plugin-api' && shipped) out.push(...apiBody(ctx, file));
    }
    return out;
  },
};
