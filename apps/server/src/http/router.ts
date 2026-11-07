// The route table behind the `http` kernel service (v1 server/http/router.js). Patterns match whole
// path segments; `:name` captures one (URI-decoded). Routes are tried in the order they were added, so a
// fixed segment (`/projects/discover`) goes before a capture (`/projects/:id`), as in v1. Routes are
// bucketed by method and segment count, so a request looks at a handful of patterns, not all 300.
import type { Disposable, HttpRequestContext, HttpResult, RouteOptions } from '@wisp/kernel';

export type Handler = (ctx: HttpRequestContext) => Promise<HttpResult> | HttpResult;

export interface RouteEntry {
  readonly method: string;
  /** the full path pattern: '/api/sessions/:id', or '/hooks/:id' for a raw route */
  readonly path: string;
  readonly segs: readonly string[];
  readonly handler: Handler;
  readonly opts: RouteOptions;
  /** the plugin that registered it ('wisp.server' for the edge's own) */
  readonly owner: string;
  readonly order: number;
}

export interface RouteInfo {
  method: string;
  path: string;
  owner: string;
  permission: string;
  doc: boolean;
  summary?: string;
}

export interface Match {
  route: RouteEntry;
  params: Record<string, string>;
}

const split = (p: string): string[] => p.split('/').filter(Boolean);

export class Routes {
  readonly #buckets = new Map<string, RouteEntry[]>();
  #order = 0;

  /** `route('GET', '/sessions/:id', …)`: under /api. Returns its removal (the plugin's scope owns it). */
  add(owner: string, method: string | readonly string[], pattern: string, handler: Handler, opts: RouteOptions, raw = false): Disposable {
    if (!pattern.startsWith('/')) throw new Error(`${owner}: route pattern "${pattern}" must start with /`);
    if (!opts.permission) throw new Error(`${owner}: ${String(method)} ${pattern} names no permission (default deny)`);
    const path = raw ? pattern : `/api${pattern === '/' ? '' : pattern}`;
    const segs = split(path);
    const added: RouteEntry[] = [];
    for (const m of typeof method === 'string' ? [method] : method) {
      const entry: RouteEntry = { method: m.toUpperCase(), path, segs, handler, opts, owner, order: this.#order++ };
      const key = `${entry.method} ${segs.length}`;
      const list = this.#buckets.get(key) ?? [];
      list.push(entry);
      this.#buckets.set(key, list);
      added.push(entry);
    }
    return {
      dispose: () => {
        for (const e of added) {
          const key = `${e.method} ${e.segs.length}`;
          this.#buckets.set(key, (this.#buckets.get(key) ?? []).filter((x) => x !== e));
        }
      },
    };
  }

  /** The first route that matches, its captures decoded; HEAD falls back to GET. */
  match(method: string, pathname: string): Match | undefined {
    const parts = split(pathname);
    const found = this.#find(method, parts);
    return found ?? (method === 'HEAD' ? this.#find('GET', parts) : undefined);
  }

  /** Whether some route has this path under another method (a 405, not a 404). */
  pathKnown(pathname: string): boolean {
    const parts = split(pathname);
    for (const [key, list] of this.#buckets) if (key.endsWith(` ${parts.length}`) && list.some((r) => params(r.segs, parts))) return true;
    return false;
  }

  #find(method: string, parts: readonly string[]): Match | undefined {
    for (const route of this.#buckets.get(`${method} ${parts.length}`) ?? []) {
      const p = params(route.segs, parts);
      if (p && (!route.opts.when || route.opts.when(p))) return { route, params: p };
    }
    return undefined;
  }

  /** Every route, in the order added (the OpenAPI check reads it). */
  list(): RouteInfo[] {
    return [...this.#buckets.values()]
      .flat()
      .sort((a, b) => a.order - b.order)
      .map((r) => ({ method: r.method, path: r.path, owner: r.owner, permission: r.opts.permission, doc: r.opts.doc !== false, ...(r.opts.summary !== undefined && { summary: r.opts.summary }) }));
  }
}

function params(segs: readonly string[], parts: readonly string[]): Record<string, string> | undefined {
  if (segs.length !== parts.length) return undefined;
  const out: Record<string, string> = {};
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i] ?? '';
    const part = parts[i] ?? '';
    if (s.startsWith(':')) {
      try {
        out[s.slice(1)] = decodeURIComponent(part);
      } catch {
        return undefined; // a malformed %-escape matches nothing, as in v1
      }
    } else if (s !== part) return undefined;
  }
  return out;
}
