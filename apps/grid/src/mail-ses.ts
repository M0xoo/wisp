// SES over SNS: the one inbound provider and the one sender mail.ts has.
//   - It signs the whole message, not a timestamp, and it's the provider with a DMARC verdict of its own.
//   - Trust comes from AWS's key, fetched from sns.<region>.amazonaws.com, or pinned in grid.json
//     (inbound.keys), and from the topic: anyone can get SNS to sign for their own topic, so a
//     signature proves nothing until TopicArn is ours. Nothing is compared to a shared secret here.
//   - SNS carries at most 150 KB of mail. Past that SES bounces it; attachments aren't kept anyway.

import { createHash, createHmac, createPublicKey, createVerify, type KeyObject } from 'node:crypto';

const SIGNED_MAX_AGE_MS = 15 * 60_000; // SNS's own retries are over in seconds
const CERTS_MAX = 8;

/** What a provider read of its webhook: null (refused), a subscription to confirm, or a message. */
export type Inbound =
  | null
  | { confirm: string }
  | {
      confirm?: undefined;
      recipients: string[];
      /** 'unproved', or why not */
      verdict: string;
      source: string;
      content: Buffer;
      /** whether content is the message's bytes as sent */
      exact: boolean;
      /** who the provider read as its From, if it says */
      named: unknown;
    };

export interface InboundProvider {
  read(raw: Buffer): Promise<Inbound>;
  confirm(url: string): Promise<unknown>;
}
export interface Sender {
  send(m: { from: string; to: string; raw: string }): Promise<void>;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (typeof v === 'object' && v !== null ? (v as Json) : null);

const SIGNED: Readonly<Record<string, readonly string[]>> = {
  Notification: ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'],
  SubscriptionConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
};

function onSns(url: unknown, region: string): URL | null {
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' && u.hostname === `sns.${region}.amazonaws.com` && !u.port && !u.username && !u.password ? u : null;
  } catch {
    return null;
  }
}

async function fetchKey(url: string): Promise<string> {
  const r = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`it said ${r.status}`);
  return r.text();
}

// SES's verdict in one word, and it's never 'pass': SES can refuse a message, not prove one. It says
// GRAY for a domain with no policy or p=none, gmail.com among them, aligned or not; its dkimVerdict
// never says which domain signed; and its DMARC PASS can rest on SPF, whose domain is the envelope's.
// So PASS and GRAY are 'unproved' until the webhook finds a signature by the From's own domain.
export function sesVerdict(receipt: unknown): string {
  const dmarc = obj(obj(receipt)?.['dmarcVerdict'])?.['status'];
  if (dmarc === 'PASS' || dmarc === 'GRAY') return 'unproved';
  if (dmarc === 'FAIL') return 'fail';
  return dmarc ? 'failed' : 'none';
}

function message(j: Json): Inbound {
  let m: Json | null;
  try {
    m = obj(JSON.parse(String(j['Message'])));
  } catch {
    return null;
  }
  const receipt = obj(m?.['receipt']);
  const action = obj(receipt?.['action']);
  const recipients = receipt?.['recipients'];
  const content = m?.['content'];
  if (m?.['notificationType'] !== 'Received' || action?.['type'] !== 'SNS' || typeof content !== 'string' || !Array.isArray(recipients)) return null;
  const exact = action['encoding'] === 'BASE64'; // UTF8 may have changed bytes a signature covers
  const mail = obj(m['mail']);
  return { recipients: recipients.map(String), verdict: sesVerdict(receipt), source: String(mail?.['source'] ?? ''), content: Buffer.from(content, exact ? 'base64' : 'utf8'), exact, named: obj(mail?.['commonHeaders'])?.['from'] };
}

