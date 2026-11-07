// Copy of v1 server/http/share.js (SHARE_LANDING, isShare, shareNoWorker); the grid serves what wisp
// packed, so the format must match. When the owner plugin (edge) publishes these from its api,
// import them from there and delete this copy.
//
// POST /share: the manifest's share_target, when the service worker didn't take it (only a home-
// screen app that has opened once has one). It takes no notice of the form: not parsed, not kept,
// nothing changes. So it's answered ahead of the Origin and sign-in checks, which it would fail for
// no gain: a page elsewhere posting here only learns where / is.

import type { IncomingMessage, ServerResponse } from 'node:http';

export const SHARE_LANDING = '/?shared=none';
export const isShare = (req: IncomingMessage): boolean => req.method === 'POST' && String(req.url).split('?')[0] === '/share';

export function shareNoWorker(req: IncomingMessage, res: ServerResponse): void {
  req.resume(); // up to 20 MB of a form nobody reads: dropped as it comes, so the browser hears back
  res.writeHead(303, { location: SHARE_LANDING, 'cache-control': 'no-store' });
  res.end();
}
