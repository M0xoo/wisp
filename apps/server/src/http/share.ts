// POST /share: the web manifest's share_target, when the service worker didn't take it (it exists only
// in a home-screen app that opened once). Not an API route: the phone's browser sends it at the path the
// manifest names. It takes no notice of the form (not parsed, not kept, nothing changes), so it's answered
// ahead of the Origin and JSON-only checks, which a multipart share would fail for no gain.
import type { IncomingMessage, ServerResponse } from 'node:http';

export const SHARE_LANDING = '/?shared=none';
export const isShare = (req: Pick<IncomingMessage, 'method' | 'url'>): boolean => req.method === 'POST' && String(req.url).split('?')[0] === '/share';

export function shareNoWorker(req: IncomingMessage, res: ServerResponse): void {
  req.resume(); // up to 20 MB nobody reads: dropped as it comes, so the browser hears back
  res.writeHead(303, { location: SHARE_LANDING, 'cache-control': 'no-store' });
  res.end();
}
