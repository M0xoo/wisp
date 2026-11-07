// The grid's keys and every secret it keeps for users. Envelope encryption: each user has a random
// data key (DEK) that seals their secrets (AES-256-GCM, bound to "user|purpose"); the DEK itself is
// stored wrapped by a master key (KEK) with a key id, so rotating the master re-wraps small keys,
// not data. Deleting a user's DEK makes everything sealed with it unreadable (crypto-shredding).
//
// The master key comes from GRID_MASTER_KEY (base64, 32 bytes), GRID_MASTER_KEY_FILE, or
// secrets/master.json in the data folder ({ current, keys: { <kid>: base64 } }, made by init).
// Read at start and by the CLI, so the fs calls here are sync on purpose.

import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from './db.ts';

export const b64u = (buf: Uint8Array | string): string => Buffer.from(buf).toString('base64url');
export const sha256 = (s: unknown): string => createHash('sha256').update(String(s)).digest('base64url');
export const token = (prefix = '', n = 32): string => `${prefix}${b64u(randomBytes(n))}`;
export function safeEqual(a: unknown, b: unknown): boolean {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function gcm(key: Buffer, plain: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return [iv, c.getAuthTag(), ct].map(b64u).join('.');
}
function ungcm(key: Buffer, sealed: string, aad: string): Buffer {
  const [iv, tag, ct] = String(sealed).split('.').map((x) => Buffer.from(x, 'base64url'));
  if (!iv || !tag || !ct) throw new Error('A sealed secret is damaged.');
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

export function masterFile(dataDir: string): string {
  return path.join(dataDir, 'secrets', 'master.json');
}

/** Make the master key file if there's none (init and dev do this; production may bring its own). */
export function ensureMaster(dataDir: string): boolean {
  const f = masterFile(dataDir);
  if (fs.existsSync(f)) return false;
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  fs.writeFileSync(f, JSON.stringify({ current: 'k1', keys: { k1: randomBytes(32).toString('base64') } }, null, 2), { mode: 0o600 });
  return true;
}

interface Masters {
  current: string;
  keys: Record<string, Buffer>;
}
interface MasterJson {
  current: string;
  keys: Record<string, string>;
}

const readMasterJson = (f: string): MasterJson => {
  const j: unknown = JSON.parse(fs.readFileSync(f, 'utf8'));
  const o = (typeof j === 'object' && j !== null ? j : {}) as Partial<MasterJson>;
  return { current: String(o.current ?? ''), keys: { ...(o.keys ?? {}) } };
};

function loadMasters(dataDir: string, env: NodeJS.ProcessEnv): Masters {
  const one = (b64: string, kid: string): Buffer => {
    const k = Buffer.from(String(b64).trim(), 'base64');
    if (k.length !== 32) throw new Error(`The master key ${kid} isn’t 32 bytes of base64.`);
    return k;
  };
  const fromEnv = env['GRID_MASTER_KEY'];
  if (fromEnv) return { current: 'env', keys: { env: one(fromEnv, 'env') } };
  const envFile = env['GRID_MASTER_KEY_FILE'];
  if (envFile) return { current: 'env', keys: { env: one(fs.readFileSync(envFile, 'utf8'), 'env') } };
  const f = masterFile(dataDir);
  if (!fs.existsSync(f)) throw new Error('No master key: run `wisp grid init`, or set GRID_MASTER_KEY(_FILE).');
  const st = fs.statSync(f);
  if (process.platform !== 'win32' && st.mode & 0o077) throw new Error(`${f} is readable by others: chmod 600 it.`);
  const j = readMasterJson(f);
  const keys = Object.fromEntries(Object.entries(j.keys).map(([kid, v]) => [kid, one(v, kid)]));
  if (!keys[j.current]) throw new Error(`master.json: the current key "${j.current}" isn’t in keys.`);
  return { current: j.current, keys };
}

export interface Secrets {
  readonly kid: string;
  /** HMAC for values we hand out and take back (cookies, state). */
  sign(s: unknown): string;
  verify(s: unknown, sig: string): boolean;
  seal(userId: string, purpose: string, plain: string): void;
  open(userId: string, purpose: string): string | null;
  drop(userId: string, purpose: string): void;
  /** The user's secret for purpose, made once. */
  ensure(userId: string, purpose: string, make?: () => string): string;
  /** Re-wrap every data key with the current master key. Returns how many moved. */
  rewrap(): number;
  /** Crypto-shred: the user's data key and everything sealed with it. */
  forget(userId: string): void;
}

export function createSecrets(db: Db, { dataDir, env = process.env }: { dataDir: string; env?: NodeJS.ProcessEnv }): Secrets {
  const master = loadMasters(dataDir, env);
  const kek = (kid: string): Buffer => {
    const k = master.keys[kid];
    if (!k) throw new Error(`The master key "${kid}" that wrapped this data key is gone.`);
    return k;
  };
  // Keys derived from the master for one job each: cookie signatures, CSRF tokens.
  const derive = (label: string): Buffer => Buffer.from(hkdfSync('sha256', kek(master.current), Buffer.alloc(0), `wisp-grid ${label}`, 32));
  const signKey = derive('sign');

  function dek(userId: string, create = true): Buffer | null {
    const row = db.get<{ kid: string; wrapped: string }>('SELECT kid, wrapped FROM keys WHERE user_id = ?', userId);
    if (row) return ungcm(kek(row.kid), row.wrapped, `dek|${userId}`);
    if (!create) return null;
    const k = randomBytes(32);
    db.run('INSERT INTO keys (user_id, kid, wrapped) VALUES (?, ?, ?)', userId, master.current, gcm(kek(master.current), k, `dek|${userId}`));
    return k;
  }
  const sign = (s: unknown): string => createHmac('sha256', signKey).update(String(s)).digest('base64url');
  const open = (userId: string, purpose: string): string | null => {
    const row = db.get<{ sealed: string }>('SELECT sealed FROM user_secrets WHERE user_id = ? AND purpose = ?', userId, purpose);
    if (!row) return null;
    const k = dek(userId, false);
    return k ? ungcm(k, row.sealed, `${userId}|${purpose}`).toString('utf8') : null;
  };
  const seal = (userId: string, purpose: string, plain: string): void => {
    const k = dek(userId);
    if (!k) throw new Error('No data key.'); // dek() with create never returns null
    const sealed = gcm(k, Buffer.from(String(plain)), `${userId}|${purpose}`);
    db.run('INSERT INTO user_secrets (user_id, purpose, sealed) VALUES (?, ?, ?) ON CONFLICT(user_id, purpose) DO UPDATE SET sealed = excluded.sealed', userId, purpose, sealed);
  };

  return {
    kid: master.current,
    sign,
    verify: (s, sig) => safeEqual(sign(s), sig),
    seal,
    open,
    drop(userId, purpose) {
      db.run('DELETE FROM user_secrets WHERE user_id = ? AND purpose = ?', userId, purpose);
    },
    ensure(userId, purpose, make = () => token('', 32)) {
      const have = open(userId, purpose);
      if (have) return have;
      const v = make();
      seal(userId, purpose, v);
      return v;
    },
    rewrap() {
      let n = 0;
      for (const row of db.all<{ user_id: string; kid: string; wrapped: string }>('SELECT user_id, kid, wrapped FROM keys WHERE kid != ?', master.current)) {
        const k = ungcm(kek(row.kid), row.wrapped, `dek|${row.user_id}`);
        db.run('UPDATE keys SET kid = ?, wrapped = ? WHERE user_id = ?', master.current, gcm(kek(master.current), k, `dek|${row.user_id}`), row.user_id);
        n++;
      }
      return n;
    },
    forget(userId) {
      db.run('DELETE FROM user_secrets WHERE user_id = ?', userId);
      db.run('DELETE FROM keys WHERE user_id = ?', userId);
    },
  };
}

/** `wisp grid rotate-key`: a new current master key; the old ones stay until every DEK is re-wrapped. */
export function addMasterKey(dataDir: string): string {
  const f = masterFile(dataDir);
  const j = readMasterJson(f);
  const n = Object.keys(j.keys).map((k) => Number(k.replace(/^k/, '')) || 0).reduce((a, b) => Math.max(a, b), 0) + 1;
  j.keys[`k${n}`] = randomBytes(32).toString('base64');
  j.current = `k${n}`;
  fs.writeFileSync(f, JSON.stringify(j, null, 2), { mode: 0o600 });
  return j.current;
}

/** After rewrap: drop master keys no data key uses any more. */
export function pruneMasterKeys(dataDir: string, inUse: ReadonlySet<string>): string[] {
  const f = masterFile(dataDir);
  const j = readMasterJson(f);
  const gone = Object.keys(j.keys).filter((k) => k !== j.current && !inUse.has(k));
  for (const k of gone) delete j.keys[k];
  fs.writeFileSync(f, JSON.stringify(j, null, 2), { mode: 0o600 });
  return gone;
}
