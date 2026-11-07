// The cloud wisp asking for itself, with its Box secret: where its channel's webhook goes, a new one,
// the key a channel's edge checks with, and answering mail its box accepted (inbox.ts, mail.ts).
// Only ever its own: that secret can be read on the box, so this reaches nothing past it (trust.ts).

import { readBody, type Req } from '../http.ts';
import { SIGN_IN_AGAIN, type Ctx } from './context.ts';
import { caller } from './caller.ts';
import type { Send } from './lifecycle.ts';

/** Answers p if it is one of these routes; false when it isn't. */
export async function boxApi(x: Ctx, req: Req, url: URL, send: Send): Promise<boolean> {
  const p = url.pathname;
  const post = req.method === 'POST';
  const mailReply = !!x.mail && post && p === '/api/channels/mail/reply';
  const which = x.inbox.on && req.method === 'GET' && p === '/api/channels/url' ? 'url' : x.inbox.on && post && p === '/api/channels/url/rotate' ? 'rotate' : x.inbox.on && post && p === '/api/channels/url/key' ? 'key' : mailReply ? 'mail' : null;
  if (!which) return false;
  const who = caller(x, req, which === 'mail' ? 'grid:mail-reply' : 'grid:channels');
  if (!who) return send(401, { error: SIGN_IN_AGAIN }), true;
  const user = who.user;
  // A cloud wisp answering a message its box accepted. It can't name an address (mail.ts).
  if (which === 'mail' && x.mail) {
    x.limit(`mailout|${user.id}`, 120);
    send(200, await x.mail.reply(user, await readBody(req)));
    return true;
  }
  const channel = url.searchParams.get('channel') ?? '';
  if (!x.inbox.knows(channel)) return send(404, { error: 'not found' }), true;
  if (which === 'url') {
    x.limit(`inurl|${user.id}`, 60);
    // held: the grid owns this bot's webhook (route.ts), so the box leaves it alone.
    const held = x.routes.boxAsked(user.id, channel, url.searchParams.get('bot'), url.searchParams.has('gone'));
    send(200, { ...x.inbox.urlFor(user, channel), ...(held && { held: true }) });
  } else if (which === 'rotate') {
    x.limit(`inrot|${user.id}`, 10);
    send(200, x.inbox.rotate(user, channel));
  } else {
    // The key a channel's edge checks with (inbox.ts): its own box's word, for its own URL.
    x.limit(`inkey|${user.id}`, 30);
    const body = await readBody(req);
    x.inbox.setKey(user, channel, body['key'], body['linked']);
    send(200, { ok: true });
  }
  return true;
}
