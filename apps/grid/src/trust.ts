// Who may reach what on the grid, as data (plan §7.2.4). v1 wrote these rules as comments in
// grid/route.js, grid/inbox.js, grid/server.js and server/http/trust.js; here each is a row the edge
// asks (`may`) and a test reads (test/trust.test.ts). Default deny: a credential reaches only what
// its set allows, and a deny names why, in the words v1's comments used.
//
// The one rule everything else serves: **a box never gets a token for a laptop.** Anything on a box
// can read its Box secret (hostd gives it to the box's wisp), so a prompt injection in a box holds
// it. That secret therefore reaches the box's own channel and publishing API and nothing past them:
// never a computer, never a computer's report, never a key or a sign-in link.

import { timingSafeEqual } from 'node:crypto';

/** How a caller proved who it is. */
export type Credential =
  /** the grid's own cookie, on the grid's own origin: its pages and CSRF forms */
  | 'session'
  /** `i:<box id>`: a sign-in at one box's or computer's own address, set from a one-time ticket */
  | 'cookie'
  /** `p:<label>`: a preview's sign-in, for that label's preview addresses only */
  | 'preview'
  /** a device token (`wgd_…`, RFC 8628): wisp on a computer or a phone */
  | 'device'
  /** an API key (`wgk_…`): a script, for its user's own wisp */
  | 'key'
  /** `Box <handle> <secret>`: the cloud wisp asking for itself */
  | 'box'
  /** a sandbox's own bearer, for that sandbox's address */
  | 'sandbox'
  /** a trigger's secret URL (POST /api/hooks/<token>): the wisp checks it */
  | 'hook'
  /** an unguessable webhook path (/_in/<token>, /_route/<token>) or a provider's signature (/_mail/) */
  | 'webhook';

/** Where a request goes. */
export type Reach =
  /** the grid's pages: account, devices, delete, sign out */
  | 'grid:pages'
  /** /channels/route: giving the grid a bot to own (only here, never at <handle>/_grid/*) */
  | 'grid:route-page'
  /** the device API: /api/me, /api/device/link, /api/computers, /api/device/revoke */
  | 'grid:device'
  /** /api/keys: list, make and revoke API keys from a device */
  | 'grid:keys'
  /** /_grid/keys at the box's own address: the same, from the person's browser */
  | 'edge:keys'
  /** /api/channels/url, …/rotate, …/key: a channel's webhook for the box's own address */
  | 'grid:channels'
  /** /api/channels/mail/reply: answering a message the box accepted */
  | 'grid:mail-reply'
  /** /api/channels/reply: a computer's report on a routed message */
  | 'grid:report'
  /** /api/sites, /api/shares, /api/sandboxes: publishing from My Stuff, sharing, sandboxes */
  | 'grid:publish'
  /** GET /api/computers/<id>/tunnel: a computer holding its tunnel open */
  | 'grid:tunnel'
  /** <handle>: the user's own wisp in its box */
  | 'box'
  /** <name>--<handle>: a computer the user added, through its tunnel */
  | 'computer'
  /** sb-<id>--<handle>: a sandbox's box */
  | 'sandbox'
  /** p<port>--<label>: a page in a box or on a computer */
  | 'preview'
  /** /_in/<token>, /_mail/<provider>: held by the grid for the box */
  | 'inbox'
  /** /_route/<token>: `on laptop`, read by the grid and sent to a computer */
  | 'route';

export interface Deny {
  reach: Reach;
  why: string;
}

export interface CapabilitySet {
  credential: Credential;
  allow: readonly Reach[];
  deny: readonly Deny[];
}

const BOX_READS = 'anything on a box can read its Box secret';

