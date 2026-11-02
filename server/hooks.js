// Inbound hooks: triggers that start a task when something outside wisp calls them, at a secret
// URL, POST /api/hooks/<token> (Settings → Automations → Webhook triggers, off by default).
//   webhook  anything: its JSON (or form) body fills the prompt, {{body.a.b}} and {{text}};
//            optionally signed (HMAC sha256 of the raw body, hex, with or without "sha256=")
//   slack    Slack's Events API: url_verification, X-Slack-Signature (v0, 5 minutes), app_mention
//            and message events in one channel, optionally only with a keyword
//   linear   Linear's webhooks: Linear-Signature, an issue created, optionally with a label
// The token is the only way past wisp's localhost guard (server/index.js), and a signature, when
// there is one, is checked before anything else. At most one task per trigger every 30 s; each
// delivery is kept (the last five) with what came of it.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const HOOK_KINDS = new Set(['webhook', 'slack', 'linear']);
export const HOOK_PATH = /^\/api\/hooks\/[\w-]{20,64}$/;
export const RATE_MS = 30_000;
const MAX_BODY = 1024 * 1024;
const TEXT_MAX = 4000;
const SLACK_SKEW_S = 5 * 60;
const KEEP_DELIVERIES = 5;
const KEEP_SEEN = 50;

export const newToken = () => randomBytes(24).toString('base64url');

// --- templates -------------------------------------------------------------------------------

