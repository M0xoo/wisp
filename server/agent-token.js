// Who an agent is. Each session's agent gets a token of its own, so a call can only speak for the
// session that token was made for: naming another one in the URL or the body gets a 403. The
// server's own token (app.token) is never handed to an agent. Connector proxies get one that opens
// only the route they use.

import { createHmac, timingSafeEqual } from 'node:crypto';

const derive = (master, what) => createHmac('sha256', String(master)).update(what).digest('hex');
const same = (a, b) => {
  const [x, y] = [Buffer.from(String(a ?? '')), Buffer.from(String(b ?? ''))];
  return x.length === y.length && timingSafeEqual(x, y);
};

export const sessionToken = (master, id) => derive(master, `session:${id}`);
export const connectorToken = (master) => derive(master, 'connectors');

// A call that speaks for session `id`: that session's token, or wisp's own.
export const speaksFor = (given, master, id) => !!given && (same(given, master) || (!!id && same(given, sessionToken(master, id))));
export const connectorCall = (given, master) => !!given && (same(given, master) || same(given, connectorToken(master)));