export const CAPABILITIES: Readonly<Record<Credential, CapabilitySet>> = {
  session: {
    credential: 'session',
    allow: ['grid:pages', 'grid:route-page'],
    deny: [],
  },
  cookie: {
    credential: 'cookie',
    allow: ['box', 'computer', 'sandbox', 'edge:keys'],
    deny: [{ reach: 'preview', why: 'a preview link, which anything on a box can ask for, must never become a session anywhere else, and the reverse' }],
  },
  preview: {
    credential: 'preview',
    allow: ['preview'],
    deny: [
      { reach: 'box', why: 'a preview cookie is good for its own label’s preview addresses only' },
      { reach: 'computer', why: 'a preview cookie is good for its own label’s preview addresses only' },
      { reach: 'sandbox', why: 'a preview cookie is good for its own label’s preview addresses only' },
    ],
  },
  device: {
    credential: 'device',
    allow: ['grid:device', 'grid:keys', 'grid:report', 'grid:publish', 'grid:tunnel', 'box', 'computer', 'sandbox'],
    deny: [
      { reach: 'grid:channels', why: 'a channel’s URL and key are the box’s own word, for its own address' },
      { reach: 'edge:keys', why: 'API keys are made from Settings, in a browser' },
    ],
  },
  key: {
    credential: 'key',
    allow: ['box'],
    deny: [
      { reach: 'computer', why: 'a key opens its user’s own wisp, never a computer' },
      { reach: 'sandbox', why: 'a key opens its user’s own wisp, never a sandbox' },
      { reach: 'preview', why: 'a key opens its user’s own wisp, never a preview' },
      { reach: 'grid:tunnel', why: 'a key opens its user’s own wisp, never a tunnel' },
      { reach: 'grid:device', why: 'a key reaches none of the grid’s own API' },
      { reach: 'grid:keys', why: 'a key can’t manage keys' },
      { reach: 'edge:keys', why: 'API keys are made from Settings, in a browser' },
      { reach: 'grid:publish', why: 'a key reaches none of the grid’s own API' },
    ],
  },
  box: {
    credential: 'box',
    allow: ['grid:channels', 'grid:mail-reply', 'grid:publish'],
    deny: [
      { reach: 'computer', why: `a box never gets a token for a laptop: ${BOX_READS}, and a prompt injection in a box must never reach a laptop` },
      { reach: 'grid:report', why: `${BOX_READS}, so it never gets as far as a computer’s report` },
      { reach: 'grid:tunnel', why: `${BOX_READS}, so it can never be a computer` },
      { reach: 'grid:keys', why: `${BOX_READS}: a cloud wisp’s person makes keys at its edge (/_grid/keys)` },
      { reach: 'grid:device', why: `${BOX_READS}: no sign-in links, no computers` },
      { reach: 'grid:route-page', why: 'the bot for `on laptop` is given on the grid’s own origin, out of a box page’s reach' },
    ],
  },
  sandbox: {
    credential: 'sandbox',
    allow: ['sandbox'],
    deny: [
      { reach: 'grid:publish', why: 'a sandbox has neither a device token nor a Box secret' },
      { reach: 'box', why: 'a sandbox’s token opens that sandbox only' },
      { reach: 'computer', why: 'a sandbox’s token opens that sandbox only' },
    ],
  },
  hook: {
    credential: 'hook',
    allow: ['box'],
    deny: [],
  },
  webhook: {
    credential: 'webhook',
    allow: ['inbox', 'route'],
    deny: [{ reach: 'box', why: 'a channel’s message is held by the grid and delivered; it never signs in to the box' }],
  },
};

export type Verdict = { ok: true } | { ok: false; why: string };

/** Whether a caller holding `credential` may reach `reach`. Deny beats allow; anything unnamed is denied. */
export function may(credential: Credential, reach: Reach): Verdict {
  const set = CAPABILITIES[credential];
  const deny = set.deny.find((d) => d.reach === reach);
  if (deny) return { ok: false, why: deny.why };
  if (set.allow.includes(reach)) return { ok: true };
  return { ok: false, why: `${credential} doesn’t reach ${reach}` };
}

// --- headers: the grid's marks -------------------------------------------------------------------
//
// A box (or a computer) trusts a few headers because only the grid sets them. So every one of them
// is dropped from what comes in from outside, on every path, before the grid adds its own.

export interface Mark {
  header: string;
  /** who sets it, and only they */
  setBy: string;
  /** which values, where it carries one */
  values?: readonly string[];
}

export const MARKS: readonly Mark[] = [
  { header: 'x-wisp-proxy-secret', setBy: 'the edge, towards a box: trusted-proxy mode (box side: boxTrust)' },
  // 'inbox' only from delivery (inbox.ts → toBox), 'key' only from the edge for an API key. A box acts
  // on these (a channel's message never counts as use; a key can't manage keys), so nothing outside
  // may claim either.
  { header: 'x-wisp-proxy-via', setBy: 'the grid: inbox delivery sets "inbox", the edge sets "key" for an API key', values: ['inbox', 'key'] },
  { header: 'x-wisp-route', setBy: 'route delivery, through a computer’s tunnel, only', values: ['grid'] },
  { header: 'x-wisp-preview', setBy: 'the preview edge: which port of the box the page is on' },
  { header: 'x-wisp-upgrade', setBy: 'the tunnel: what a websocket asked to upgrade to (HTTP/2 has no Upgrade)' },
  { header: 'x-wisp-tunnel', setBy: 'the computer’s side of its tunnel' },
];