// {{text}}, {{body.a.b}} (arrays by index: {{body.items.0.name}}). Objects come out as JSON;
// anything missing is empty. params: a recipe's {name} values, filled in the same pass, so a
// {name} inside what came from outside stays as written.
export function render(template, vars, params = {}) {
  return String(template || '').replace(/\{\{\s*([\w.-]+)\s*\}\}|\{([a-zA-Z][\w-]{0,30})\}/g, (all, key, param) => {
    if (param) return params[param] != null && String(params[param]).trim() ? String(params[param]) : all;
    let v = vars;
    for (const k of key.split('.')) v = v != null && typeof v === 'object' && Object.hasOwn(v, k) ? v[k] : undefined;
    if (v == null) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

// A body as a person would read it: its JSON laid out, or the text it came as. First 4000 chars.
export function dump(body) {
  const s = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  return s.length > TEXT_MAX ? `${s.slice(0, TEXT_MAX)}\n…` : s;
}

// The body by its content type: JSON, a form (a Slack slash command), or plain text.
export function parseBody(raw, type = '') {
  const text = raw.toString('utf8');
  if (/json/i.test(type)) {
    try {
      return JSON.parse(text || '{}');
    } catch {
      return null;
    }
  }
  if (/x-www-form-urlencoded/i.test(type)) return Object.fromEntries(new URLSearchParams(text));
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// --- signatures ------------------------------------------------------------------------------

const same = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
const hmac = (secret, data) => createHmac('sha256', secret).update(data).digest('hex');

// A signature of the raw body: hex, or "sha256=" and hex (GitHub's way).
// PagerDuty sends "v1=<hex>", several at once while it rotates secrets: any of them will do.
export const hmacOk = (secret, raw, got) => !!got && String(got).split(',').some((x) => same(x.trim().replace(/^(sha256|v1)=/i, '').toLowerCase(), hmac(secret, raw)));

// Slack: v0=hex(HMAC(secret, "v0:<timestamp>:<body>")), the timestamp within five minutes.
export function slackOk(secret, raw, headers, now = Date.now()) {
  const ts = Number(headers['x-slack-request-timestamp']);
  const sig = headers['x-slack-signature'];
  if (!ts || !sig) return 'Missing Slack’s signature headers.';
  if (Math.abs(now / 1000 - ts) > SLACK_SKEW_S) return 'Slack’s timestamp is more than 5 minutes off: a replay, or this computer’s clock is wrong.';
  return same(sig, `v0=${hmac(secret, `v0:${ts}:${raw.toString('utf8')}`)}`) ? '' : 'Slack’s signature doesn’t match the signing secret.';
}

// --- what each kind makes of a delivery --------------------------------------------------------
// { reject } (401), { answer } (a reply with nothing started), { skip } or { vars, key? }.

export function readDelivery(t, raw, headers, now = Date.now()) {
  const body = parseBody(raw, headers['content-type']);
  if (t.kind === 'slack') {
    const bad = slackOk(t.secret, raw, headers, now);
    if (bad) return { reject: bad };
    if (body?.type === 'url_verification') return { answer: { challenge: String(body.challenge || '') }, why: 'Slack checked the URL' };
    const e = body?.event;
    if (body?.type !== 'event_callback' || !e) return { skip: `Not an event (${body?.type || 'unknown'})` };
    if (e.type !== 'app_mention' && e.type !== 'message') return { skip: `A ${e.type} event` };
    if (e.subtype || e.bot_id) return { skip: 'A bot’s message, or an edit' };
    if (t.channel && e.channel !== t.channel) return { skip: `Another channel (${e.channel})` };
    const text = String(e.text || '').replace(/<@[A-Z0-9]+>\s*/g, '').trim();
    if (t.keyword && !text.toLowerCase().includes(t.keyword.toLowerCase())) return { skip: `No “${t.keyword}” in it` };
    // A mention in a channel the app reads arrives twice (message and app_mention): one task.
    return { vars: { text, user: e.user || '', channel: e.channel || '' }, key: `slack:${e.channel}:${e.ts}` };
  }
  if (t.kind === 'linear') {
    if (!hmacOk(t.secret, raw, headers['linear-signature'])) return { reject: headers['linear-signature'] ? 'Linear’s signature doesn’t match the signing secret.' : 'Missing the Linear-Signature header.' };
    if (body?.webhookTimestamp && Math.abs(now - Number(body.webhookTimestamp)) > SLACK_SKEW_S * 1000) return { reject: 'Linear’s timestamp is more than 5 minutes off.' };
    if (body?.type !== 'Issue' || body?.action !== 'create') return { skip: `${body?.type || 'Something'} ${body?.action || 'happened'}, not an issue created` };
    const d = body.data || {};
    const labels = (d.labels || []).map((l) => String(l?.name || '').toLowerCase());
    if (t.label && !labels.includes(t.label.toLowerCase())) return { skip: `No “${t.label}” label` };
    return { vars: { title: d.title || '', url: d.url || body.url || '', description: String(d.description || '').slice(0, 8000), identifier: d.identifier || '' }, key: `linear:${d.id || headers['linear-delivery'] || ''}` };
  }
  if (t.secret) {
    const got = headers[String(t.header || 'x-hub-signature-256').toLowerCase()];
    if (!got) return { reject: `Missing the ${t.header || 'X-Hub-Signature-256'} header.` };
    if (!hmacOk(t.secret, raw, got)) return { reject: 'The signature doesn’t match the secret.' };
  }
  if (body === null) return { reject: 'The body isn’t JSON.' };
  return { vars: { body, text: dump(body) } };
}

// --- the route ---------------------------------------------------------------------------------

export function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > MAX_BODY) return reject(Object.assign(new Error('body too large'), { status: 413 }));
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// A delivery, kept on the trigger (the newest five): started (and which task), skipped or
// rejected, and why.
function record(t, d) {
  d.at = Date.now();
  t.deliveries = [d, ...(t.deliveries || [])].slice(0, KEEP_DELIVERIES);
}

// POST /api/hooks/:token. app: { store, triggers, configChanged }. Answers with { status, body }.
export async function deliver(app, token, req, { now = Date.now() } = {}) {
  const { store } = app;
  if (store.config.defaults.webhookTriggers !== 'on') return { status: 404, body: { error: 'not found' } };
  const t = (store.config.triggers || []).find((x) => HOOK_KINDS.has(x.kind) && x.token && same(x.token, token));
  if (!t) return { status: 404, body: { error: 'not found' } };
  const raw = await readRaw(req);
  const got = readDelivery(t, raw, req.headers, now);
  const done = (status, body, d) => {
    if (d) record(t, d);
    app.configChanged();
    return { status, body };
  };
  if (got.reject) return done(401, { error: got.reject }, { result: 'rejected', why: got.reject });
  if (got.answer) return done(200, got.answer, { result: 'skipped', why: got.why });
  if (got.skip) return done(200, { ok: true, skipped: got.skip }, { result: 'skipped', why: got.skip });
  if (!t.enabled) return done(200, { ok: true, skipped: 'The trigger is off.' }, { result: 'skipped', why: 'The trigger is off' });
  // Slack resends what it thinks went unanswered: the same event, once.
  if (got.key && (t.seen || []).includes(got.key)) return done(200, { ok: true, skipped: 'Already seen' }, null);
  if (t.lastHookAt && now - t.lastHookAt < RATE_MS) {
    const why = 'At most one task every 30 s';
    return done(t.kind === 'webhook' ? 429 : 200, { ok: false, skipped: why }, { result: 'skipped', why });
  }
  t.lastHookAt = now;
  if (got.key) t.seen = [got.key, ...(t.seen || [])].slice(0, KEEP_SEEN);
  const d = { result: 'started', why: '', session: null };
  record(t, d);
  // Answered at once (Slack gives up after 3 s); the task starts behind, and the delivery says how it went.
  app.triggers
    .hook(t, got.vars)
    .then((s) => {
      if (s?.id) d.session = s.id;
      else Object.assign(d, { result: 'skipped', why: t.held?.why ? `Held for your plan: ${t.held.why}` : 'Nothing started' });
    })
    .catch((err) => Object.assign(d, { result: 'rejected', why: String(err.message || err).slice(0, 200) }))
    .finally(() => app.configChanged());
  return done(202, { ok: true, accepted: true }, null);
}
