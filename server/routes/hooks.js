// Triggers' secret URLs (server/hooks.js): Slack, Linear or anything else starts a task by calling
// POST /api/hooks/<token>. Reached without wisp's localhost guard (server/index.js lets this path
// through on any host, origin and content type): the token, then the signature, are the check.

import { deliver } from '../hooks.js';

export function register(r, app) {
  r.route('POST', '/hooks/:token', async (c) => {
    const out = await deliver(app, c.params.token, c.req);
    c.send(out.status, out.body);
  });
}
