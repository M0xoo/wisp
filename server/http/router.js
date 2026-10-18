// A small route table: `route('PATCH', '/sessions/:id', handler)`. Patterns match whole path
// segments under /api; `:name` captures one (URI-decoded). Routes are tried in the order they
// were added, so a fixed segment (`/projects/discover`) goes before a capture (`/projects/:id`).
//
// A handler gets one context object and answers through it:
//   { req, res, url, query, params, body(), send(status, data) }
// body() reads and parses the JSON request body (once). Options: `doc: false` marks a route that
// is not part of the public API (left out of openapi.json on purpose); `when(params)` narrows a
// pattern further (a route whose `when` says no is skipped, as if it didn't match).

import { readJson, send } from './respond.js';

export class Routes {
  #list = [];

  route(method, pattern, handler, { doc = true, when = null } = {}) {
    const segs = pattern.split('/').filter(Boolean);
    for (const m of [method].flat()) this.#list.push({ method: m, pattern, segs, handler, doc, when });
    return this;
  }

  // Every route, for the docs check in the tests.
  list() {
    return this.#list.map(({ method, pattern, doc }) => ({ method, pattern, doc }));
  }

  // Handles the request and returns true, or returns false when nothing matched.
  async handle(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop "api"
    for (const r of this.#list) {
      if (r.method !== req.method) continue;
      const params = match(r.segs, parts);
      if (!params || (r.when && !r.when(params))) continue;
      let parsed;
      const ctx = {
        req,
        res,
        url,
        params,
        query: url.searchParams,
        body: () => (parsed ??= readJson(req)),
        send: (status, data) => send(res, status, data),
      };
      await r.handler(ctx);
      return true;
    }
    return false;
  }
}

function match(segs, parts) {
  if (segs.length !== parts.length) return null;
  const params = {};
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].startsWith(':')) {
      try {
        params[segs[i].slice(1)] = decodeURIComponent(parts[i]);
      } catch {
        return null;
      }
    } else if (segs[i] !== parts[i]) return null;
  }
  return params;
}
