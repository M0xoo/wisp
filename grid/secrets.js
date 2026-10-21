// The grid's keys and every secret it keeps for users. Envelope encryption: each user has a random
// data key (DEK) that seals their secrets (AES-256-GCM, bound to "user|purpose"); the DEK itself is
// stored wrapped by a master key (KEK) with a key id, so rotating the master re-wraps small keys,
// not data. Deleting a user's DEK makes everything sealed with it unreadable (crypto-shredding).
//
// The master key comes from GRID_MASTER_KEY (base64, 32 bytes), GRID_MASTER_KEY_FILE, or
// secrets/master.json in the data folder ({ current, keys: { <kid>: base64 } }, made by init).

import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

export const b64u = (buf) => Buffer.from(buf).toString('base64url');
export const sha256 = (s) => createHash('sha256').update(String(s)).digest('base64url');
export const token = (prefix = '', n = 32) => `${prefix}${b64u(randomBytes(n))}`;
export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function gcm(key, plain, aad) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  if (aad) c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return [iv, c.getAuthTag(), ct].map(b64u).join('.');
}
function ungcm(key, sealed, aad) {
  const [iv, tag, ct] = String(sealed).split('.').map((x) => Buffer.from(x, 'base64url'));
  const d = createDecipheriv('aes-256-gcm', key, iv);
  if (aad) d.setAAD(Buffer.from(aad));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

export function masterFile(dataDir) {
  return path.join(dataDir, 'secrets', 'master.json');
}

// Make the master key file if there's none (init and dev do this; production may bring its own).
export function ensureMaster(dataDir) {
  const f = masterFile(dataDir);
  if (fs.existsSync(f)) return false;
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  fs.writeFileSync(f, JSON.stringify({ current: 'k1', keys: { k1: randomBytes(32).toString('base64') } }, null, 2), { mode: 0o600 });
  return true;
}

function loadMasters(dataDir, env) {
  const one = (b64, kid) => {
    const k = Buffer.from(String(b64).trim(), 'base64');
    if (k.length !== 32) throw new Error(`The master key ${kid} isn’t 32 bytes of base64.`);
    return k;
  };
  if (env.GRID_MASTER_KEY) return { current: 'env', keys: { env: one(env.GRID_MASTER_KEY, 'env') } };
  if (env.GRID_MASTER_KEY_FILE) return { current: 'env', keys: { env: one(fs.readFileSync(env.GRID_MASTER_KEY_FILE, 'utf8'), 'env') } };
  const f = masterFile(dataDir);
  if (!fs.existsSync(f)) throw new Error(`No master key: run \`wisp grid init\`, or set GRID_MASTER_KEY(_FILE).`);
  const st = fs.statSync(f);
  if (process.platform !== 'win32' && st.mode & 0o077) throw new Error(`${f} is readable by others: chmod 600 it.`);
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const keys = Object.fromEntries(Object.entries(j.keys || {}).map(([kid, v]) => [kid, one(v, kid)]));
  if (!keys[j.current]) throw new Error(`master.json: the current key "${j.current}" isn’t in keys.`);
  return { current: j.current, keys };
}

export function createSecrets(db, { dataDir, env = process.env }) {
  const master = loadMasters(dataDir, env);
  const kek = (kid) => {
    const k = master.keys[kid];
    if (!k) throw new Error(`The master key "${kid}" that wrapped this data key is gone.`);
    return k;
  };
  // Keys derived from the master for one job each: cookie signatures, CSRF tokens.
  const derive = (label) => Buffer.from(hkdfSync('sha256', master.keys[master.current], Buffer.alloc(0), `wisp-grid ${label}`, 32));
  const signKey = derive('sign');

  function dek(userId, { create = true } = {}) {
    const row = db.get('SELECT kid, wrapped FROM keys WHERE user_id = ?', userId);
    if (row) return ungcm(kek(row.kid), row.wrapped, `dek|${userId}`);
    if (!create) return null;
    const k = randomBytes(32);
    db.run('INSERT INTO keys (user_id, kid, wrapped) VALUES (?, ?, ?)', userId, master.current, gcm(kek(master.current), k, `dek|${userId}`));
    return k;
  }

  return {
    kid: master.current,
    // HMAC for values we hand out and take back (cookies, state).
    sign: (s) => createHmac('sha256', signKey).update(String(s)).digest('base64url'),
    verify(s, sig) {
      return safeEqual(this.sign(s), sig);
    },
    seal(userId, purpose, plain) {
      const sealed = gcm(dek(userId), Buffer.from(String(plain)), `${userId}|${purpose}`);
      db.run('INSERT INTO user_secrets (user_id, purpose, sealed) VALUES (?, ?, ?) ON CONFLICT(user_id, purpose) DO UPDATE SET sealed = excluded.sealed', userId, purpose, sealed);
    },
    open(userId, purpose) {
      const row = db.get('SELECT sealed FROM user_secrets WHERE user_id = ? AND purpose = ?', userId, purpose);
      if (!row) return null;
      const k = dek(userId, { create: false });
      return k ? ungcm(k, row.sealed, `${userId}|${purpose}`).toString('utf8') : null;
    },
    // The user's secret for purpose, made once.
    ensure(userId, purpose, make = () => token('', 32)) {
      const have = this.open(userId, purpose);
      if (have) return have;
      const v = make();
      this.seal(userId, purpose, v);
      return v;
    },
    // Re-wrap every data key with the current master key. Returns how many moved.
    rewrap() {
      let n = 0;
      for (const row of db.all('SELECT user_id, kid, wrapped FROM keys WHERE kid != ?', master.current)) {
        const k = ungcm(kek(row.kid), row.wrapped, `dek|${row.user_id}`);
        db.run('UPDATE keys SET kid = ?, wrapped = ? WHERE user_id = ?', master.current, gcm(kek(master.current), k, `dek|${row.user_id}`), row.user_id);
        n++;
      }
      return n;
    },
    // Crypto-shred: the user's data key and everything sealed with it.
    forget(userId) {
      db.run('DELETE FROM user_secrets WHERE user_id = ?', userId);
      db.run('DELETE FROM keys WHERE user_id = ?', userId);
    },
  };
}

// `wisp grid rotate-key`: a new current master key; the old ones stay until every DEK is re-wrapped.
export function addMasterKey(dataDir) {
  const f = masterFile(dataDir);
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const n = Object.keys(j.keys).map((k) => Number(k.replace(/^k/, '')) || 0).reduce((a, b) => Math.max(a, b), 0) + 1;
  j.keys[`k${n}`] = randomBytes(32).toString('base64');
  j.current = `k${n}`;
  fs.writeFileSync(f, JSON.stringify(j, null, 2), { mode: 0o600 });
  return j.current;
}

// After rewrap: drop master keys no data key uses any more.
export function pruneMasterKeys(dataDir, inUse) {
  const f = masterFile(dataDir);
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const gone = Object.keys(j.keys).filter((k) => k !== j.current && !inUse.has(k));
  for (const k of gone) delete j.keys[k];
  fs.writeFileSync(f, JSON.stringify(j, null, 2), { mode: 0o600 });
  return gone;
}
