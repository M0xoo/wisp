// Trusted-proxy mode: wisp behind a reverse proxy that serves it at its own public address (wisp
// Grid's edge, or your own nginx/Caddy). Off unless WISP_TRUSTED_PROXY_SECRET is set.
//
// A request carrying the secret in x-wisp-proxy-secret came through the proxy, which has already
// checked who is asking: any Host is fine, and a non-GET Origin must be the public address
// (WISP_PUBLIC_URL), so a page elsewhere still can't post to it. Without the header, the usual
// localhost rules apply, so the CLI and the agents' MCP keep working on the box itself.

import { timingSafeEqual } from 'node:crypto';

const MIN_SECRET = 32;

export function trustedProxy(env = process.env) {
  const secret = String(env.WISP_TRUSTED_PROXY_SECRET || '');
  if (secret && secret.length < MIN_SECRET) console.warn(`wisp: WISP_TRUSTED_PROXY_SECRET is shorter than ${MIN_SECRET} characters; trusted-proxy mode stays off`);
  const on = secret.length >= MIN_SECRET;
  let origin = null;
  try {
    origin = env.WISP_PUBLIC_URL ? new URL(env.WISP_PUBLIC_URL).origin : null;
  } catch {
    console.warn('wisp: WISP_PUBLIC_URL is not a URL; ignoring it');
  }
  const want = Buffer.from(secret);
  return {
    on,
    origin,
    // Whether this request came through the proxy.
    via(req) {
      if (!on) return false;
      const got = req.headers['x-wisp-proxy-secret'];
      if (typeof got !== 'string' || got.length !== secret.length) return false;
      return timingSafeEqual(Buffer.from(got), want);
    },
    // A non-GET Origin through the proxy: the public address (or, with none set, the Host asked for).
    originOk(req) {
      const o = req.headers.origin;
      if (!o) return true;
      if (origin) return o === origin;
      return o.replace(/^https?:\/\//, '') === req.headers['x-forwarded-host'] || o.replace(/^https?:\/\//, '') === req.headers.host;
    },
  };
}
