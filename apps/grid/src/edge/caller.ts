// Who is calling the grid's own API, by the credential its request carries, and whether that
// credential reaches what it asks for (trust.ts). A device token and a Box secret are the two that
// reach any of it; which parts each reaches is CAPABILITIES' word, not a check written per route.

import type { DeviceOf } from '../accounts.ts';
import type { Req } from '../http.ts';
import type { UserRow } from '../rows.ts';
import { may, type Credential, type Reach } from '../trust.ts';
import type { Ctx } from './context.ts';

export interface Caller {
  user: UserRow;
  credential: Credential;
  /** the device, for a device token */
  dev: DeviceOf | null;
}

/** The caller, if its credential is good and reaches `reach`; null answers 401 (v1's "Sign in again"). */
export function caller(x: Ctx, req: Req, reach: Reach): Caller | null {
  const auth = req.headers.authorization;
  const dev = x.accounts.device(auth);
  if (dev) return may('device', reach).ok ? { user: dev.user, credential: 'device', dev } : null;
  const box = x.boxUser(auth);
  if (box) return may('box', reach).ok ? { user: box, credential: 'box', dev: null } : null;
  return null;
}
