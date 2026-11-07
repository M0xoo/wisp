// Who is asking (ADR-0008): every request speaks for one capability set, decided here, before any route
// runs. v1 checked tokens route by route (agent-token.js, routes/internal.js, control.js); v2 decides
// once and the route's permission is checked against the set.
//   x-wisp-token = wisp's own token          user:full (the CLI and wisp's own helpers)
//   x-wisp-token = a session's token          agent:session:<id>, or what server.caller says (a mode, a cap)
//   x-wisp-token = the connectors' token      connector (only the token route its proxies use)
//   x-wisp-token = anything else              403 bad token, whatever the route
//   via the trusted proxy, x-wisp-proxy-via: key     apikey (a script with a wgk_ key, checked at the edge)
//   via the trusted proxy, otherwise         the install's user set (box on a grid box)
//   the local page (Host and Origin checked)  the install's user set
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const derive = (master: string, what: string): string => createHmac('sha256', master).update(what).digest('hex');
const same = (a: unknown, b: string): boolean => {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** The token a session's agent gets: it speaks for that session only (v1 agent-token.js). */
export const sessionToken = (master: string, id: string): string => derive(master, `session:${id}`);
/** The token connector proxies get: it opens only the route they use. */
export const connectorToken = (master: string): string => derive(master, 'connectors');

/** v1's speaksFor: wisp's own token, or the session's. */
export const speaksFor = (given: unknown, master: string, id: string | undefined): boolean => !!given && (same(given, master) || (!!id && same(given, sessionToken(master, id))));

export interface Caller {
  set: string;
  session?: string;
}

export type CallerResult = { ok: true; caller: Caller } | { ok: false; status: 403; error: string };

export interface AuthOptions {
  master: string;
  /** the set the person at the page speaks with: 'user:full', or 'box' on a grid box */
  userSet: string;
  /** the set a session's agent speaks with (server.caller contributions); undefined: agent:session:<id> */
  setFor(session: string): string | undefined;
  /** the request came through the trusted proxy */
  viaProxy: boolean;
}

/** Session ids a request names: the URL's :id/:sid, x-wisp-session, then the body's `session`. */
export interface Named {
  params: Readonly<Record<string, string>>;
  body(): Promise<unknown>;
}

const header = (req: Pick<IncomingMessage, 'headers'>, name: string): string | undefined => {
  const v = req.headers[name];
  return typeof v === 'string' ? v : undefined;
};

async function namedSessions(req: Pick<IncomingMessage, 'headers'>, named: Named): Promise<string[]> {
  const ids = [named.params['id'], named.params['sid'], header(req, 'x-wisp-session')].filter((x): x is string => !!x);
  if (ids.length) return ids;
  // bySession routes name it in the body (v1 internal.js): read only when nothing else did
  const body = await named.body().catch(() => undefined);
  const s = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['session'] : undefined;
  return typeof s === 'string' && s ? [s] : [];
}

export async function resolveCaller(req: Pick<IncomingMessage, 'headers'>, named: Named, o: AuthOptions): Promise<CallerResult> {
  const token = header(req, 'x-wisp-token');
  if (token !== undefined) {
    if (same(token, o.master)) return { ok: true, caller: { set: o.userSet } };
    if (same(token, connectorToken(o.master))) return { ok: true, caller: { set: 'connector' } };
    for (const id of await namedSessions(req, named)) {
      if (same(token, sessionToken(o.master, id))) return { ok: true, caller: { set: o.setFor(id) ?? `agent:session:${id}`, session: id } };
    }
    return { ok: false, status: 403, error: 'bad token' };
  }
  if (o.viaProxy && header(req, 'x-wisp-proxy-via') === 'key') return { ok: true, caller: { set: 'apikey' } };
  return { ok: true, caller: { set: o.userSet } };
}
