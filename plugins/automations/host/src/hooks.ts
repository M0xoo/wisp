// Inbound hooks (v1 server/hooks.js): triggers that start a task when something outside wisp calls
// their secret URL, POST /api/hooks/<token> (Settings → Automations → Webhook triggers, off by default).
//   webhook  anything: its JSON (or form) body fills the prompt, {{body.a.b}} and {{text}};
//            optionally signed (HMAC sha256 of the raw body, hex, with or without "sha256=")
//   slack    Slack's Events API: url_verification, X-Slack-Signature (v0, 5 minutes), app_mention
//            and message events in one channel, optionally only with a keyword
//   linear   Linear's webhooks: Linear-Signature, an issue created, optionally with a label
// Pure but for node:crypto: the delivery's bookkeeping is in ./deliver.ts.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Json } from '@wisp/kernel';
import type { Trigger } from './types.ts';
import { isObj } from './util.ts';

export const RATE_MS = 30_000;
export const MAX_BODY = 1024 * 1024;
const TEXT_MAX = 4000;
const SKEW_S = 5 * 60;

export const newToken = (): string => randomBytes(24).toString('base64url');

type Vars = Readonly<Record<string, unknown>>;

/**
 * {{text}}, {{body.a.b}} (arrays by index: {{body.items.0.name}}). Objects come out as JSON; anything
 * missing is empty. params: a recipe's {name} values, filled in the same pass, so a {name} inside
 * what came from outside stays as written.
 */
