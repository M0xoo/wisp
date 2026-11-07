// One call to a grid as one of this wisp's targets (deps.ts gridTargets): v1's `ask` in api-keys.js,
// publish.js, sandbox.js and share.js, which differ only in the words for an older grid and in which
// statuses they pass on. A grid's 401 means this wisp's sign-in there is gone: a 409 here (sign in
// again), never a 401 the page would read as its own session ending.

import type { GridTarget } from './deps.ts';
import { bad, GridError, gridJson, str, why } from './grid-http.ts';
import type { GridRequest } from './grid-http.ts';

export interface AskOptions extends GridRequest {
  /** what a 404 means (an older grid): `${host} doesn’t <older>` */
  older: string;
  /** a 404 with an error of its own is that error, not an older grid (share.js) */
  olderOnlyBare?: boolean;
}

export async function ask(t: GridTarget, method: string, p: string, o: AskOptions): Promise<Record<string, unknown>> {
  const { older, olderOnlyBare, ...req } = o;
  let r;
  try {
    r = await gridJson(`${t.grid}${p}`, { ...req, method, headers: { authorization: t.auth, ...req.headers } });
  } catch (err) {
    throw bad(`Couldn’t reach ${t.host}: ${why(err)}`, 502);
  }
  const error = str(r.body['error']);
  const isOlder = olderOnlyBare ? r.status === 404 && !error : r.status === 404 && method !== 'DELETE';
  if (isOlder) throw bad(`${t.host} doesn’t ${older} yet (its wisp Grid is older).`, 409);
  if (r.status >= 400) {
    const locked = r.body['locked'] === true;
    const status = r.status === 401 && !locked ? 409 : r.status >= 500 ? 502 : r.status;
    throw new GridError(error || `${t.host} said ${r.status}.`, status, locked ? { locked: true, from: r.body['from'] ?? null } : {});
  }
  return r.body;
}
