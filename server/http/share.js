// POST /share: the manifest's share_target, when the service worker didn't take it (web/sw.js, which
// only exists in a home-screen app that has opened once). Not an API route, so neither openapi.json
// nor `doc: false`: the phone's browser sends it, at the path the manifest names.
//
// It takes no notice of the form: not parsed, not kept, nothing changes. So it's answered ahead of
// the Origin and JSON-only checks, which it would fail for no gain (a share carries multipart, and
// its Origin is up to the browser): a page elsewhere posting here only learns where / is. The page
// tells the person what happened (features/share-in.js).

export const SHARE_LANDING = '/?shared=none';
export const isShare = (req) => req.method === 'POST' && String(req.url).split('?')[0] === '/share';

export function shareNoWorker(req, res) {
  req.resume(); // up to 20 MB of a form nobody reads: dropped as it comes, so the browser hears back
  res.writeHead(303, { location: SHARE_LANDING, 'cache-control': 'no-store' });
  res.end();
}
