// API keys for scripting a cloud wisp, `Authorization: Bearer wgk_…` at https://<handle>.<domain>/api/…,
// asked for here by a desktop signed in to its grid. They live on the wisp Grid (grid/accounts.js),
// hashed; this keeps, broadcasts and logs nothing. A cloud wisp's keys are made at the edge
// (/_grid/keys, grid/server.js), with the person's browser cookie, which the box never sees.
//
// Closed: a key can't call these (guard(), for a cloud wisp signed in to another grid with a device
// token; the edge's x-wisp-proxy-via can't be sent from outside), the Box secret anything on the box
// can read can't make a key (never the 'box' target here, refused on /api/keys), and a preview
// ticket can't become a session. Not closed: a page the box serves to a signed-in person can reach
// /_grid/keys; moving minting to the grid's own address is what would close that.

import { gridJson } from '../grid-client.js';
import { bad } from '../util.js';
import { gridTargets } from './publish.js';

export function createApiKeys(app, { env = process.env } = {}) {
  const target = () => gridTargets(app, env).filter((t) => t.id !== 'box')[0] || null;
  const ask = async (t, method, p, body) => {
    let r;
    try {
      r = await gridJson(`${t.grid}${p}`, { method, body, headers: { authorization: t.auth }, timeout: 60_000 });
    } catch (err) {
      throw bad(`Couldn’t reach ${t.host}: ${err.message}`, 502);
    }
    if (r.status === 404 && method !== 'DELETE') throw bad(`${t.host} doesn’t make API keys yet (its wisp Grid is older).`, 409);
    if (r.status >= 400) throw bad(r.body.error || `${t.host} said ${r.status}.`, r.status === 401 ? 409 : r.status >= 500 ? 502 : r.status);
    return r.body;
  };
  const writable = () => {
    const t = target();
    if (!t) throw bad('Sign in to a wisp Grid first (Settings → Cloud): API keys are for your cloud wisp.', 409);
    return t;
  };

  return {
    guard(req) {
      if (app.proxy?.via(req) && req.headers['x-wisp-proxy-via'] === 'key') throw bad('An API key can’t manage API keys.', 403);
    },
    async list() {
      const t = target();
      if (!t) return { grid: null, keys: [] };
      const out = await ask(t, 'GET', '/api/keys');
      return { grid: { host: t.host, handle: t.handle }, keys: out.keys || [] };
    },
    create: (name) => ask(writable(), 'POST', '/api/keys', { name }),
    revoke(id) {
      const t = writable();
      if (!/^[a-f0-9]{1,32}$/.test(id)) throw bad('No such key.', 404);
      return ask(t, 'DELETE', `/api/keys/${id}`);
    },
  };
}
