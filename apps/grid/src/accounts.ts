// Users and how they get in: identities (one per provider account), browser sessions, devices
// (wisp on a computer or phone, with a bearer token), device codes (RFC 8628) and one-time
// tickets that carry a sign-in from the grid's own address to <handle>.<domain>, and computers
// (a device's own wisp, added to the grid and reached at <name>--<handle>.<domain>), and API keys
// (a script's way in to the user's own wisp, and nowhere else). Seats and the waitlist: seats.ts.
//
// Every token we hand out is random; only its SHA-256 is stored.

import { randomBytes, randomInt } from 'node:crypto';
import { RESERVED, type GridConfig } from './config.ts';
import type { Db } from './db.ts';
import { bad } from './errors.ts';
import type { ApiKeyRow, ComputerRow, CountRow, DeviceCodeRow, DeviceRow, IdentityRow, InstanceRow, SessionRow, TicketRow, UserRow } from './rows.ts';
import { DAY, createSeats, type Audit } from './seats.ts';
import { sha256, token, type Secrets } from './secrets.ts';

export { MACHINE_WANTS } from './seats.ts';
export { bad } from './errors.ts';

const CODE_TTL_MS = 10 * 60_000;
const TICKET_TTL_MS = 60_000;
const USER_CODE = 'BCDFGHJKLMNPQRSTVWXZ'; // no vowels: no words; no 0/O, 1/I
const MAX_API_KEYS = 20; // live ones, per user

/** Who a provider says signed in (auth/providers.ts). */
export interface Identity {
  provider: string;
  subject: string;
  email?: string | undefined;
  emailVerified?: boolean | undefined;
  name?: string | undefined;
  login?: string | undefined;
  avatar?: string | undefined;
  orgs?: string[] | undefined;
}

export interface SessionOf {
  user: UserRow;
  hash: string;
}
export interface DeviceOf {
  user: UserRow;
  device: DeviceRow;
}
export type ApiKeyView = Pick<ApiKeyRow, 'id' | 'name' | 'hint' | 'created_at' | 'last_used_at'>;

const bearerOf = (bearer: unknown): string | undefined => /^Bearer\s+(\S+)$/i.exec(String(bearer || ''))?.[1];

