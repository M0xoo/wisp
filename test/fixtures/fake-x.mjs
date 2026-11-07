// A fake X, real HTTP on loopback, as docs.x.com describes it (nobody has run this against the live
// API yet: the shapes here are the docs'). It signs webhooks, asks the CRC when a webhook is made,
// runs the OAuth 2.0 authorization-code flow with its PKCE check, verifies the bot's OAuth 1.0a
// signature on each post and DM, and keeps X's DM rule: a bot writes only to someone who wrote first.
//
//   const x = await startFakeX(creds); x.url is WISP_X_API.
//   x.tweets, x.dms, x.webhooks, x.subscriptions, x.revoked  what it heard
//   x.fail('tweets', 429)  the next post answers that; 'dms' the same
//   x.people.set(id, { username })  who an OAuth sign-in comes back as: x.signingIn = id
//   x.mention(...), x.reply(...), x.retweet(...), x.dm(...)  deliver a signed event to the webhook

import { createHash, createHmac, randomBytes } from 'node:crypto';
import http from 'node:http';

export const CREDS = {
  clientId: 'fake-client-id',
  clientSecret: 'fake-client-secret',
  bot: { id: '9000', handle: 'wispbot', consumerKey: 'fake-consumer-key', consumerSecret: 'fake-consumer-secret', accessToken: 'fake-access-token', accessSecret: 'fake-access-secret', bearerToken: 'fake-app-bearer' },
};

