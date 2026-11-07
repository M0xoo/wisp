// ARCHITECTURE.md rule 7 (plan §9.2 contract tests): every HTTP route apps/server registers has an
// OpenAPI entry. Routes are read statically from apps/server/src, in any of the shapes a registry is
// likely to take:
//   route('GET', '/api/x', h)                    a call named route/addRoute/defineRoute
//   router.get('/api/x', h)                      get/post/put/patch/delete/head/options on a router-ish name
//   { method: 'GET', path: '/api/x', … }         an entry of a route table
// The document is apps/server/openapi.json (or src/openapi.json): { paths: { '/api/x/{id}': { get } } }.
// `:id` and `{id}` are the same parameter. Until apps/server registers a route, the rule warns once.

import ts from 'typescript';
import { finding } from '../core/report.ts';
import { isCode, isTest, lineOf, stringProp, visit } from '../core/source.ts';
import { isRecord } from '../core/workspace.ts';
import type { Ctx, Finding, Rule } from '../core/types.ts';

const ID = 'openapi';
const SERVER = 'apps/server/';
export const DOCS = ['apps/server/openapi.json', 'apps/server/src/openapi.json'];
const VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const ROUTE_FNS = new Set(['route', 'addRoute', 'defineRoute']);
const ROUTERISH = /router|routes|app|http|server|api/i;

export interface Route {
  method: string;
  path: string;
  file: string;
  line: number;
}

export function normalizePath(p: string): string {
  return p.replace(/:([A-Za-z_]\w*)/g, '{$1}').replace(/\{[^}]+\}/g, '{}').replace(/\/+$/, '') || '/';
}

function lit(e: ts.Expression | undefined): string | undefined {
  return e && ts.isStringLiteralLike(e) ? e.text : undefined;
}

export function routesIn(sf: ts.SourceFile, file: string): Route[] {
  const out: Route[] = [];
  const add = (method: string | undefined, path: string | undefined, at: ts.Node): void => {
    if (method && path?.startsWith('/') && (VERBS.has(method.toLowerCase()) || method === '*')) out.push({ method: method.toLowerCase(), path, file, line: lineOf(sf, at) });
  };
  visit(sf, (n) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
      if (ROUTE_FNS.has(name)) add(lit(n.arguments[0]), lit(n.arguments[1]), n);
      else if (ts.isPropertyAccessExpression(callee) && VERBS.has(name) && ROUTERISH.test(callee.expression.getText(sf))) add(name, lit(n.arguments[0]), n);
    }
    if (ts.isObjectLiteralExpression(n)) add(stringProp(n, 'method'), stringProp(n, 'path'), n);
  });
  return out;
}

function documented(ctx: Ctx): { file: string; ops: Set<string> } | undefined {
  const file = DOCS.find((f) => ctx.exists(f));
  if (!file) return undefined;
  const doc: unknown = JSON.parse(ctx.read(file));
  const paths = isRecord(doc) && isRecord(doc['paths']) ? doc['paths'] : {};
  const ops = new Set<string>();
  for (const [p, item] of Object.entries(paths)) {
    if (!isRecord(item)) continue;
    for (const verb of Object.keys(item)) if (VERBS.has(verb)) ops.add(`${verb} ${normalizePath(p)}`);
  }
  return { file, ops };
}

export const openapi: Rule = {
  id: ID,
  description: 'every HTTP route in apps/server has an OpenAPI entry',
  run(ctx) {
    const routes = ctx.files.filter((f) => f.startsWith(SERVER) && isCode(f) && !isTest(f)).flatMap((f) => routesIn(ctx.source(f), f));
    if (!routes.length) return ctx.pkgs.some((p) => p.dir === 'apps/server') ? [finding('apps/server', 1, ID, 'no route registry in apps/server yet: OpenAPI is not checked', 'warn')] : [];
    let doc: { file: string; ops: Set<string> } | undefined;
    try {
      doc = documented(ctx);
    } catch (e) {
      return [finding(DOCS.find((f) => ctx.exists(f)) ?? DOCS[0] ?? '', 1, ID, `OpenAPI document is not JSON: ${e instanceof Error ? e.message : String(e)}`)];
    }
    const out: Finding[] = [];
    for (const r of routes) {
      const key = `${r.method} ${normalizePath(r.path)}`;
      const ok = doc && (r.method === '*' ? [...VERBS].some((v) => doc?.ops.has(`${v} ${normalizePath(r.path)}`)) : doc.ops.has(key));
      if (!ok) out.push(finding(r.file, r.line, ID, `${r.method.toUpperCase()} ${r.path} has no OpenAPI entry${doc ? ` in ${doc.file}` : ` (no ${DOCS[0] ?? 'document'})`}`));
    }
    return out;
  },
};