export function createAccounts({ db, cfg, secrets, onAudit = () => {} }: { db: Db; cfg: GridConfig; secrets: Secrets; onAudit?: Audit }) {
  const now = (): number => Date.now();
  const audit: Audit = (userId, action, meta = {}) => {
    db.run('INSERT INTO audit (user_id, action, meta, at) VALUES (?, ?, ?, ?)', userId, action, JSON.stringify(meta), now());
    onAudit(userId, action, meta);
  };
  const seats = createSeats({ db, cfg, audit });
  const userById = (id: unknown): UserRow | undefined => db.get<UserRow>('SELECT * FROM users WHERE id = ?', String(id));
  const byHandle = (h: unknown): UserRow | undefined => db.get<UserRow>('SELECT * FROM users WHERE handle = ?', String(h || '').toLowerCase());
  const mustUser = (id: string): UserRow => {
    const u = userById(id);
    if (!u) throw bad('No such account.', 404);
    return u;
  };

  // --- who may come in ---------------------------------------------------------------------

  function allowed(idn: Identity): boolean {
    const a = cfg.auth.allow || {};
    const emails = (a.emails || []).map((x) => x.toLowerCase());
    const domains = (a.domains || []).map((x) => x.toLowerCase().replace(/^@/, ''));
    const orgs = (a.githubOrgs || []).map((x) => x.toLowerCase());
    // "github:octocat" (login or numeric id), "google:<sub>", "oidc:corp:<sub>".
    const accounts = (a.accounts || []).map((x) => String(x).toLowerCase());
    if (!emails.length && !domains.length && !orgs.length && !accounts.length) return true;
    if (accounts.includes(`${idn.provider}:${idn.subject}`.toLowerCase()) || (idn.login && accounts.includes(`${idn.provider}:${idn.login}`.toLowerCase()))) return true;
    const email = idn.emailVerified ? idn.email || '' : '';
    if (email && emails.includes(email)) return true;
    if (email && domains.includes(email.split('@')[1] ?? '')) return true;
    return orgs.length > 0 && (idn.orgs || []).some((o) => orgs.includes(o));
  }

  function isAdmin(userId: string): boolean {
    const want = new Set((cfg.auth.admins || []).map((x) => String(x).toLowerCase()));
    if (!want.size) return false;
    const u = userById(userId);
    if (u?.email && want.has(`email:${u.email.toLowerCase()}`)) return true;
    return db.all<IdentityRow>('SELECT provider, subject FROM identities WHERE user_id = ?', userId).some((i) => want.has(`${i.provider}:${i.subject}`.toLowerCase()));
  }

  function uniqueHandle(base: string): string {
    let h = String(base || '')
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-{2,}/g, '-') // "--" separates a computer's name from its owner's handle
      .replace(/^-+|-+$/g, '')
      .slice(0, 24);
    if (h.length < 3 || RESERVED.has(h)) h = `${h || 'user'}-${randomBytes(2).toString('hex')}`.replace(/^-/, '');
    let out = h;
    for (let n = 2; db.get('SELECT 1 FROM users WHERE handle = ?', out) || RESERVED.has(out); n++) out = `${h}-${n}`;
    return out;
  }

  function linkIdentity(idn: Identity, linkTo: string, found: IdentityRow | undefined): UserRow {
    if (found && found.user_id !== linkTo) throw bad('That account already signs in to another user here.', 409);
    if (!found) db.run('INSERT INTO identities (provider, subject, user_id, email, login, created_at) VALUES (?, ?, ?, ?, ?, ?)', idn.provider, idn.subject, linkTo, idn.email || null, idn.login || null, now());
    audit(linkTo, 'identity.link', { provider: idn.provider });
    return mustUser(linkTo);
  }

  function returning(idn: Identity, found: IdentityRow): UserRow {
    const u = userById(found.user_id);
    if (!u || u.disabled) throw bad('This account is turned off. Ask the grid’s operator.', 403);
    if (!allowed(idn)) throw bad('This grid no longer lets this account in.', 403);
    db.run('UPDATE identities SET email = ?, login = ? WHERE provider = ? AND subject = ?', idn.email || null, idn.login || null, idn.provider, idn.subject);
    if (!u.avatar && idn.avatar) db.run('UPDATE users SET avatar = ? WHERE id = ?', idn.avatar, u.id);
    audit(u.id, 'signin', { provider: idn.provider });
    return mustUser(u.id);
  }

  function signUp(idn: Identity): UserRow {
    if (cfg.auth.signup === 'closed') throw bad('Sign-ups are closed on this grid.', 403);
    if (!allowed(idn)) {
      onAudit(null, 'signup.refused', { provider: idn.provider, reason: 'not invited' });
      throw bad('This grid only lets in invited accounts, and this isn’t one of them.', 403);
    }
    // A cap on accounts (a preview, a small box): the first ones in get them, then it's full,
    // except for people the waitlist has a seat held for. The rest go on it.
    const email = idn.emailVerified && idn.email ? String(idn.email).toLowerCase() : '';
    if (!seats.invited(email) && seats.seats().left === 0) {
      onAudit(null, 'signup.refused', { provider: idn.provider, reason: 'full' });
      if (email) seats.waitFor(email, 'signin');
      throw Object.assign(bad('This grid is full for now: it has all the accounts it takes.', 403), { full: true, waitlisted: !!email });
    }
    const id = randomBytes(8).toString('hex');
    const handle = uniqueHandle(idn.login || (idn.email || '').split('@')[0] || 'user');
    db.tx(() => {
      db.run('INSERT INTO users (id, handle, email, name, avatar, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, handle, idn.email || null, idn.name || null, idn.avatar || null, now());
      db.run('INSERT INTO identities (provider, subject, user_id, email, login, created_at) VALUES (?, ?, ?, ?, ?, ?)', idn.provider, idn.subject, id, idn.email || null, idn.login || null, now());
      db.run("INSERT INTO instances (user_id, state, created_at) VALUES (?, 'stopped', ?)", id, now());
      if (email) db.run('UPDATE waitlist SET joined_at = ?, user_id = ? WHERE email = ?', now(), id, email);
    });
    audit(id, 'signup', { provider: idn.provider });
    return mustUser(id);
  }

  // The user an identity signs in as: an existing link, a new user (if sign-ups are open), or the
  // signed-in user linking it. Never by matching email: a provider that lets anyone claim an
  // address would hand over the account.
  function signIn(idn: Identity, { linkTo = null }: { linkTo?: string | null } = {}): UserRow {
    if (!idn?.subject) throw bad('The provider didn’t say who you are.');
    const found = db.get<IdentityRow>('SELECT * FROM identities WHERE provider = ? AND subject = ?', idn.provider, idn.subject);
    if (linkTo) return linkIdentity(idn, linkTo, found);
    return found ? returning(idn, found) : signUp(idn);
  }

  function unlink(userId: string, provider: string): void {
    const ids = db.all('SELECT provider FROM identities WHERE user_id = ?', userId);
    if (ids.length < 2) throw bad('Keep at least one way to sign in.');
    db.run('DELETE FROM identities WHERE user_id = ? AND provider = ?', userId, provider);
    audit(userId, 'identity.unlink', { provider });
  }

  // --- browser sessions --------------------------------------------------------------------

  // scope: 'grid' (the grid's own pages), 'i:<user id>' (that user's wisp, at its own address) or
  // 'p:<label>' (the preview addresses of that box or computer).
  function createSession(userId: string, scope: string, ua: unknown = ''): string {
    const t = token('', 32);
    db.run('INSERT INTO sessions (id_hash, user_id, scope, created_at, expires_at, last_seen_at, ua) VALUES (?, ?, ?, ?, ?, ?, ?)', sha256(t), userId, scope, now(), now() + cfg.sessionDays * DAY, now(), String(ua ?? '').slice(0, 200));
    return t;
  }

  function session(t: string | undefined, scope: string): SessionOf | null {
    if (!t) return null;
    const h = sha256(t);
    const s = db.get<SessionRow>('SELECT * FROM sessions WHERE id_hash = ?', h);
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

  const endSession = (t: string | undefined): void => void (t && db.run('DELETE FROM sessions WHERE id_hash = ?', sha256(t)));
  function endAll(userId: string): void {
    db.run('DELETE FROM sessions WHERE user_id = ?', userId);
    audit(userId, 'signout.all');
  }

  // --- tickets: a sign-in carried to <handle>.<domain> --------------------------------------

  // scope 'preview:<label>': opens that label's preview addresses and nothing else. None: the
  // user's wisp, computers and sandboxes, never a preview address.
  function ticket(userId: string, scope: string | null = null): string {
    const t = token('', 24);
    db.run('INSERT INTO tickets (hash, user_id, expires_at, scope) VALUES (?, ?, ?, ?)', sha256(t), userId, now() + TICKET_TTL_MS, scope);
    return t;
  }

  // preview: the label, when the caller is a preview address. A ticket for somewhere else is
  // refused and not spent.
  function useTicket(t: string | null | undefined, { preview = null }: { preview?: string | null } = {}): UserRow | null {
    if (!t) return null;
    const h = sha256(t);
    const row = db.get<TicketRow>('SELECT * FROM tickets WHERE hash = ?', h);
    if (!row || row.used_at || row.expires_at < now()) return null;
    if (row.scope !== (preview ? `preview:${preview}` : null)) return null;
    db.run('UPDATE tickets SET used_at = ? WHERE hash = ?', now(), h);
    db.run('DELETE FROM tickets WHERE expires_at < ?', now() - DAY);
    return userById(row.user_id) ?? null;
  }

  // --- devices and device codes (RFC 8628) -------------------------------------------------

  const pick = (n: number): string => Array.from({ length: n }, () => USER_CODE[randomInt(USER_CODE.length)]).join('');
  const normalCode = (c: unknown): string => {
    const s = String(c || '').toUpperCase().replace(/[^A-Z]/g, '');
    return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : '';
  };

  function deviceCode(name: unknown): { device_code: string; user_code: string; expires_in: number } {
    const n = String(name || 'A device').trim().slice(0, 60) || 'A device';
    const code = token('', 32);
    let userCode: string;
    do userCode = `${pick(4)}-${pick(4)}`;
    while (db.get('SELECT 1 FROM device_codes WHERE user_code = ?', userCode));
    db.run('INSERT INTO device_codes (code_hash, user_code, name, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', sha256(code), userCode, n, now(), now() + CODE_TTL_MS);
    db.run('DELETE FROM device_codes WHERE expires_at < ?', now() - DAY);
    return { device_code: code, user_code: userCode, expires_in: CODE_TTL_MS / 1000 };
  }

  function pendingCode(userCode: unknown): DeviceCodeRow | null {
    const c = db.get<DeviceCodeRow>('SELECT * FROM device_codes WHERE user_code = ?', normalCode(userCode));
    if (!c || c.expires_at < now() || c.consumed_at || c.approved_at || c.denied_at) return null;
    return c;
  }

  function answerCode(userCode: unknown, userId: string, allow: boolean): DeviceCodeRow {
    const c = pendingCode(userCode);
    if (!c) throw bad('That code expired or was already used. Start again on the device.');
    if (allow) db.run('UPDATE device_codes SET approved_at = ?, user_id = ? WHERE code_hash = ?', now(), userId, c.code_hash);
    else db.run('UPDATE device_codes SET denied_at = ?, user_id = ? WHERE code_hash = ?', now(), userId, c.code_hash);
    audit(userId, allow ? 'device.allow' : 'device.deny', { name: c.name });
    return c;
  }

  // The device polls. RFC 8628 errors, or a device token once allowed.
  function pollCode(code: unknown, interval: number): { error: string } | { error?: undefined; token: string; user: UserRow } {
    const h = sha256(String(code || ''));
    const c = db.get<DeviceCodeRow>('SELECT * FROM device_codes WHERE code_hash = ?', h);
    if (!c || c.consumed_at) return { error: 'invalid_grant' };
    if (c.expires_at < now()) return { error: 'expired_token' };
    if (c.denied_at) return { error: 'access_denied' };
    if (!c.approved_at || !c.user_id) {
      const fast = !!c.last_poll_at && now() - c.last_poll_at < interval * 1000 - 250;
      db.run('UPDATE device_codes SET last_poll_at = ? WHERE code_hash = ?', now(), h);
      return { error: fast ? 'slow_down' : 'authorization_pending' };
    }
    db.run('UPDATE device_codes SET consumed_at = ? WHERE code_hash = ?', now(), h);
    const t = token('wgd_', 32);
    const id = randomBytes(6).toString('hex');
    db.run('INSERT INTO devices (id, user_id, name, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)', id, c.user_id, c.name, sha256(t), now(), now());
    return { token: t, user: mustUser(c.user_id) };
  }

  function device(bearer: unknown): DeviceOf | null {
    const t = bearerOf(bearer);
    if (!t) return null;
    const d = db.get<DeviceRow>('SELECT * FROM devices WHERE token_hash = ?', sha256(t));
    if (!d || d.revoked_at) return null;
    const u = userById(d.user_id);
    if (!u || u.disabled) return null;
    if (!d.last_seen_at || now() - d.last_seen_at > 60_000) db.run('UPDATE devices SET last_seen_at = ? WHERE id = ?', now(), d.id);
    return { user: u, device: d };
  }

  // A revoked device's computer goes with it: it can't hold its tunnel any more.
  function revokeDevice(userId: string, id: string): boolean {
    const r = db.run('UPDATE devices SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL', now(), id, userId);
    if (r.changes) audit(userId, 'device.revoke', { id });
    db.run('DELETE FROM computers WHERE device_id = ? AND user_id = ?', id, userId);
    return Number(r.changes) > 0;
  }

  // --- API keys: a script's way in to the user's own wisp -------------------------------------
  //
  // Apart from devices on purpose: device() never takes a key, so a key opens only what the edge
  // lets it (trust.ts: 'apikey'), and none of the grid's own API (sign-in links, computers, …).

  function createApiKey(userId: string, name: unknown): ApiKeyView & { key: string } {
    const n = typeof name === 'string' ? name.trim() : '';
    if (!n) throw bad('Give the key a name.');
    if (n.length > 60) throw bad('Keep a key’s name to 60 characters.');
    const live = db.get<CountRow>('SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND revoked_at IS NULL', userId)?.n ?? 0;
    if (live >= MAX_API_KEYS) throw bad(`You have ${MAX_API_KEYS} API keys, the most a grid keeps. Revoke one first.`, 409);
    const t = token('wgk_', 32);
    const row = { id: randomBytes(6).toString('hex'), name: n, hint: t.slice(-4), created_at: now(), last_used_at: null };
    db.run('INSERT INTO api_keys (id, user_id, name, token_hash, hint, created_at) VALUES (?, ?, ?, ?, ?, ?)', row.id, userId, row.name, sha256(t), row.hint, row.created_at);
    audit(userId, 'apikey.create', { id: row.id });
    return { ...row, key: t };
  }

  function apiKey(bearer: unknown): { user: UserRow; key: ApiKeyRow } | null {
    const t = bearerOf(bearer);
    if (!t) return null;
    const k = db.get<ApiKeyRow>('SELECT * FROM api_keys WHERE token_hash = ?', sha256(t));
    if (!k || k.revoked_at) return null;
    const u = userById(k.user_id);
    if (!u || u.disabled) return null;
    if (!k.last_used_at || now() - k.last_used_at > 60_000) db.run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', now(), k.id);
    return { user: u, key: k };
  }

  const apiKeys = (userId: string): ApiKeyView[] => db.all<ApiKeyView>('SELECT id, name, hint, created_at, last_used_at FROM api_keys WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC, rowid DESC', userId);

  function revokeApiKey(userId: string, id: string): boolean {
    const r = db.run('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL', now(), id, userId);
    if (r.changes) audit(userId, 'apikey.revoke', { id });
    return Number(r.changes) > 0;
  }

  // --- computers: a device's own wisp, reached through the grid ------------------------------

  // The device's computer (one each), added or renamed. Its label is its address under the
  // domain: "<name>--<handle>", never a handle (handles have no "--" since computers came).
  function addComputer(dev: DeviceOf, name: unknown): ComputerRow {
    const n = String(name || '').trim().slice(0, 40) || 'Computer';
    const have = db.get<ComputerRow>('SELECT * FROM computers WHERE device_id = ?', dev.device.id);
    if (have) {
      if (have.name !== n) db.run('UPDATE computers SET name = ? WHERE id = ?', n, have.id);
      return { ...have, name: n };
    }
    const slug =
      n
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 20)
        .replace(/-+$/, '')
        .replace(/^(p\d+|sb-[a-f0-9]{8})$/, '$1-pc') || 'computer'; // "p5173--<handle>" is a preview's address, "sb-<id>--<handle>" a sandbox's
    let label = `${slug}--${dev.user.handle}`;
    for (let k = 2; db.get('SELECT 1 FROM computers WHERE label = ?', label) || byHandle(label); k++) label = `${slug}-${k}--${dev.user.handle}`;
    const c: ComputerRow = { id: randomBytes(6).toString('hex'), user_id: dev.user.id, device_id: dev.device.id, name: n, label, created_at: now(), last_seen_at: null };
    db.run('INSERT INTO computers (id, user_id, device_id, name, label, created_at) VALUES (?, ?, ?, ?, ?, ?)', c.id, c.user_id, c.device_id, c.name, c.label, c.created_at);
    audit(dev.user.id, 'computer.add', { id: c.id });
    return c;
  }
  const computers = (userId: string): ComputerRow[] => db.all<ComputerRow>('SELECT * FROM computers WHERE user_id = ? ORDER BY created_at', userId);
  const computer = (id: unknown): ComputerRow | undefined => db.get<ComputerRow>('SELECT * FROM computers WHERE id = ?', String(id || ''));
  const computerByLabel = (label: unknown): ComputerRow | undefined => db.get<ComputerRow>('SELECT * FROM computers WHERE label = ?', String(label || '').toLowerCase());
  const seenComputer = (id: string): void => void db.run('UPDATE computers SET last_seen_at = ? WHERE id = ?', now(), id);
  function removeComputer(userId: string, id: string): boolean {
    const r = db.run('DELETE FROM computers WHERE id = ? AND user_id = ?', id, userId);
    if (r.changes) audit(userId, 'computer.remove', { id });
    return Number(r.changes) > 0;
  }

  const devices = (userId: string) => db.all<Pick<DeviceRow, 'id' | 'name' | 'created_at' | 'last_seen_at'>>('SELECT id, name, created_at, last_seen_at FROM devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC', userId);
  const identities = (userId: string) => db.all<Pick<IdentityRow, 'provider' | 'email' | 'login'>>('SELECT provider, email, login FROM identities WHERE user_id = ? ORDER BY created_at', userId);
  const instance = (userId: string): Partial<InstanceRow> & { state: string } => db.get<InstanceRow>('SELECT * FROM instances WHERE user_id = ?', userId) || { state: 'stopped' };

  // Disabled: no session or device lets them in (set while their account is being deleted).
  const setDisabled = (userId: string, on: boolean): void => void db.run('UPDATE users SET disabled = ? WHERE id = ?', on ? 1 : 0, userId);

  // Delete a user: their sessions, devices, codes, tickets, the record of what they did, and
  // (crypto-shredded) secrets. Their box and files go first, through hostd.remove or deleteBox
  // (hostd.ts). What stays is one line saying an account (by its random id) was deleted.
  function remove(userId: string): void {
    secrets.forget(userId);
    db.tx(() => {
      for (const t of ['tickets', 'device_codes', 'audit', 'waitlist']) db.run(`DELETE FROM ${t} WHERE user_id = ?`, userId);
      db.run('DELETE FROM users WHERE id = ?', userId);
    });
    audit(userId, 'user.delete');
    seats.invite(); // their seat goes to whoever waited longest
  }

  return {
    ...seats,
    allowed,
    isAdmin,
    signIn,
    unlink,
    createSession,
    session,
    endSession,
    endAll,
    ticket,
    useTicket,
    deviceCode,
    pendingCode,
    answerCode,
    pollCode,
    device,
    revokeDevice,
    devices,
    createApiKey,
    apiKey,
    apiKeys,
    revokeApiKey,
    addComputer,
    computers,
    computer,
    computerByLabel,
    seenComputer,
    removeComputer,
    identities,
    byHandle,
    userById,
    instance,
    setDisabled,
    remove,
    audit,
    normalCode,
  };
}

export type Accounts = ReturnType<typeof createAccounts>;