export function render(template: string, vars: Vars, params: Readonly<Record<string, Json>> = {}): string {
  return String(template || '').replace(/\{\{\s*([\w.-]+)\s*\}\}|\{([a-zA-Z][\w-]{0,30})\}/g, (all, key: string | undefined, param: string | undefined) => {
    if (param) {
      const p = params[param];
      return p != null && String(p).trim() ? String(p) : all;
    }
    let v: unknown = vars;
    for (const k of String(key).split('.')) v = isObj(v) || Array.isArray(v) ? (Object.hasOwn(v, k) ? (v as Record<string, unknown>)[k] : undefined) : undefined;
    if (v == null) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

/** A body as a person would read it: its JSON laid out, or the text it came as. First 4000 chars. */
export function dump(body: unknown): string {
  const s = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  return s.length > TEXT_MAX ? `${s.slice(0, TEXT_MAX)}\n…` : s;
}

/** The body by its content type: JSON (null when it isn't), a form (a Slack slash command), or text. */
export function parseBody(raw: Uint8Array, type = ''): unknown {
  const text = Buffer.from(raw).toString('utf8');
  if (/json/i.test(type)) {
    try {
      return JSON.parse(text || '{}') as unknown;
    } catch {
      return null;
    }
  }
  if (/x-www-form-urlencoded/i.test(type)) return Object.fromEntries(new URLSearchParams(text));
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

const same = (a: unknown, b: unknown): boolean => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
export const sameToken = same;
const hmac = (secret: string, data: Uint8Array | string): string => createHmac('sha256', secret).update(data).digest('hex');

/**
 * A signature of the raw body: hex, or "sha256=" and hex (GitHub's way). PagerDuty sends
 * "v1=<hex>", several at once while it rotates secrets: any of them will do.
 */
export const hmacOk = (secret: string, raw: Uint8Array, got: unknown): boolean =>
  !!got && String(got).split(',').some((x) => same(x.trim().replace(/^(sha256|v1)=/i, '').toLowerCase(), hmac(secret, raw)));

export type Headers = Readonly<Record<string, string | string[] | undefined>>;
const header = (h: Headers, k: string): string | undefined => {
  const v = h[k.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

/** Slack: v0=hex(HMAC(secret, "v0:<timestamp>:<body>")), the timestamp within five minutes. '' when good. */
export function slackOk(secret: string, raw: Uint8Array, headers: Headers, now: number): string {
  const ts = Number(header(headers, 'x-slack-request-timestamp'));
  const sig = header(headers, 'x-slack-signature');
  if (!ts || !sig) return 'Missing Slack’s signature headers.';
  if (Math.abs(now / 1000 - ts) > SKEW_S) return 'Slack’s timestamp is more than 5 minutes off: a replay, or this computer’s clock is wrong.';
  return same(sig, `v0=${hmac(secret, `v0:${ts}:${Buffer.from(raw).toString('utf8')}`)}`) ? '' : 'Slack’s signature doesn’t match the signing secret.';
}

/** What a kind makes of a delivery: a 401, a reply with nothing started, a skip, or the prompt's vars. */
export type Read =
  | { reject: string }
  | { answer: Json; why: string }
  | { skip: string }
  | { vars: Record<string, unknown>; key?: string };

const rec = (v: unknown): Record<string, unknown> => (isObj(v) ? v : {});
const str = (v: unknown): string => (v == null ? '' : String(v));

function readSlack(t: Trigger, body: unknown, raw: Uint8Array, headers: Headers, now: number): Read {
  const bad = slackOk(t.secret, raw, headers, now);
  if (bad) return { reject: bad };
  const b = rec(body);
  if (b['type'] === 'url_verification') return { answer: { challenge: str(b['challenge']) }, why: 'Slack checked the URL' };
  const e = rec(b['event']);
  if (b['type'] !== 'event_callback' || !isObj(b['event'])) return { skip: `Not an event (${str(b['type']) || 'unknown'})` };
  if (e['type'] !== 'app_mention' && e['type'] !== 'message') return { skip: `A ${str(e['type'])} event` };
  if (e['subtype'] || e['bot_id']) return { skip: 'A bot’s message, or an edit' };
  if (t.channel && e['channel'] !== t.channel) return { skip: `Another channel (${str(e['channel'])})` };
  if (!e['user']) return { skip: 'No sender on it' };
  // By Slack's id, never a name. A trigger saved before people had to be named has none, and stays open.
  if (t.users?.length && !t.users.includes(str(e['user']))) return { skip: 'Not one of the allowed people' };
  const text = str(e['text']).replace(/<@[A-Z0-9]+>\s*/g, '').trim();
  if (t.keyword && !text.toLowerCase().includes(t.keyword.toLowerCase())) return { skip: `No “${t.keyword}” in it` };
  // A mention in a channel the app reads arrives twice (message and app_mention): one task.
  return { vars: { text, user: str(e['user']), channel: str(e['channel']) }, key: `slack:${str(e['channel'])}:${str(e['ts'])}` };
}

function readLinear(t: Trigger, body: unknown, raw: Uint8Array, headers: Headers, now: number): Read {
  const sig = header(headers, 'linear-signature');
  if (!hmacOk(t.secret, raw, sig)) return { reject: sig ? 'Linear’s signature doesn’t match the signing secret.' : 'Missing the Linear-Signature header.' };
  const b = rec(body);
  if (b['webhookTimestamp'] && Math.abs(now - Number(b['webhookTimestamp'])) > SKEW_S * 1000) return { reject: 'Linear’s timestamp is more than 5 minutes off.' };
  if (b['type'] !== 'Issue' || b['action'] !== 'create') return { skip: `${str(b['type']) || 'Something'} ${str(b['action']) || 'happened'}, not an issue created` };
  const d = rec(b['data']);
  const labels = (Array.isArray(d['labels']) ? d['labels'] : []).map((l) => str(rec(l)['name']).toLowerCase());
  if (t.label && !labels.includes(t.label.toLowerCase())) return { skip: `No “${t.label}” label` };
  const vars = { title: str(d['title']), url: str(d['url']) || str(b['url']), description: str(d['description']).slice(0, 8000), identifier: str(d['identifier']) };
  return { vars, key: `linear:${str(d['id']) || header(headers, 'linear-delivery') || ''}` };
}

export function readDelivery(t: Trigger, raw: Uint8Array, headers: Headers, now: number): Read {
  const body = parseBody(raw, header(headers, 'content-type'));
  if (t.kind === 'slack') return readSlack(t, body, raw, headers, now);
  if (t.kind === 'linear') return readLinear(t, body, raw, headers, now);
  if (t.secret) {
    const got = header(headers, t.header || 'x-hub-signature-256');
    if (!got) return { reject: `Missing the ${t.header || 'X-Hub-Signature-256'} header.` };
    if (!hmacOk(t.secret, raw, got)) return { reject: 'The signature doesn’t match the secret.' };
  }
  if (body === null) return { reject: 'The body isn’t JSON.' };
  return { vars: { body, text: dump(body) } };
}
