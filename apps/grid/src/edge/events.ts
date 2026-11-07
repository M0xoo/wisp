// The account page's event stream (GET /events): told when something on the page changed (a
// computer came online, the cloud wisp woke), the page fetches itself again. Its ping timer lives as
// long as the stream; closing the grid ends every stream (grid.ts), which clears them.

import { json, SECURITY } from '../http.ts';
import type { Root } from './root.ts';

const PING_MS = 25_000; // keeps proxies from dropping it

export function events(r: Root): void {
  const { x, res, s } = r;
  if (!s) return json(res, 401, { error: 'Sign in again.' });
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no', ...SECURITY });
  res.write('retry: 3000\n\n');
  const set = x.watchers.get(s.user.id) || new Set();
  x.watchers.set(s.user.id, set.add(res));
  const ping = setInterval(() => res.write(': ping\n\n'), PING_MS);
  res.on('close', () => {
    clearInterval(ping);
    set.delete(res);
    if (!set.size && x.watchers.get(s.user.id) === set) x.watchers.delete(s.user.id);
  });
}
