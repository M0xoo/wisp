// A computer the user added, at <name>--<handle>: the same sign-in as their wisp, then through the
// tunnel that computer holds open (tunnels.ts). Nothing here wakes anything: offline is a 503.
// A Box secret never reaches it (trust.ts: a box never gets a token for a laptop): edgeAuth takes
// a device, a cookie for this address, and nothing else.

import type { ComputerRow } from '../rows.ts';
import { clientIp, html, json, wantsHtml, type Req, type Res } from '../http.ts';
import { messagePage } from '../pages/index.ts';
import { isShare, shareNoWorker } from '../shared/share-landing.ts';
import { fromOutside } from '../trust.ts';
import { addressAuth, edgeAuth, signInAgain } from './box.ts';
import type { Ctx } from './context.ts';
import { previewLink } from './preview.ts';

export async function computerEdge(x: Ctx, req: Req, res: Res, url: URL, c: ComputerRow): Promise<void> {
  const user = x.accounts.userById(c.user_id);
  if (!user || user.disabled) return html(res, 404, messagePage({ cfg: x.cfg, title: 'No such computer', text: 'Nothing answers at this address.', link: [x.cfg.publicUrl, 'Home'] }));
  const origin = x.cfg.instanceUrl(c.label);
  const p = url.pathname;
  const back = `${x.cfg.publicUrl}/go?computer=${c.id}`;
  if (addressAuth(x, req, res, url, user, `i:${user.id}`, back)) return;
  const who = edgeAuth(x, req, user, user, null, 'computer');
  if (!who) return signInAgain(req, res, url, back);
  if (isShare(req)) return shareNoWorker(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD' && who.via === 'cookie' && req.headers.origin !== origin) return json(res, 403, { error: 'forbidden origin' });
  // The computer decides whether it shows its local pages (Show local pages in previews).
  if (p === '/_grid/preview' && req.method === 'POST') return previewLink(x, res, url, user, c.label, true);
  // Whether it's connected, without asking it anything (what wisp elsewhere polls while it's off).
  if (p === '/_grid/state') return json(res, 200, { state: x.tunnels.online(c.id) ? 'running' : 'offline', name: c.name });
  // Like the wisp edge: the grid's own sign-in stays here; the computer only learns who asked where.
  // fromOutside drops the grid's marks, x-wisp-route among them (only route delivery sets it), and
  // hop-by-hop headers, which the tunnel drops anyway.
  const headers = { ...fromOutside(req.headers), 'x-forwarded-host': String(req.headers.host || ''), 'x-forwarded-proto': x.cfg.scheme, 'x-forwarded-for': clientIp(req) };
  if (x.tunnels.forward(c.id, req, res, headers)) return;
  const text = `wisp on ${c.name} isn’t connected to the grid right now. It comes back when that computer is on and wisp runs there.`;
  if (wantsHtml(req)) return html(res, 503, messagePage({ cfg: x.cfg, title: `${c.name} is offline`, text, link: [x.cfg.publicUrl, 'Your account'] }), { 'retry-after': '10' });
  json(res, 503, { error: `${c.name} is offline.`, offline: true }, { 'retry-after': '10' });
}