const sig = (key, data) => `sha256=${createHmac('sha256', key).update(data).digest('base64')}`;
const pct = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// RFC 5849 for a JSON POST: the body isn't in the base string.
function oauth1Good(req, url, c) {
  const h = String(req.headers.authorization || '');
  if (!h.startsWith('OAuth ')) return false;
  const p = Object.fromEntries([...h.slice(6).matchAll(/([a-z_]+)="([^"]*)"/g)].map((m) => [m[1], decodeURIComponent(m[2])]));
  if (p.oauth_consumer_key !== c.bot.consumerKey || p.oauth_token !== c.bot.accessToken || p.oauth_signature_method !== 'HMAC-SHA1') return false;
  const { oauth_signature: got, ...rest } = p;
  const params = Object.entries(rest).map(([k, v]) => `${pct(k)}=${pct(v)}`).sort().join('&');
  const base = ['POST', pct(url), pct(params)].join('&');
  return createHmac('sha1', `${pct(c.bot.consumerSecret)}&${pct(c.bot.accessSecret)}`).update(base).digest('base64') === got;
}

export async function startFakeX(creds = CREDS) {
  const x = {
    tweets: [],
    dms: [],
    webhooks: [],
    subscriptions: [],
    revoked: [],
    issued: [],
    people: new Map(),
    signingIn: '',
    crcSeen: [],
    fails: { tweets: [], dms: [] },
    dmed: new Set(), // who has written to the bot: only they can be written to
    target: null, // { port, host, path }: the webhook, delivered to by hand
    bad: {}, // bad.crc: answer this webhook's CRC check as failed
  };
  const codes = new Map();
  const tokens = new Map();
  let nextTweet = 7000;
  let nextDm = 100;
  let nextEvent = 1;

  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const u = new URL(req.url, x.url);
    const p = u.pathname;
    const json = (status, o, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', connection: 'close', ...headers });
      res.end(JSON.stringify(o));
    };
    const appBearer = req.headers.authorization === `Bearer ${creds.bot.bearerToken}`;

    if (p === '/i/oauth2/authorize') {
      const q = u.searchParams;
      if (q.get('client_id') !== creds.clientId || q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) return json(400, { error: 'invalid_request' });
      const code = `code-${randomBytes(6).toString('hex')}`;
      codes.set(code, { who: x.signingIn, challenge: q.get('code_challenge'), redirect: q.get('redirect_uri'), scope: q.get('scope') });
      const to = new URL(q.get('redirect_uri'));
      to.search = new URLSearchParams({ code, state: q.get('state') }).toString();
      res.writeHead(302, { location: to.href, connection: 'close' });
      return res.end();
    }
    if (p === '/2/oauth2/token' && req.method === 'POST') {
      const want = `Basic ${Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64')}`;
      if (req.headers.authorization !== want) return json(401, { error: 'unauthorized_client' });
      const b = new URLSearchParams(raw);
      const c = codes.get(b.get('code'));
      codes.delete(b.get('code'));
      if (!c || b.get('grant_type') !== 'authorization_code' || b.get('redirect_uri') !== c.redirect) return json(400, { error: 'invalid_grant' });
      const challenge = createHash('sha256').update(b.get('code_verifier') || '').digest('base64url');
      if (challenge !== c.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE check failed' });
      const access = `at-${randomBytes(8).toString('hex')}`;
      const refresh = `rt-${randomBytes(8).toString('hex')}`;
      tokens.set(access, c.who);
      x.issued.push({ access, refresh, scope: c.scope });
      return json(200, { token_type: 'bearer', expires_in: 7200, access_token: access, refresh_token: refresh, scope: c.scope });
    }
    if (p === '/2/oauth2/revoke' && req.method === 'POST') {
      x.revoked.push(new URLSearchParams(raw).get('token'));
      return json(200, { revoked: true });
    }
    if (p === '/2/users/me') {
      const who = tokens.get(String(req.headers.authorization || '').replace(/^Bearer /, ''));
      if (!who) return json(401, { title: 'Unauthorized' });
      return json(200, { data: { id: who, username: x.people.get(who)?.username || `user${who}`, name: 'Someone' } });
    }
    if (p === '/2/webhooks' && req.method === 'POST') {
      if (!appBearer) return json(401, { title: 'Unauthorized' });
      const { url } = JSON.parse(raw || '{}');
      const ok = await x.crcCheck(url);
      if (!ok) return json(400, { title: 'CRC failed' });
      const hook = { id: String(5000 + x.webhooks.length), url, valid: true };
      x.webhooks.push(hook);
      return json(200, { data: hook });
    }
    if (p === '/2/activity/subscriptions' && req.method === 'POST') {
      if (!appBearer) return json(401, { title: 'Unauthorized' });
      const s = { subscription_id: String(6000 + x.subscriptions.length), ...JSON.parse(raw || '{}') };
      x.subscriptions.push(s);
      return json(200, { data: s });
    }
    if (p === '/2/tweets' && req.method === 'POST') {
      if (!oauth1Good(req, `${x.url}${p}`, creds)) return json(401, { title: 'Unauthorized' });
      const status = x.fails.tweets.shift();
      if (status) return json(status, { title: 'no' }, status === 429 ? { 'retry-after': '1' } : {});
      const b = JSON.parse(raw);
      const id = String(nextTweet++);
      x.tweets.push({ id, text: b.text, to: b.reply?.in_reply_to_tweet_id, body: b });
      return json(201, { data: { id, text: b.text } });
    }
    const m = /^\/2\/dm_conversations\/with\/(\d+)\/messages$/.exec(p);
    if (m && req.method === 'POST') {
      if (!oauth1Good(req, `${x.url}${p}`, creds)) return json(401, { title: 'Unauthorized' });
      const status = x.fails.dms.shift();
      if (status) return json(status, { title: 'no' }, status === 429 ? { 'retry-after': '1' } : {});
      if (!x.dmed.has(m[1])) return json(403, { title: 'Forbidden', detail: 'You cannot send messages to this user.' });
      const b = JSON.parse(raw);
      if ([...b.text].length > 10_000) return json(400, { title: 'Too long' });
      const id = String(nextDm++);
      x.dms.push({ id, to: m[1], text: b.text });
      return json(201, { data: { dm_event_id: id } });
    }
    json(404, { title: 'Not Found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  x.url = `http://127.0.0.1:${server.address().port}`;
  x.close = () => {
    server.closeAllConnections?.();
    return new Promise((r) => server.close(r));
  };

  // To the grid by hand: its address is wisp.localhost, which only it answers for.
  const toGrid = (method, path, headers, body) =>
    new Promise((resolve, reject) => {
      const t = x.target;
      const req = http.request({ host: '127.0.0.1', port: t.port, method, path, headers: { host: t.host, connection: 'close', ...headers } }, (res) => {
        let s = '';
        res.on('data', (d) => (s += d));
        res.on('end', () => resolve({ status: res.statusCode, text: s, at: Date.now(), json: () => JSON.parse(s) }));
      });
      req.on('error', reject);
      req.end(body);
    });

  x.crc = (token) => toGrid('GET', `${x.target.path}?crc_token=${encodeURIComponent(token)}`, {});
  x.crcCheck = async (url) => {
    x.crcSeen.push(url);
    const r = await x.crc('crc-from-x');
    if (r.status !== 200) return false;
    return r.json().response_token === sig(creds.clientSecret, 'crc-from-x');
  };

  // An envelope, signed. key/header: what signs it, and where that goes. header null: unsigned.
  x.deliver = (data, { key = creds.clientSecret, header = 'x-twitter-webhooks-signature-oauth2', raw } = {}) => {
    const body = raw ?? JSON.stringify({ data });
    return toGrid('POST', x.target.path, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...(header && { [header]: sig(key, body) }) }, body);
  };
  const envelope = (type, payload, { uuid = `ev-${nextEvent++}` } = {}) => ({ event_uuid: uuid, created_at: new Date().toISOString(), filter: { user_id: creds.bot.id }, event_type: type, tag: 'wisp', payload });

  x.postPayload = ({ author, text, id = String(nextTweet++), conversation = id, at = new Date(), ...more }) => ({ id, text, author_id: author, conversation_id: conversation, created_at: new Date(at).toISOString(), ...more });
  x.mention = (fields, o = {}) => {
    const payload = x.postPayload(fields);
    return x.deliver(envelope('post.mention.create', payload, o), o).then((r) => ({ ...r, post: payload }));
  };
  x.reply = (fields, o = {}) => {
    const payload = x.postPayload(fields);
    return x.deliver(envelope('post.reply.create', { in_reply_to_tweet_id: fields.to || payload.conversation_id, ...payload }, o), o).then((r) => ({ ...r, post: payload }));
  };
  // A retweet is delivered as a mention of whoever the original mentioned: its text is someone else's.
  x.retweet = ({ author, text, ...more }, o = {}) => x.mention({ author, text: `RT @someone: ${text}`, referenced_tweets: [{ type: 'retweeted', id: '1' }], ...more }, o);
  x.dm = ({ sender, text, id = `dm-${nextDm++}`, at = Date.now() }, o = {}) => {
    x.dmed.add(sender);
    const payload = { direct_message_events: [{ id, created_timestamp: String(at), message_create: { sender_id: sender, target: { recipient_id: creds.bot.id }, message_data: { text } } }] };
    return x.deliver(envelope('dm.received', payload, o), o);
  };
  x.fail = (what, status, n = 1) => {
    for (let i = 0; i < n; i++) x.fails[what].push(status);
  };
  return x;
}
