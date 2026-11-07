// What the held inbox knows of each channel (inbox.ts): what's worth keeping of its request, its event
// id, which request can't be held (live), what no box acts on (skip), and which has an edge of its own
// (Discord). Also the one way a webhook's body is read, capped and timed.

import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { sha256 } from './secrets.ts';
import { discordEdge, type EdgeAnswer, type EdgeInput } from './shared/discord-sign.ts';

export const IN_PATH = /^\/_in\/([A-Za-z0-9_-]{32,64})$/;
export const BODY_MAX = 256 * 1024;
const READ_MS = 15_000; // a body that takes longer isn't a webhook

/** A request body as JSON, loosely: each channel reads only the fields it names. */
export type Body = Record<string, unknown> | null;

export interface ChannelDef {
  /** the request's headers the box needs to check it itself */
  headers: readonly string[];
  eventId: (j: Body) => unknown;
  /** a sender checking its URL wants the box's answer in that same call */
  live?: (j: Body) => boolean;
  /** what no box acts on, so it isn't held: a wake for it would be refused and count as a strike */
  skip?: (j: Body) => boolean;
  /** its token, when it isn't the usual one */
  mint?: () => string;
  /** an answer sooner than a box can wake, checked against the key the box set */
  edge?: (input: EdgeInput) => EdgeAnswer;
  /** how long its rows last, when shorter than the inbox's hour */
  ttlMs?: number;
}

const obj = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null);

// Slack posts an edit, a deletion and wisp's own replies like any message; a file is the one subtype
// that is someone speaking (#event, the box's slack channel).
const slackNoise = (e: unknown): boolean => {
  const ev = obj(e);
  return !!ev && (!!ev['bot_id'] || (!!ev['subtype'] && ev['subtype'] !== 'file_share'));
};

export const CHANNELS: Readonly<Record<string, ChannelDef>> = {
  telegram: { headers: ['x-telegram-bot-api-secret-token'], eventId: (j) => j?.['update_id'] },
  slack: { headers: ['x-slack-signature', 'x-slack-request-timestamp'], eventId: (j) => j?.['event_id'], live: (j) => j?.['type'] === 'url_verification', skip: (j) => slackNoise(j?.['event']) },
  // Lower case: mail systems may fold a local part. 160 bits, and it fits one (64 characters at most).
  email: { headers: [], eventId: (j) => j?.['messageId'] || undefined, mint: () => randomBytes(20).toString('hex') },
  discord: { headers: ['x-signature-ed25519', 'x-signature-timestamp'], eventId: (j) => j?.['id'], edge: discordEdge, ttlMs: 15 * 60_000 }, // an interaction's token is dead by then
};

export const channelOf = (channel: string): ChannelDef => {
  const def = CHANNELS[channel];
  if (!def) throw Object.assign(new Error('not found'), { status: 404 });
  return def;
};

/** The body, or null when it's over max (read to the end and dropped, so the 200 still gets there). */
export function readCapped(req: IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let chunks: Buffer[] | null = [];
    const timer = setTimeout(() => {
      reject(new Error('body too slow'));
      req.destroy();
    }, READ_MS);
    timer.unref();
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) chunks = null;
      else chunks?.push(c);
    });
    req.on('end', () => {
      clearTimeout(timer);
      resolve(chunks && Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export const parsed = (body: Uint8Array): Body => {
  try {
    return obj(JSON.parse(Buffer.from(body).toString('utf8')));
  } catch {
    return null;
  }
};

// channel_inbox's key for a request: the channel's own event id, else the body's hash, and what it
// came with. An id alone could be taken: anyone holding the URL could post the next update_id with a
// bad secret, and the real update would hit that row and vanish. A retry that repeats both is the
// same row; one signed anew (Slack may) is a row of its own, and the box's seen list stops it. With
// an edge the id was verified here, so it's the key alone: a signature can be spelt more than one way.
export function eventKey(channel: string, j: Body, body: Uint8Array, headers: string): string {
  const def = channelOf(channel);
  const id = def.eventId(j);
  const text = id === undefined || id === null ? undefined : String(id);
  if (def.edge && id) return `${channel}:${text}`;
  return `${channel}:${text ?? createHash('sha256').update(body).digest('base64url')}:${sha256(headers)}`;
}
