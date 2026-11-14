// RETIRED (ADR-0019): not in RULES. It read routes from v1's apps/server, which v2 deleted, so it checked
// nothing. The Rust edge builds /api/openapi.json from its route table (crates/wisp-api/src/openapi.rs);
// crates/wisp/tests/serve_task.rs checks every documented route there has a summary. Kept for its tests.
// ARCHITECTURE.md rule 7 (plan §9.2 contract tests): every HTTP route apps/server registers has an
// OpenAPI entry. Routes are read statically from apps/server/src, in any of the shapes a registry is
// likely to take:
//   route('GET', '/api/x', h, { summary })       a call named route/addRoute/defineRoute, or `routes.add(owner,
//   routes.add('wisp.x', 'GET', '/api/x', h, o)  'GET', '/x', …)`: the first method + path string pair
//   router.get('/api/x', h)                      get/post/put/patch/delete/head/options on a router-ish name
//   { method: 'GET', path: '/api/x', … }         an entry of a route table
// A route is documented when its options (or table entry) carry a `summary`/`description`/`openapi`
// (the server generates /api/openapi.json from them), or when apps/server/openapi.json (or
// src/openapi.json) lists it. `doc: false` hides a route on purpose: a warning, so it stays visible.
// `:id` and `{id}` are the same parameter. Until apps/server registers a route, the rule warns once.

import ts from 'typescript';
import { finding } from '../core/report.ts';
import { isCode, isTest, lineOf, objectProp, stringProp, visit } from '../core/source.ts';
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
  doc: 'inline' | 'hidden' | undefined;
}

const DOC_KEYS = ['summary', 'description', 'openapi'];

function docOf(obj: ts.ObjectLiteralExpression | undefined): Route['doc'] {
  if (!obj) return undefined;
  if (DOC_KEYS.some((k) => objectProp(obj, k) !== undefined)) return 'inline';
  return objectProp(obj, 'doc')?.kind === ts.SyntaxKind.FalseKeyword ? 'hidden' : undefined;
}

/** The first (method, path) pair of string arguments, and the first object literal after it. */
function callRoute(args: readonly ts.Expression[]): { method: string; path: string; opts: ts.ObjectLiteralExpression | undefined } | undefined {
  for (let i = 0; i + 1 < args.length; i++) {
    const m = lit(args[i]);
    const p = lit(args[i + 1]);
    if (m && p?.startsWith('/') && (VERBS.has(m.toLowerCase()) || m === '*')) {
      const opts = args.slice(i + 2).find((a): a is ts.ObjectLiteralExpression => ts.isObjectLiteralExpression(a));
      return { method: m, path: p, opts };
    }
  }
  return undefined;
}

export function normalizePath(p: string): string {
  return p.replace(/:([A-Za-z_]\w*)/g, '{$1}').replace(/\{[^}]+\}/g, '{}').replace(/\/+$/, '') || '/';
}

function lit(e: ts.Expression | undefined): string | undefined {
  return e && ts.isStringLiteralLike(e) ? e.text : undefined;
}

export function routesIn(sf: ts.SourceFile, file: string): Route[] {
  const out: Route[] = [];
  const add = (method: string | undefined, path: string | undefined, at: ts.Node, doc: Route['doc']): void => {
    if (method && path?.startsWith('/') && (VERBS.has(method.toLowerCase()) || method === '*')) out.push({ method: method.toLowerCase(), path, file, line: lineOf(sf, at), doc });
  };
  visit(sf, (n) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
      const routerish = ts.isPropertyAccessExpression(callee) && ROUTERISH.test(callee.expression.getText(sf));
      const r = ROUTE_FNS.has(name) || (name === 'add' && routerish) ? callRoute(n.arguments) : undefined;
      if (r) add(r.method, r.path, n, docOf(r.opts));
      else if (routerish && VERBS.has(name)) {
        const opts = n.arguments.find((a): a is ts.ObjectLiteralExpression => ts.isObjectLiteralExpression(a));
        add(name, lit(n.arguments[0]), n, docOf(opts));
      }
    }
    if (ts.isObjectLiteralExpression(n)) add(stringProp(n, 'method'), stringProp(n, 'path'), n, docOf(n));
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
      if (r.doc === 'inline') continue;
      if (r.doc === 'hidden') {
        out.push(finding(r.file, r.line, ID, `${r.method.toUpperCase()} ${r.path} is hidden from OpenAPI (doc: false)`, 'warn'));
        continue;
      }
      const key = `${r.method} ${normalizePath(r.path)}`;
      const ok = doc && (r.method === '*' ? [...VERBS].some((v) => doc?.ops.has(`${v} ${normalizePath(r.path)}`)) : doc.ops.has(key));
      if (!ok) out.push(finding(r.file, r.line, ID, `${r.method.toUpperCase()} ${r.path} has no OpenAPI entry${doc ? ` in ${doc.file}` : ` (no ${DOCS[0] ?? 'document'})`}`));
    }
    return out;
  },
};
