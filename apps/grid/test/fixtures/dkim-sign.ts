// A DKIM signer for tests, written apart from src/dkim.ts so a verifier bug can't hide in shared code.
// The RFC 8463 vectors in test/dkim.test.ts are what proves the two agree with the rest of the world.

import { createHash, createSign, sign as signRaw, type KeyObject } from 'node:crypto';

const sha = (name: string, s: string): string => createHash(name).update(Buffer.from(s, 'latin1')).digest('base64');

function relaxedField(f: string): string {
  const c = f.indexOf(':');
  return `${f.slice(0, c).replace(/[ \t]+$/, '').toLowerCase()}:${f.slice(c + 1).replace(/\r\n(?=[ \t])/g, '').replace(/[ \t]+/g, ' ').trim()}`;
}

function bodyOf(body: string, how: string): string {
  if (how === 'simple') {
    const t = body.replace(/(?:\r\n)+$/, '');
    return `${t}\r\n`;
  }
  const lines = body.split('\r\n').map((l) => l.replace(/[ \t]+/g, ' ').replace(/ $/, ''));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.length ? `${lines.join('\r\n')}\r\n` : '';
}

const fieldsOf = (head: string): string[] => head.split(/\r\n(?![ \t])/);

export interface SignOptions {
  d: string;
  s?: string;
  key: KeyObject;
  a?: string;
  c?: string;
  h?: string;
  l?: true | number;
  tags?: string;
  fold?: boolean;
  noC?: boolean;
  noV?: boolean;
}

// raw: a CRLF message. Returns it with a DKIM-Signature on top. `tags` go in as written, after the
// usual ones; `l: true` signs the whole canonical body and says so; `fold` wraps the signature's tags.
export function dkimSign(raw: string, { d, s = 'sel', key, a = 'ed25519-sha256', c = 'relaxed/relaxed', h = 'from:to:subject:date:message-id', l, tags = '', fold = false, noC = false, noV = false }: SignOptions): string {
  const at = raw.indexOf('\r\n\r\n');
  const head = raw.slice(0, at);
  const body = raw.slice(at + 4);
  const [hc, bc = 'simple'] = c.split('/');
  const hash = a.endsWith('sha1') ? 'sha1' : 'sha256';
  let canon = bodyOf(body, bc);
  const parts = [...(noV ? [] : ['v=1']), `a=${a}`, ...(noC ? [] : [`c=${c}`]), `d=${d}`, `s=${s}`, `h=${h}`];
  if (l !== undefined) {
    const n = l === true ? canon.length : l;
    parts.push(`l=${n}`);
    canon = canon.slice(0, n);
  }
  parts.push(`bh=${sha(hash, canon)}`);
  if (tags) parts.push(tags);
  const sep = fold ? ';\r\n\t' : '; ';
  const field = `DKIM-Signature: ${parts.join(sep)}${sep}b=`;

  const pool = fieldsOf(head);
  const nameOf = (f: string): string => f.slice(0, f.indexOf(':')).trim().toLowerCase();
  let data = '';
  for (const name of h.split(':').map((n) => n.trim().toLowerCase())) {
    const i = pool.findLastIndex((f) => nameOf(f) === name);
    if (i < 0) continue;
    const [f = ''] = pool.splice(i, 1);
    data += `${hc === 'relaxed' ? relaxedField(f) : f}\r\n`;
  }
  data += hc === 'relaxed' ? relaxedField(field) : field;
  const bytes = Buffer.from(data, 'latin1');
  const sig =
    a === 'ed25519-sha256'
      ? signRaw(null, createHash('sha256').update(bytes).digest(), key).toString('base64')
      : createSign(a === 'rsa-sha1' ? 'RSA-SHA1' : 'RSA-SHA256').update(bytes).sign(key, 'base64');
  return `${field}${sig}\r\n${raw}`;
}

// The TXT record of a public key, as DNS gives it to resolveTxt: [[chunk, …]].
export function keyRecord(publicKey: KeyObject, more = ''): string[][] {
  const kind = publicKey.asymmetricKeyType;
  const der = publicKey.export({ format: 'der', type: 'spki' });
  const p = (kind === 'ed25519' ? der.subarray(-32) : der).toString('base64');
  const text = `v=DKIM1; k=${kind}; ${more ? `${more}; ` : ''}p=${p}`;
  return [text.match(/.{1,255}/g) ?? []];
}