export function sesInbound({ topicArn, keys = [] }: { topicArn: string; keys?: readonly string[] }, { fetchCert = fetchKey, now = () => Date.now() }: { fetchCert?: (url: string) => Promise<string>; now?: () => number } = {}): InboundProvider {
  const region = topicArn.split(':')[3] ?? '';
  const pinned = keys.map((k) => createPublicKey(k));
  const certs = new Map<string, KeyObject>();

  async function keysFor(url: string): Promise<KeyObject[]> {
    if (pinned.length) return pinned;
    let key = certs.get(url);
    if (!key) {
      certs.set(url, (key = createPublicKey(await fetchCert(url))));
      const oldest = certs.keys().next().value;
      if (certs.size > CERTS_MAX && oldest !== undefined) certs.delete(oldest);
    }
    return [key];
  }

  // Everything that costs nothing comes first: a forged request never gets as far as a fetch.
  async function verified(raw: Buffer): Promise<Json | null> {
    const j = obj(JSON.parse(raw.toString('utf8')));
    const names = j ? SIGNED[String(j['Type'])] : undefined;
    const sig = j?.['Signature'];
    if (!j || !names || j['TopicArn'] !== topicArn || j['SignatureVersion'] !== '2' || typeof sig !== 'string') return null;
    if (!(Math.abs(now() - Date.parse(String(j['Timestamp']))) <= SIGNED_MAX_AGE_MS)) return null;
    const cert = onSns(j['SigningCertURL'], region);
    if (!cert || !cert.pathname.endsWith('.pem')) return null;
    const present = names.filter((n) => n !== 'Subject' || j['Subject'] !== undefined);
    if (present.some((n) => typeof j[n] !== 'string')) return null;
    const text = present.map((n) => `${n}\n${String(j[n])}\n`).join('');
    for (const key of await keysFor(cert.href)) if (createVerify('RSA-SHA256').update(text, 'utf8').verify(key, sig, 'base64')) return j;
    return null;
  }

  return {
    async read(raw) {
      let j: Json | null;
      try {
        j = await verified(raw);
      } catch {
        return null; // unreadable, or no key to check it by: fail closed
      }
      if (!j) return null;
      if (j['Type'] === 'SubscriptionConfirmation') return onSns(j['SubscribeURL'], region) ? { confirm: String(j['SubscribeURL']) } : null;
      return message(j);
    },
    // SNS waits for this GET before it sends anything.
    confirm: (url) => fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) }),
  };
}

// SES's v2 API, raw, signed by hand (SigV4): no SDK.
export function sesSender({ region, accessKeyId, secretAccessKey, endpoint }: { region: string; accessKeyId: string; secretAccessKey?: string | undefined; endpoint?: string | undefined }): Sender {
  const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
  const hmac = (k: string | Buffer, s: string): Buffer => createHmac('sha256', k).update(s).digest();
  const url = new URL('/v2/email/outbound-emails', endpoint || `https://email.${region}.amazonaws.com`);
  return {
    async send({ from, to, raw }) {
      const body = JSON.stringify({ FromEmailAddress: from, Destination: { ToAddresses: [to] }, Content: { Raw: { Data: Buffer.from(raw).toString('base64') } } });
      const stamp = new Date().toISOString().replace(/[-:]|\.\d+/g, '');
      const day = stamp.slice(0, 8);
      const scope = `${day}/${region}/ses/aws4_request`;
      const signed = 'content-type;host;x-amz-date';
      const canon = ['POST', url.pathname, '', 'content-type:application/json', `host:${url.host}`, `x-amz-date:${stamp}`, '', signed, sha(body)].join('\n');
      const key = [day, region, 'ses', 'aws4_request'].reduce<string | Buffer>(hmac, `AWS4${secretAccessKey ?? ''}`);
      const signature = hmac(key, ['AWS4-HMAC-SHA256', stamp, scope, sha(canon)].join('\n')).toString('hex');
      const r = await fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(15_000), headers: { 'content-type': 'application/json', 'x-amz-date': stamp, authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}` } });
      if (!r.ok) throw new Error(`SES said ${r.status}`);
    },
  };
}
