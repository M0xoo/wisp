// Permissions (plan §6.5): `ns:action{k:v,…}`. `proc:spawn{bin:claude}`, `git:worktree.add`,
// `topic:read{topic:session:*}`, `*`. A grant covers a request when its namespace and action match
// (globs allowed) and every scope key the grant names is present in the request with a matching value.
// A grant without a scope covers every scope; a request without a scope is not covered by a scoped grant.

export interface Permission {
  ns: string;
  action: string;
  scope: Readonly<Record<string, string>>;
}

const NS = /^(\*|[a-z][a-z0-9-]*)$/;
const ACTION = /^[A-Za-z0-9*_-]+(\.[A-Za-z0-9*_-]+)*$/;
const KEY = /^[a-z][A-Za-z0-9_-]*$/;
const VALUE = /^[^,{}\s][^,{}]*$/;

/** Why `s` isn't a permission, or undefined when it is one. */
export function permissionProblem(s: string): string | undefined {
  if (s === '*') return undefined;
  const brace = s.indexOf('{');
  const head = brace < 0 ? s : s.slice(0, brace);
  const colon = head.indexOf(':');
  if (colon < 0) return `"${s}" is not ns:action{k:v,…} (no ':')`;
  const ns = head.slice(0, colon);
  const action = head.slice(colon + 1);
  if (!NS.test(ns)) return `"${ns}" is not a namespace (lowercase letters, digits, dashes)`;
  if (!ACTION.test(action)) return `"${action}" is not an action (letters, digits, dots, *)`;
  if (brace < 0) return undefined;
  if (!s.endsWith('}')) return `"${s}": the scope must end with '}'`;
  const body = s.slice(brace + 1, -1);
  if (!body.trim()) return `"${s}": an empty scope; leave out {} instead`;
  const seen = new Set<string>();
  for (const pair of body.split(',')) {
    const at = pair.indexOf(':');
    const k = pair.slice(0, at).trim();
    const v = pair.slice(at + 1).trim();
    if (at < 0 || !KEY.test(k)) return `"${pair.trim()}" is not k:v in "${s}"`;
    if (!VALUE.test(v)) return `"${k}" has no value in "${s}"`;
    if (seen.has(k)) return `"${k}" appears twice in "${s}"`;
    seen.add(k);
  }
  return undefined;
}

export function parsePermission(s: string): Permission | undefined {
  if (permissionProblem(s) !== undefined) return undefined;
  if (s === '*') return { ns: '*', action: '*', scope: {} };
  const brace = s.indexOf('{');
  const head = brace < 0 ? s : s.slice(0, brace);
  const colon = head.indexOf(':');
  const scope: Record<string, string> = {};
  if (brace >= 0)
    for (const pair of s.slice(brace + 1, -1).split(',')) {
      const at = pair.indexOf(':');
      scope[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
    }
  return { ns: head.slice(0, colon), action: head.slice(colon + 1), scope };
}

export function formatPermission(p: Permission): string {
  const keys = Object.keys(p.scope);
  if (p.ns === '*' && p.action === '*' && !keys.length) return '*';
  return `${p.ns}:${p.action}${keys.length ? `{${keys.map((k) => `${k}:${p.scope[k]}`).join(',')}}` : ''}`;
}

const globCache = new Map<string, RegExp>();
/** `*` matches any run of characters; everything else is literal. */
export function glob(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return pattern === value;
  let re = globCache.get(pattern);
  if (!re) {
    re = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    globCache.set(pattern, re);
  }
  return re.test(value);
}

/** Does `grant` cover `request`? Both are permission strings; one that doesn't parse covers nothing. */
export function covers(grant: string | Permission, request: string | Permission): boolean {
  const g = typeof grant === 'string' ? parsePermission(grant) : grant;
  const r = typeof request === 'string' ? parsePermission(request) : request;
  if (!g || !r) return false;
  if (!glob(g.ns, r.ns) || !glob(g.action, r.action)) return false;
  for (const [k, gv] of Object.entries(g.scope)) {
    const rv = r.scope[k];
    if (rv === undefined || !glob(gv, rv)) return false;
  }
  return true;
}
