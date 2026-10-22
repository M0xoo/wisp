// Users and how they get in: identities (one per provider account), browser sessions, devices
// (wisp on a computer or phone, with a bearer token), device codes (RFC 8628) and one-time
// tickets that carry a sign-in from the grid's own address to <handle>.<domain>.
//
// Every token we hand out is random; only its SHA-256 is stored.

import { randomBytes, randomInt } from 'node:crypto';
import { RESERVED } from './config.js';
import { sha256, token } from './secrets.js';

const DAY = 86_400_000;
const CODE_TTL_MS = 10 * 60_000;
const TICKET_TTL_MS = 60_000;
const USER_CODE = 'BCDFGHJKLMNPQRSTVWXZ'; // no vowels: no words; no 0/O, 1/I
export const bad = (message, status = 400) => Object.assign(new Error(message), { status });

export function createAccounts({ db, cfg, secrets, onAudit = () => {} }) {
  const now = () => Date.now();
  const audit = (userId, action, meta = {}) => {
    db.run('INSERT INTO audit (user_id, action, meta, at) VALUES (?, ?, ?, ?)', userId, action, JSON.stringify(meta), now());
    onAudit(userId, action, meta);
  };
  const userById = (id) => db.get('SELECT * FROM users WHERE id = ?', id);

  // --- who may come in ---------------------------------------------------------------------

  function allowed(idn) {
    const a = cfg.auth.allow || {};
    const emails = (a.emails || []).map((x) => x.toLowerCase());
    const domains = (a.domains || []).map((x) => x.toLowerCase().replace(/^@/, ''));
    const orgs = (a.githubOrgs || []).map((x) => x.toLowerCase());
    // "github:octocat" (login or numeric id), "google:<sub>", "oidc:corp:<sub>".
    const accounts = (a.accounts || []).map((x) => String(x).toLowerCase());
    if (!emails.length && !domains.length && !orgs.length && !accounts.length) return true;
    if (accounts.includes(`${idn.provider}:${idn.subject}`.toLowerCase()) || (idn.login && accounts.includes(`${idn.provider}:${idn.login}`.toLowerCase()))) return true;
    const email = idn.emailVerified ? idn.email : '';
    if (email && emails.includes(email)) return true;
    if (email && domains.includes(email.split('@')[1])) return true;
    if (orgs.length && (idn.orgs || []).some((o) => orgs.includes(o))) return true;
    return false;
  }

  // Room for new people: whether sign-ups are open, invite-only (an allow list), and how many of
  // maxUsers are left (null with no cap). The sign-in page and trywisp.dev (GET /api/seats) show it.
  function seats() {
    const a = cfg.auth.allow || {};
    const max = cfg.auth.maxUsers || null;
    const left = max ? Math.max(0, max - db.get('SELECT COUNT(*) AS n FROM users').n) : null;
    return { open: cfg.auth.signup !== 'closed', invite: Object.values(a).some((v) => Array.isArray(v) && v.length), max, left };
  }

  function isAdmin(userId) {
    const want = new Set((cfg.auth.admins || []).map((x) => String(x).toLowerCase()));
    if (!want.size) return false;
    const u = userById(userId);
    if (u?.email && want.has(`email:${u.email.toLowerCase()}`)) return true;
    return db.all('SELECT provider, subject FROM identities WHERE user_id = ?', userId).some((i) => want.has(`${i.provider}:${i.subject}`.toLowerCase()));
  }

  function uniqueHandle(base) {
    let h = String(base || '')
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24);
    if (h.length < 3 || RESERVED.has(h)) h = `${h || 'user'}-${randomBytes(2).toString('hex')}`.replace(/^-/, '');
    let out = h;
    for (let n = 2; db.get('SELECT 1 FROM users WHERE handle = ?', out) || RESERVED.has(out); n++) out = `${h}-${n}`;
    return out;
  }

  // The user an identity signs in as: an existing link, a new user (if sign-ups are open), or the
  // signed-in user linking it. Never by matching email: a provider that lets anyone claim an
  // address would hand over the account.
  function signIn(idn, { linkTo = null } = {}) {
    if (!idn?.subject) throw bad('The provider didn’t say who you are.');
    const found = db.get('SELECT * FROM identities WHERE provider = ? AND subject = ?', idn.provider, idn.subject);
    if (linkTo) {
      if (found && found.user_id !== linkTo) throw bad('That account already signs in to another user here.', 409);
      if (!found) db.run('INSERT INTO identities (provider, subject, user_id, email, login, created_at) VALUES (?, ?, ?, ?, ?, ?)', idn.provider, idn.subject, linkTo, idn.email || null, idn.login || null, now());
      audit(linkTo, 'identity.link', { provider: idn.provider });
      return userById(linkTo);
    }
    if (found) {
      const u = userById(found.user_id);
      if (!u || u.disabled) throw bad('This account is turned off. Ask the grid’s operator.', 403);
      if (!allowed(idn)) throw bad('This grid no longer lets this account in.', 403);
      db.run('UPDATE identities SET email = ?, login = ? WHERE provider = ? AND subject = ?', idn.email || null, idn.login || null, idn.provider, idn.subject);
      if (!u.avatar && idn.avatar) db.run('UPDATE users SET avatar = ? WHERE id = ?', idn.avatar, u.id);
      audit(u.id, 'signin', { provider: idn.provider });
      return userById(u.id);
    }
    if (cfg.auth.signup === 'closed') throw bad('Sign-ups are closed on this grid.', 403);
    if (!allowed(idn)) {
      onAudit(null, 'signup.refused', { provider: idn.provider, reason: 'not invited' });
      throw bad('This grid only lets in invited accounts, and this isn’t one of them.', 403);
    }
    // A cap on accounts (a preview, a small box): the first ones in get them, then it's full.
    if (seats().left === 0) {
      onAudit(null, 'signup.refused', { provider: idn.provider, reason: 'full' });
      throw Object.assign(bad('This grid is full for now: it has all the accounts it takes.', 403), { full: true });
    }
    const id = randomBytes(8).toString('hex');
    const handle = uniqueHandle(idn.login || (idn.email || '').split('@')[0] || 'user');
    db.tx(() => {
      db.run('INSERT INTO users (id, handle, email, name, avatar, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, handle, idn.email || null, idn.name || null, idn.avatar || null, now());
      db.run('INSERT INTO identities (provider, subject, user_id, email, login, created_at) VALUES (?, ?, ?, ?, ?, ?)', idn.provider, idn.subject, id, idn.email || null, idn.login || null, now());
      db.run("INSERT INTO instances (user_id, state, created_at) VALUES (?, 'stopped', ?)", id, now());
    });
    audit(id, 'signup', { provider: idn.provider });
    return userById(id);
  }

  function unlink(userId, provider) {
    const ids = db.all('SELECT provider FROM identities WHERE user_id = ?', userId);
    if (ids.length < 2) throw bad('Keep at least one way to sign in.');
    db.run('DELETE FROM identities WHERE user_id = ? AND provider = ?', userId, provider);
    audit(userId, 'identity.unlink', { provider });
  }

  // --- browser sessions --------------------------------------------------------------------

  // scope: 'grid' (the grid's own pages) or 'i:<user id>' (that user's wisp, at its own address).
  function createSession(userId, scope, ua = '') {
    const t = token('', 32);
    db.run('INSERT INTO sessions (id_hash, user_id, scope, created_at, expires_at, last_seen_at, ua) VALUES (?, ?, ?, ?, ?, ?, ?)', sha256(t), userId, scope, now(), now() + cfg.sessionDays * DAY, now(), String(ua).slice(0, 200));
    return t;
  }

  function session(t, scope) {
    if (!t) return null;
    const h = sha256(t);
    const s = db.get('SELECT * FROM sessions WHERE id_hash = ?', h);
    if (!s || s.scope !== scope) return null;
    if (s.expires_at < now()) {
      db.run('DELETE FROM sessions WHERE id_hash = ?', h);
      return null;
    }
    const u = userById(s.user_id);
    if (!u || u.disabled) return null;
    // Sliding: an hour of use pushes the end out again.
    if (now() - s.last_seen_at > 3_600_000) db.run('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?', now(), now() + cfg.sessionDays * DAY, h);
    return { user: u, hash: h };
  }

  const endSession = (t) => t && db.run('DELETE FROM sessions WHERE id_hash = ?', sha256(t));
  function endAll(userId) {
    db.run('DELETE FROM sessions WHERE user_id = ?', userId);
    audit(userId, 'signout.all');
  }

  // --- tickets: a sign-in carried to <handle>.<domain> --------------------------------------

  function ticket(userId) {
    const t = token('', 24);
    db.run('INSERT INTO tickets (hash, user_id, expires_at) VALUES (?, ?, ?)', sha256(t), userId, now() + TICKET_TTL_MS);
    return t;
  }

  function useTicket(t) {
    if (!t) return null;
    const h = sha256(t);
    const row = db.get('SELECT * FROM tickets WHERE hash = ?', h);
    if (!row || row.used_at || row.expires_at < now()) return null;
    db.run('UPDATE tickets SET used_at = ? WHERE hash = ?', now(), h);
    db.run('DELETE FROM tickets WHERE expires_at < ?', now() - DAY);
    return userById(row.user_id);
  }

  // --- devices and device codes (RFC 8628) -------------------------------------------------

  function deviceCode(name) {
    const n = String(name || 'A device').trim().slice(0, 60) || 'A device';
    const code = token('', 32);
    let userCode;
    do userCode = `${pick(4)}-${pick(4)}`;
    while (db.get('SELECT 1 FROM device_codes WHERE user_code = ?', userCode));
    db.run('INSERT INTO device_codes (code_hash, user_code, name, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', sha256(code), userCode, n, now(), now() + CODE_TTL_MS);
    db.run('DELETE FROM device_codes WHERE expires_at < ?', now() - DAY);
    return { device_code: code, user_code: userCode, expires_in: CODE_TTL_MS / 1000 };
  }
  const pick = (n) => Array.from({ length: n }, () => USER_CODE[randomInt(USER_CODE.length)]).join('');
  const normalCode = (c) => {
    const s = String(c || '').toUpperCase().replace(/[^A-Z]/g, '');
    return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : '';
  };

  function pendingCode(userCode) {
    const c = db.get('SELECT * FROM device_codes WHERE user_code = ?', normalCode(userCode));
    if (!c || c.expires_at < now() || c.consumed_at || c.approved_at || c.denied_at) return null;
    return c;
  }

  function answerCode(userCode, userId, allow) {
    const c = pendingCode(userCode);
    if (!c) throw bad('That code expired or was already used. Start again on the device.');
    if (allow) db.run('UPDATE device_codes SET approved_at = ?, user_id = ? WHERE code_hash = ?', now(), userId, c.code_hash);
    else db.run('UPDATE device_codes SET denied_at = ?, user_id = ? WHERE code_hash = ?', now(), userId, c.code_hash);
    audit(userId, allow ? 'device.allow' : 'device.deny', { name: c.name });
    return c;
  }

  // The device polls. RFC 8628 errors, or a device token once allowed.
  function pollCode(deviceCode, interval) {
    const h = sha256(String(deviceCode || ''));
    const c = db.get('SELECT * FROM device_codes WHERE code_hash = ?', h);
    if (!c || c.consumed_at) return { error: 'invalid_grant' };
    if (c.expires_at < now()) return { error: 'expired_token' };
    if (c.denied_at) return { error: 'access_denied' };
    if (!c.approved_at) {
      const fast = c.last_poll_at && now() - c.last_poll_at < interval * 1000 - 250;
      db.run('UPDATE device_codes SET last_poll_at = ? WHERE code_hash = ?', now(), h);
      return { error: fast ? 'slow_down' : 'authorization_pending' };
    }
    db.run('UPDATE device_codes SET consumed_at = ? WHERE code_hash = ?', now(), h);
    const t = token('wgd_', 32);
    const id = randomBytes(6).toString('hex');
    db.run('INSERT INTO devices (id, user_id, name, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)', id, c.user_id, c.name, sha256(t), now(), now());
    return { token: t, user: userById(c.user_id) };
  }

  function device(bearer) {
    const t = /^Bearer\s+(\S+)$/i.exec(String(bearer || ''))?.[1];
    if (!t) return null;
    const d = db.get('SELECT * FROM devices WHERE token_hash = ?', sha256(t));
    if (!d || d.revoked_at) return null;
    const u = userById(d.user_id);
    if (!u || u.disabled) return null;
    if (!d.last_seen_at || now() - d.last_seen_at > 60_000) db.run('UPDATE devices SET last_seen_at = ? WHERE id = ?', now(), d.id);
    return { user: u, device: d };
  }

  function revokeDevice(userId, id) {
    const r = db.run('UPDATE devices SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL', now(), id, userId);
    if (r.changes) audit(userId, 'device.revoke', { id });
    return r.changes > 0;
  }

  const devices = (userId) => db.all('SELECT id, name, created_at, last_seen_at FROM devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC', userId);
  const identities = (userId) => db.all('SELECT provider, email, login FROM identities WHERE user_id = ? ORDER BY created_at', userId);
  const byHandle = (h) => db.get('SELECT * FROM users WHERE handle = ?', String(h || '').toLowerCase());
  const instance = (userId) => db.get('SELECT * FROM instances WHERE user_id = ?', userId) || { state: 'stopped' };

  // Disabled: no session or device lets them in (set while their account is being deleted).
  const setDisabled = (userId, on) => db.run('UPDATE users SET disabled = ? WHERE id = ?', on ? 1 : 0, userId);

  // Delete a user: their sessions, devices, codes, tickets, the record of what they did, and
  // (crypto-shredded) secrets. Their box and files go first, through hostd.remove or deleteBox
  // (grid/hostd.js). What stays is one line saying an account (by its random id) was deleted.
  function remove(userId) {
    secrets.forget(userId);
    db.tx(() => {
      for (const t of ['tickets', 'device_codes', 'audit']) db.run(`DELETE FROM ${t} WHERE user_id = ?`, userId);
      db.run('DELETE FROM users WHERE id = ?', userId);
    });
    audit(userId, 'user.delete');
  }

  return { allowed, seats, isAdmin, signIn, unlink, createSession, session, endSession, endAll, ticket, useTicket, deviceCode, pendingCode, answerCode, pollCode, device, revokeDevice, devices, identities, byHandle, userById, instance, setDisabled, remove, audit, normalCode };
}
