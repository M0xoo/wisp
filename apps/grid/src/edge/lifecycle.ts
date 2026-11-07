// What several routes do the same way: managing API keys, removing a device (and its computer),
// a sandbox, or a whole account.

import { bad } from '../errors.ts';
import { readBody, type Req } from '../http.ts';
import type { SandboxRow, UserRow } from '../rows.ts';
import type { Ctx } from './context.ts';
import { msg, statusOr } from './util.ts';

export type Send = (status: number, body: unknown) => void;

// Listing, making and revoking API keys, for /api/keys and /_grid/keys. send answers no-store
// (json()): a new key is in the POST's answer.
export async function manageKeys(x: Ctx, req: Req, user: UserRow, id: string | undefined, send: Send): Promise<void> {
  try {
    if (req.method === 'GET' && !id) return send(200, { keys: x.accounts.apiKeys(user.id).map(x.keyView) });
    if (req.method === 'POST' && !id) {
      x.limit(`apikey|${user.id}`, 30);
      const made = x.accounts.createApiKey(user.id, (await readBody(req))['name']);
      return send(201, { ...x.keyView(made), key: made.key });
    }
    if (req.method === 'DELETE' && id) return x.accounts.revokeApiKey(user.id, id) ? send(200, { ok: true }) : send(404, { error: 'No such key.' });
  } catch (err) {
    return send(statusOr(err, 400), { error: msg(err) });
  }
  return send(404, { error: 'not found' });
}

// A device removed: its computer too, and the tunnel that computer holds.
export function revokeDevice(x: Ctx, userId: string, deviceId: string): void {
  const gone = x.accounts.computers(userId).filter((c) => c.device_id === deviceId);
  x.accounts.revokeDevice(userId, deviceId);
  for (const c of gone) x.tunnels.close(c.id);
  x.notify(userId);
}

// A sandbox gone: its box and home (hostd → boxd), then its row and secrets.
export async function removeSandbox(x: Ctx, row: SandboxRow, user: UserRow): Promise<void> {
  await x.hostd.remove(x.sandboxes.box(row, user));
  x.sandboxes.remove(row);
  x.log(`grid: ${user.handle} removed sandbox ${row.id}`);
}

// Delete an account: disabled first, so no session or device starts its box again meanwhile; then
// the box and its files (agent logins included); then the account and its sealed secrets.
export async function deleteAccount(x: Ctx, u: UserRow): Promise<void> {
  x.accounts.setDisabled(u.id, true);
  try {
    for (const row of x.sandboxes.list(u.id)) await removeSandbox(x, row, u);
    await x.hostd.remove(u);
  } catch (err) {
    x.accounts.setDisabled(u.id, !!u.disabled);
    x.log(`grid: deleting ${u.handle}: ${msg(err)}`);
    throw bad('Your files couldn’t be deleted just now, so your account is still here. Try again in a minute.', 409);
  }
  const gone = x.accounts.computers(u.id);
  await x.routes.remove(u);
  await x.sites.removeAll(u.id);
  await x.shares.removeAll(u.id);
  x.accounts.remove(u.id);
  for (const c of gone) x.tunnels.close(c.id);
  x.log(`grid: ${u.handle} deleted their account`);
}