/** Who may put x-wisp-proxy-via on a request, and with which value. */
export const VIA = { inbox: 'delivery', key: 'edge' } as const;
export type Via = keyof typeof VIA;

// Only these: a client's own x-wisp-* headers (x-wisp-relay, x-wisp-token, x-wisp-sw, x-wisp-build,
// x-wisp-session) are wisp's to read and go through to the box as they did in v1.
const MARK_NAMES: ReadonlySet<string> = new Set(MARKS.map((m) => m.header));
/** True for a header only the grid may set: one of MARKS, any x-wisp-proxy-*, or the x-forwarded-* set. */
// x-wisp-proxy-* as a whole, as v1's edge dropped it: a box reads its trusted-proxy marks by that prefix.
export const isMark = (name: string): boolean => MARK_NAMES.has(name) || name.startsWith('x-wisp-proxy') || name.startsWith('x-forwarded');

const HOP: ReadonlySet<string> = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer']);
export const isHop = (name: string): boolean => HOP.has(name);

export type Headers = Record<string, string | string[] | undefined>;

/**
 * What of an outside request goes on: no hop-by-hop header, none of the grid's marks, and no
 * sign-in of the grid's own (its cookie and bearer stay at the edge) unless asked to keep them.
 */
export function fromOutside(headers: Headers, { cookie = false, authorization = false }: { cookie?: boolean; authorization?: boolean } = {}): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || isHop(k) || isMark(k)) continue;
    if (k === 'cookie' && !cookie) continue;
    if (k === 'authorization' && !authorization) continue;
    out[k] = v;
  }
  return out;
}

/** The via mark for a request the grid itself makes: only the sources VIA names. */
export function viaHeader(via: Via, source: (typeof VIA)[Via]): Record<string, string> {
  if (VIA[via] !== source) throw new Error(`x-wisp-proxy-via: ${via} is set by ${VIA[via]}, not ${source}`);
  return { 'x-wisp-proxy-via': via };
}

// --- the box's side: trusted-proxy mode (v1 server/http/trust.js) ----------------------------------
//
// A box's wisp runs behind the edge. A request carrying the secret in x-wisp-proxy-secret came
// through the edge, which already checked who is asking: any Host is fine, and a non-GET Origin must
// be the public address (WISP_PUBLIC_URL), so a page elsewhere still can't post to it. Without the
// header the usual localhost rules apply, so the CLI and the agents' MCP keep working on the box.
// The grid's stand-in boxes run this, and apps/server's kernel HTTP option is meant to match it.

export const MIN_PROXY_SECRET = 32;

export interface BoxTrust {
  on: boolean;
  origin: string | null;
  /** Whether this request came through the edge. */
  via(headers: Headers): boolean;
  /** A non-GET Origin through the edge: the public address (or, with none set, the Host asked for). */
  originOk(headers: Headers): boolean;
}

export function boxTrust(env: Record<string, string | undefined>, { warn = (_m: string) => {} }: { warn?: (m: string) => void } = {}): BoxTrust {
  const secret = String(env['WISP_TRUSTED_PROXY_SECRET'] || '');
  if (secret && secret.length < MIN_PROXY_SECRET) warn(`wisp: WISP_TRUSTED_PROXY_SECRET is shorter than ${MIN_PROXY_SECRET} characters; trusted-proxy mode stays off`);
  const on = secret.length >= MIN_PROXY_SECRET;
  let origin: string | null = null;
  try {
    origin = env['WISP_PUBLIC_URL'] ? new URL(env['WISP_PUBLIC_URL']).origin : null;
  } catch {
    warn('wisp: WISP_PUBLIC_URL is not a URL; ignoring it');
  }
  const want = Buffer.from(secret);
  return {
    on,
    origin,
    via(headers) {
      if (!on) return false;
      const got = headers['x-wisp-proxy-secret'];
      if (typeof got !== 'string' || got.length !== secret.length) return false;
      return timingSafeEqual(Buffer.from(got), want);
    },
    originOk(headers) {
      const o = headers['origin'];
      if (typeof o !== 'string' || !o) return true;
      if (origin) return o === origin;
      const bare = o.replace(/^https?:\/\//, '');
      return bare === headers['x-forwarded-host'] || bare === headers['host'];
    },
  };
}
