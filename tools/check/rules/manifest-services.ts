// Part of the manifests rule: every method of a service contract maps to a permission (plan §6.11.1,
// ADR-0008). Read statically from plugins/*/api: `defineService<T>({ permissions })`,
// `const x: ServiceRef<T> = { permissions }` and `{ … } satisfies ServiceRef<T>`.

import ts from 'typescript';
import { finding } from '../core/report.ts';
import { isCode, isTest, lineOf, objectProp, propName, stringProp, unwrap, visit } from '../core/source.ts';
import type { Ctx, Finding, Pkg } from '../core/types.ts';

const ID = 'manifests';

interface ServiceSite {
  file: string;
  line: number;
  typeName: string;
  id: string | undefined;
  perms: ts.Expression | undefined;
}

function refType(t: ts.TypeNode | undefined): string | undefined {
  if (!t || !ts.isTypeReferenceNode(t) || t.typeName.getText() !== 'ServiceRef') return undefined;
  const arg = t.typeArguments?.[0];
  return arg && ts.isTypeReferenceNode(arg) ? arg.typeName.getText() : undefined;
}

function sites(ctx: Ctx, file: string): ServiceSite[] {
  const sf = ctx.source(file);
  const out: ServiceSite[] = [];
  const fromObject = (typeName: string | undefined, e: ts.Expression | undefined, at: ts.Node): void => {
    const obj = e ? unwrap(e) : undefined;
    if (typeName && obj && ts.isObjectLiteralExpression(obj)) out.push({ file, line: lineOf(sf, at), typeName, id: stringProp(obj, 'id'), perms: objectProp(obj, 'permissions') });
  };
  visit(sf, (n) => {
    if (ts.isVariableDeclaration(n)) fromObject(refType(n.type), n.initializer, n);
    else if (ts.isSatisfiesExpression(n)) fromObject(refType(n.type), n.expression, n);
    else if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'defineService') {
      const t = n.typeArguments?.[0];
      const typeName = t && ts.isTypeReferenceNode(t) ? t.typeName.getText() : undefined;
      const [first, , third] = n.arguments;
      // defineService<T>(id, major, permissions, readOnly?), or one object
      if (first && ts.isObjectLiteralExpression(unwrap(first))) fromObject(typeName, first, n);
      else if (typeName) out.push({ file, line: lineOf(sf, n), typeName, id: first && ts.isStringLiteralLike(first) ? first.text : undefined, perms: third });
    }
  });
  return out;
}

interface Methods {
  names: string[];
  /** false when it extends a type from another package: extra permissions can't be judged */
  complete: boolean;
}

/** Callable members of an interface or object type alias declared in the package, with what it extends. */
function methodsOf(ctx: Ctx, pkg: Pkg, name: string, seen = new Set<string>()): Methods | undefined {
  if (seen.has(name)) return { names: [], complete: true };
  seen.add(name);
  for (const file of ctx.files.filter((f) => f.startsWith(`${pkg.dir}/`) && isCode(f) && !isTest(f))) {
    for (const st of ctx.source(file).statements) {
      let members: ts.NodeArray<ts.TypeElement> | undefined;
      let heritage: string[] = [];
      if (ts.isInterfaceDeclaration(st) && st.name.text === name) {
        members = st.members;
        heritage = (st.heritageClauses ?? []).flatMap((h) => h.types.map((t) => t.expression.getText()));
      } else if (ts.isTypeAliasDeclaration(st) && st.name.text === name && ts.isTypeLiteralNode(st.type)) members = st.type.members;
      if (!members) continue;
      const names = members.flatMap((m) => {
        const callable = ts.isMethodSignature(m) || (ts.isPropertySignature(m) && m.type !== undefined && ts.isFunctionTypeNode(m.type));
        const key = m.name ? propName(m.name) : undefined;
        return callable && key ? [key] : [];
      });
      let complete = true;
      for (const h of heritage) {
        const inherited = methodsOf(ctx, pkg, h, seen);
        if (inherited) names.push(...inherited.names);
        complete &&= inherited?.complete ?? false;
      }
      return { names: [...new Set(names)], complete };
    }
  }
  return undefined;
}

export function serviceFindings(ctx: Ctx): Finding[] {
  const out: Finding[] = [];
  for (const pkg of ctx.pkgs.filter((p) => p.kind === 'plugin-api')) {
    for (const file of ctx.files.filter((f) => f.startsWith(`${pkg.dir}/`) && isCode(f) && !isTest(f))) {
      for (const s of sites(ctx, file)) {
        const id = s.id ?? s.typeName;
        const perms = s.perms ? unwrap(s.perms) : undefined;
        if (!perms || !ts.isObjectLiteralExpression(perms)) {
          out.push(finding(s.file, s.line, ID, `service ${id}: permissions must be an object literal mapping each method to a permission`));
          continue;
        }
        const mapped = new Map<string, ts.Expression>();
        for (const p of perms.properties) {
          const k = ts.isPropertyAssignment(p) ? propName(p.name) : undefined;
          if (k && ts.isPropertyAssignment(p)) mapped.set(k, p.initializer);
        }
        const methods = methodsOf(ctx, pkg, s.typeName);
        if (!methods) {
          out.push(finding(s.file, s.line, ID, `service ${id}: can't find ${s.typeName} in ${pkg.name} to check its methods`, 'warn'));
          continue;
        }
        for (const m of methods.names) {
          const v = mapped.get(m);
          if (!v) out.push(finding(s.file, s.line, ID, `service ${id}: method ${m} maps to no permission`));
          else if (!ts.isStringLiteralLike(v) || !v.text) out.push(finding(s.file, s.line, ID, `service ${id}: method ${m} needs a literal permission string`));
        }
        for (const k of mapped.keys()) if (methods.complete && !methods.names.includes(k)) out.push(finding(s.file, s.line, ID, `service ${id}: permission for ${k}, which ${s.typeName} doesn't have`, 'warn'));
      }
    }
  }
  return out;
}
