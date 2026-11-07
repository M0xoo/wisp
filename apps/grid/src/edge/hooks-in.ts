// Webhooks into the grid, which never sign in: an unguessable token in the path does that (a
// channel's /_in/<token>, a bot's /_route/<token>), or the provider's signature (/_mail/<provider>).
// Nothing here logs the path: it holds the token (trust.ts: webhook → inbox, route).

import { BODY_MAX, IN_PATH, readCapped } from '../inbox.ts';
import { clientIp, json, type Req, type Res } from '../http.ts';
import { ROUTE_PATH } from '../route.ts';
import type { Ctx } from './context.ts';
import { msg, statusOr } from './util.ts';

const none = (res: Res): void => json(res, 404, { error: 'not found' });

function failed(x: Ctx, res: Res, err: unknown, what: string): void {
  if (statusOr(err, 0) === 429) return json(res, 429, { error: msg(err) });
  x.log(`grid: ${what}: ${msg(err)}`);
  if (res.headersSent) res.end();
  else json(res, 500, { error: 'Something went wrong on the grid.' });
}

// A channel's webhook: answered here, whatever the box is doing. Only at its owner's address.
export async function channelIn(x: Ctx, req: Req, res: Res, url: URL, handle: string): Promise<void> {
  if (!x.inbox.on || req.method !== 'POST') return none(res);
  try {
    const m = IN_PATH.exec(url.pathname);
    const hit = m?.[1] ? x.inbox.byToken(m[1]) : null;
    const user = hit ? x.accounts.byHandle(handle) : undefined;
    // By address only for what no one knows: a sender like Telegram posts every user's webhook
    // from a few addresses, so a known token has its own limit and doesn't count here.
    if (!hit || !user || user.disabled || user.id !== hit.user_id) {
      x.limit(`in|${clientIp(req)}`, 600);
      return none(res);
    }
    // An edge spends its own budgets once a request is verified (inbox.accept): this only stops a flood.
    x.limit(`intok|${user.id}|${hit.channel}`, x.inbox.edged(hit.channel) ? 1200 : 120);
    const answer = await x.inbox.accept(user, hit.channel, req);
    if (answer) json(res, answer.status, answer.body);
    else json(res, 200, { ok: true });
  } catch (err) {
    failed(x, res, err, `inbox for ${handle}`);
  }
}

// A bot's webhook, which the grid owns (route.ts). The 200 comes after the grid has decided and held
// what it's holding, so a failure gets Telegram's retry; only the forward happens after it.
export async function routeIn(x: Ctx, req: Req, res: Res, p: string): Promise<void> {
  if (!x.routes.on || req.method !== 'POST') return none(res);
  try {
    const m = ROUTE_PATH.exec(p);
    const hit = m?.[1] ? x.routes.check(m[1], req.headers['x-telegram-bot-api-secret-token']) : null;
    if (!hit) {
      x.limit(`in|${clientIp(req)}`, 600);
      return hit === false ? json(res, 403, { error: 'forbidden' }) : none(res);
    }
    x.limit(`intok|${hit.user.id}|route`, 120);
    const raw = await readCapped(req, BODY_MAX);
    const next = x.routes.take(hit.user, hit.route, raw);
    json(res, 200, { ok: true });
    next?.().catch((err: unknown) => x.log(`grid: route for ${hit.user.handle}: ${msg(err)}`)); // not what the person said
  } catch (err) {
    failed(x, res, err, 'route');
  }
}

// The mail provider's webhook. It never signs in: its signature does that, checked in mail.ts.
export async function mailIn(x: Ctx, req: Req, res: Res, provider: string): Promise<void> {
  if (!x.mail || !x.cfg.mail || req.method !== 'POST' || provider !== x.cfg.mail.inbound.provider) return none(res);
  x.limit(`mailin|${clientIp(req)}`, 600);
  const out = await x.mail.webhook(req);
  json(res, out.status, out.body);
}
