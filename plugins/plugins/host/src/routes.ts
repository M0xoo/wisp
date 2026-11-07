// HTTP, as thin adapters over the commands. /api/plugins* are the new names; every v1 /api/spells*
// route still answers with the same request and response, plus a `Deprecation` header and a `Link`
// to its successor, for two releases (plan §6.0.4 step 1). v1's /api/open stays as it was.

import { COMMANDS } from '@wisp-plugin/plugins-api';
import type { HttpRequestContext, HttpResult, HttpService } from '@wisp/kernel';
import { messageOf, statusOf } from './errors.ts';

type Run = (cmd: string, args: unknown, req: HttpRequestContext) => Promise<unknown>;
type Handler = (req: HttpRequestContext) => Promise<HttpResult>;
type Shape = (req: HttpRequestContext) => Promise<unknown> | unknown;

const asObj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const p = (req: HttpRequestContext, k: string): string => req.params[k] ?? '';

/** v1 answered every failure as `{ error }` with its status. */
export function answer(fn: (req: HttpRequestContext) => Promise<{ status: number; json: unknown }>, headers?: (req: HttpRequestContext) => Record<string, string>): Handler {
  return async (req) => {
    const h = headers?.(req);
    try {
      const r = await fn(req);
      return h ? { ...r, headers: h } : r;
    } catch (err) {
      const r = { status: statusOf(err), json: { error: messageOf(err) } };
      return h ? { ...r, headers: h } : r;
    }
  };
}

const deprecated = (successor: (req: HttpRequestContext) => string) => (req: HttpRequestContext): Record<string, string> => ({ deprecation: 'true', link: `<${successor(req)}>; rel="successor-version"` });

interface Route {
  method: string;
  /** under /api, without it */
  path: string;
  permission: string;
  summary: string;
  /** what the command gets */
  args: Shape;
  cmd: string;
  /** 201 for a new install, as v1 */
  status?: (out: unknown) => number;
}

const body = async (req: HttpRequestContext): Promise<Record<string, unknown>> => asObj(await req.body());
const installed = (out: unknown): number => (asObj(out)['updated'] ? 200 : 201);

/** The routes both families share, by their tail after /spells or /plugins. */
function family(base: '/spells' | '/plugins', idOf: (req: HttpRequestContext) => string): Route[] {
  const what = base === '/spells' ? 'spell' : 'plugin';
  return [
    { method: 'GET', path: base, permission: 'plugins:read', summary: `Every ${what}: on or off, where it came from, what it does`, cmd: COMMANDS.list, args: () => ({}) },
    { method: 'POST', path: `${base}/check`, permission: 'plugins:read', summary: `Check a ${what} without installing it: what it does, how risky, its problems`, cmd: COMMANDS.check, args: body },
    { method: 'POST', path: base, permission: 'plugins:install', summary: `Install or update a ${what} ({ spell } | { text } | { url }${base === '/plugins' ? ' | { plugin } | { dir }' : ''}); off unless enable`, cmd: COMMANDS.install, args: body, status: installed },
    { method: 'POST', path: `${base}/off`, permission: 'plugins:write', summary: `Turn every ${what} off`, cmd: COMMANDS.allOff, args: () => ({}) },
    { method: 'POST', path: `${base}/try-data`, permission: 'plugins:read', summary: "Fetch a data source of a spell that isn't installed (Try it); the spell is checked first", cmd: COMMANDS.tryData, args: body },
    { method: 'GET', path: `${base}/:id`, permission: 'plugins:read', summary: `One ${what}`, cmd: COMMANDS.get, args: (req) => ({ id: idOf(req) }) },
    { method: 'PATCH', path: `${base}/:id`, permission: 'plugins:write', summary: `Turn a ${what} on or off ({ enabled })`, cmd: COMMANDS.setEnabled, args: async (req) => ({ ...(await body(req)), id: idOf(req) }) },
    { method: 'DELETE', path: `${base}/:id`, permission: 'plugins:install', summary: `Remove a ${what} (?crew=remove takes its crew members too)`, cmd: COMMANDS.remove, args: (req) => ({ id: idOf(req), crew: req.query.get('crew') === 'remove' ? 'remove' : 'keep' }) },
    { method: 'GET', path: `${base}/:id/export`, permission: 'plugins:read', summary: `The ${what} file to share`, cmd: COMMANDS.export, args: (req) => ({ id: idOf(req) }) },
    { method: 'POST', path: `${base}/:id/data/:name`, permission: 'plugins:read', summary: "A spell's data source, fetched for it (session: the card's task)", cmd: COMMANDS.data, args: async (req) => ({ ...(await body(req)), id: idOf(req), name: p(req, 'name') }) },
  ];
}

/** A v1 spell id, from /plugins/:id where it may be its plugin id (`user.<spell>`). */
const spellOrPlugin = (req: HttpRequestContext): string => p(req, 'id');

/** The successor of a v1 path: the same tail under /api/plugins, a spell named by its plugin id. */
function successor(path: string): (req: HttpRequestContext) => string {
  return (req) => `/api${path.replace(/^\/spells/, '/plugins').replace(':id', `user.${p(req, 'id')}`).replace(':name', p(req, 'name'))}`;
}

export const ROUTES_NEW: readonly Route[] = [
  ...family('/plugins', spellOrPlugin),
  { method: 'POST', path: '/plugins/make', permission: 'plugins:make', summary: 'Start a Make a plugin task ({ prompt, agent?, model?, effort? })', cmd: COMMANDS.make, args: body },
];
export const ROUTES_V1: readonly Route[] = [
  ...family('/spells', (req) => p(req, 'id')),
];
export const ROUTE_OPEN: Route = { method: 'POST', path: '/open', permission: 'plugins:open', summary: 'Open http(s) links in the default browser (at most 20)', cmd: COMMANDS.open, args: body };

export function registerRoutes(http: Pick<HttpService, 'route'>, run: Run): void {
  const one = (r: Route, headers?: (req: HttpRequestContext) => Record<string, string>): void => {
    const handler = answer(async (req) => {
      const out = await run(r.cmd, await r.args(req), req);
      return { status: r.status?.(out) ?? 200, json: out };
    }, headers);
    http.route(r.method, r.path, handler, { permission: r.permission, summary: r.summary });
  };
  for (const r of ROUTES_NEW) one(r);
  for (const r of ROUTES_V1) one(r, deprecated(successor(r.path)));
  one(ROUTE_OPEN);
}
