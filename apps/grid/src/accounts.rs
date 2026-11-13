//! Users and how they get in (v1 grid/accounts.js): browser sessions, devices (wisp on a computer, with a
//! bearer token from the RFC 8628 device flow), and computers (a device's own wisp, reached at
//! `<name>--<handle>.<domain>` through its tunnel). Tokens are kept as their SHA-256 only.
//!
//! Sign-in with a provider (GitHub, Google, any OIDC issuer: `auth.rs`) ends in [`Accounts::sign_in`]: an
//! identity signs in as the user it's linked to, or a new one; never by matching email (a provider that lets
//! anyone claim an address would hand the account over). `auth.allow` and `auth.signup` say who may come in. A
//! grid run with `auth.dev` also signs anyone in by handle at `/auth/dev` (development and tests only).
use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::clock::SharedClock;
use crate::db::Db;
use crate::error::{Result, bad};
use crate::rows::{ComputerRow, DeviceRow, UserRow};

/// How long a device code waits for its approval.
pub const CODE_TTL_MS: i64 = 10 * 60_000;
/// How often a device may poll (RFC 8628 `interval`), in seconds.
pub const INTERVAL_S: i64 = 5;
const DAY: i64 = 24 * 3_600_000;
/// Letters that can't be misread for each other (no vowels: no words), as v1.
const USER_CODE: &[u8] = b"BCDFGHJKLMNPQRSTVWXZ";
const SESSION_MS: i64 = 30 * DAY;

pub fn sha256_hex(s: &str) -> String {
    let d = Sha256::digest(s.as_bytes());
    let mut out = String::with_capacity(64);
    for b in d {
        out.push(char::from(b"0123456789abcdef"[usize::from(b >> 4)]));
        out.push(char::from(b"0123456789abcdef"[usize::from(b & 15)]));
    }
    out
}

/// `prefix` + 32 random bytes, base64url.
pub fn token(prefix: &str) -> String {
    format!("{prefix}{}", B64URL.encode(rand::random::<[u8; 32]>()))
}

fn hex_id(n: usize) -> String {
    let mut out = String::new();
    for _ in 0..n {
        out.push(char::from(b"0123456789abcdef"[usize::from(rand::random::<u8>() & 15)]));
    }
    out
}

/// What polling a device code answers: RFC 8628's error, or the device token once allowed.
#[derive(Debug, Clone, PartialEq)]
pub enum Poll {
    Pending,
    SlowDown,
    Denied,
    Expired,
    /// unknown or already used
    Invalid,
    Token {
        token: String,
        user: UserRow,
    },
}

impl Poll {
    /// The RFC 8628 error code, for everything but a token.
    pub fn error(&self) -> Option<&'static str> {
        match self {
            Self::Pending => Some("authorization_pending"),
            Self::SlowDown => Some("slow_down"),
            Self::Denied => Some("access_denied"),
            Self::Expired => Some("expired_token"),
            Self::Invalid => Some("invalid_grant"),
            Self::Token { .. } => None,
        }
    }
}

/// `abcd efgh`, `ABCDEFGH`, `abcd-efgh` → `ABCD-EFGH`; anything else → "".
pub fn normal_code(c: &str) -> String {
    let s: String = c.chars().filter(char::is_ascii_alphabetic).map(|c| c.to_ascii_uppercase()).collect();
    if s.len() == 8 { format!("{}-{}", &s[..4], &s[4..]) } else { String::new() }
}

/// A computer's label from its name: lowercase words joined by `-`, at most 20 characters, never one that
/// reads as a preview's (`p5173`) or a sandbox's (`sb-<8 hex>`) address.
pub fn computer_slug(name: &str) -> String {
    let mut s = String::new();
    for c in name.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            s.push(c);
        } else if !s.ends_with('-') {
            s.push('-');
        }
    }
    let s: String = s.trim_matches('-').chars().take(20).collect();
    let s = s.trim_end_matches('-').to_owned();
    let preview = s.strip_prefix('p').is_some_and(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()));
    let sandbox =
        s.strip_prefix("sb-").is_some_and(|d| d.len() == 8 && d.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    if s.is_empty() {
        "computer".into()
    } else if preview || sandbox {
        format!("{s}-pc")
    } else {
        s
    }
}

/// Whether `auth.allow` lets an identity in: no list lets everyone in; else its account (`github:octocat`, by login or
/// id), its verified email or that email's domain, or one of its GitHub orgs. An unverified email counts for nothing.
pub fn allowed(auth: &crate::config::AuthConfig, idn: &crate::auth::Identity) -> bool {
    let a = &auth.allow;
    let low = |v: &[String]| v.iter().map(|x| x.trim().to_lowercase()).collect::<Vec<_>>();
    let (emails, domains, orgs, accounts) = (
        low(&a.emails),
        low(&a.domains).into_iter().map(|d| d.trim_start_matches('@').to_owned()).collect::<Vec<_>>(),
        low(&a.github_orgs),
        low(&a.accounts),
    );
    if emails.is_empty() && domains.is_empty() && orgs.is_empty() && accounts.is_empty() {
        return true;
    }
    let me = format!("{}:{}", idn.provider, idn.subject).to_lowercase();
    if accounts.contains(&me) || (!idn.login.is_empty() && accounts.contains(&format!("{}:{}", idn.provider, idn.login).to_lowercase())) {
        return true;
    }
    let email = if idn.email_verified { idn.email.to_lowercase() } else { String::new() };
    if !email.is_empty() && (emails.contains(&email) || email.rsplit_once('@').is_some_and(|(_, d)| domains.iter().any(|x| x == d))) {
        return true;
    }
    !orgs.is_empty() && idn.orgs.as_ref().is_some_and(|o| o.iter().any(|x| orgs.contains(&x.to_lowercase())))
}

/// A free handle from a login: a-z, 0-9 and single dashes, at most 24; a short or reserved one gets a suffix.
pub fn unique_handle(c: &rusqlite::Connection, base: &str) -> rusqlite::Result<String> {
    let mut h = String::new();
    for ch in base.to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            h.push(ch);
        } else if !h.ends_with('-') {
            h.push('-');
        }
    }
    let mut h: String = h.trim_matches('-').chars().take(24).collect::<String>().trim_end_matches('-').to_owned();
    let reserved = |x: &str| crate::config::RESERVED.contains(&x);
    if h.len() < 3 || reserved(&h) {
        h = format!("{}-{}", if h.is_empty() { "user" } else { &h }, hex_id(4));
    }
    let taken = |x: &str| -> rusqlite::Result<bool> {
        Ok(c.query_row("SELECT 1 FROM users WHERE handle = ?1", [x], |_| Ok(())).optional()?.is_some() || reserved(x))
    };
    let mut out = h.clone();
    let mut n = 2;
    while taken(&out)? {
        out = format!("{h}-{n}");
        n += 1;
    }
    Ok(out)
}

#[derive(Debug, Clone)]
pub struct Accounts {
    pub db: Arc<Db>,
    pub clock: SharedClock,
}

impl Accounts {
    fn now(&self) -> i64 {
        self.clock.now_ms()
    }

    pub fn user_by_id(&self, id: &str) -> Result<Option<UserRow>> {
        self.db.with(|c| c.query_row(&format!("SELECT {} FROM users WHERE id = ?1", UserRow::COLS), [id], UserRow::from_row).optional())
    }

    pub fn user_by_handle(&self, handle: &str) -> Result<Option<UserRow>> {
        self.db.with(|c| {
            c.query_row(&format!("SELECT {} FROM users WHERE handle = ?1", UserRow::COLS), [handle], UserRow::from_row).optional()
        })
    }

    /// A development sign-in: the user with this handle, made if there is none.
    pub fn dev_user(&self, handle: &str) -> Result<UserRow> {
        let h = handle.trim().to_ascii_lowercase();
        if h.is_empty() || h.len() > 30 || h.contains("--") || !crate::hosts::is_handle_label(&h) || h.starts_with('-') || h.ends_with('-')
        {
            return Err(bad("A handle is a-z, 0-9 and single dashes.", 400));
        }
        if let Some(u) = self.user_by_handle(&h)? {
            return Ok(u);
        }
        let id = hex_id(12);
        let now = self.now();
        self.db.with(|c| c.execute("INSERT INTO users (id, handle, name, created_at) VALUES (?1, ?2, ?2, ?3)", params![id, h, now]))?;
        self.user_by_id(&id)?.ok_or_else(|| bad("The user wasn't made.", 500))
    }

    // --- sign-in with a provider -------------------------------------------------------------------

    /// The user an identity signs in as: its link, the signed-in user linking it (`link_to`), or a new user when
    /// sign-ups are open and the allow list lets it in.
    pub fn sign_in(&self, auth: &crate::config::AuthConfig, idn: &crate::auth::Identity, link_to: Option<&str>) -> Result<UserRow> {
        if idn.subject.is_empty() {
            return Err(bad("The provider didn't say who you are.", 400));
        }
        let now = self.now();
        let found: Option<String> = self.db.with(|c| {
            c.query_row("SELECT user_id FROM identities WHERE provider = ?1 AND subject = ?2", params![idn.provider, idn.subject], |r| {
                r.get(0)
            })
            .optional()
        })?;
        let opt = |s: &str| (!s.is_empty()).then(|| s.to_owned());
        if let Some(uid) = link_to {
            if found.as_deref().is_some_and(|f| f != uid) {
                return Err(bad("That account already signs in to another user here.", 409));
            }
            if found.is_none() {
                self.db.with(|c| {
                    c.execute(
                        "INSERT INTO identities (provider, subject, user_id, email, login, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                        params![idn.provider, idn.subject, uid, opt(&idn.email), opt(&idn.login), now],
                    )
                })?;
            }
            self.audit(Some(uid), "identity.link", &idn.provider)?;
            return self.user_by_id(uid)?.ok_or_else(|| bad("That user is gone.", 404));
        }
        if let Some(uid) = found {
            let u = self
                .user_by_id(&uid)?
                .filter(|u| u.disabled == 0)
                .ok_or_else(|| bad("This account is turned off. Ask the grid's operator.", 403))?;
            if !allowed(auth, idn) {
                return Err(bad("This grid no longer lets this account in.", 403));
            }
            self.db.with(|c| {
                c.execute(
                    "UPDATE identities SET email = ?1, login = ?2 WHERE provider = ?3 AND subject = ?4",
                    params![opt(&idn.email), opt(&idn.login), idn.provider, idn.subject],
                )?;
                if u.avatar.as_deref().unwrap_or_default().is_empty() && !idn.avatar.is_empty() {
                    c.execute("UPDATE users SET avatar = ?1 WHERE id = ?2", params![idn.avatar, u.id])?;
                }
                Ok(())
            })?;
            self.audit(Some(&u.id), "signin", &idn.provider)?;
            return self.user_by_id(&u.id)?.ok_or_else(|| bad("That user is gone.", 404));
        }
        if auth.signup == "closed" {
            self.audit(None, "signup.refused", &idn.provider)?;
            return Err(bad("Sign-ups are closed on this grid.", 403));
        }
        if !allowed(auth, idn) {
            self.audit(None, "signup.refused", &idn.provider)?;
            return Err(bad("This grid only lets in invited accounts, and this isn't one of them.", 403));
        }
        let id = hex_id(16);
        let base = if idn.login.is_empty() { idn.email.split('@').next().unwrap_or("user").to_owned() } else { idn.login.clone() };
        self.db.tx(|c| {
            let handle = unique_handle(c, &base)?;
            c.execute(
                "INSERT INTO users (id, handle, email, name, avatar, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![id, handle, opt(&idn.email), opt(&idn.name), opt(&idn.avatar), now],
            )?;
            c.execute(
                "INSERT INTO identities (provider, subject, user_id, email, login, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![idn.provider, idn.subject, id, opt(&idn.email), opt(&idn.login), now],
            )?;
            c.execute("INSERT INTO instances (user_id, state, created_at) VALUES (?1, 'stopped', ?2)", params![id, now])?;
            Ok(())
        })?;
        self.audit(Some(&id), "signup", &idn.provider)?;
        self.user_by_id(&id)?.ok_or_else(|| bad("The user wasn't made.", 500))
    }

    fn audit(&self, user: Option<&str>, action: &str, provider: &str) -> Result<()> {
        let now = self.now();
        let meta = json!({ "provider": provider });
        self.db.with(|c| crate::rows::find::audit(c, user, action, Some(&meta), now))
    }

    // --- browser sessions -------------------------------------------------------------------------

    /// A session for this user: the cookie's value (kept hashed).
    pub fn new_session(&self, user_id: &str) -> Result<String> {
        let t = token("");
        let now = self.now();
        self.db.with(|c| {
            c.execute(
                "INSERT INTO sessions (id_hash, user_id, scope, created_at, expires_at, last_seen_at) VALUES (?1, ?2, 'grid', ?3, ?4, ?3)",
                params![sha256_hex(&t), user_id, now, now + SESSION_MS],
            )
        })?;
        Ok(t)
    }

    pub fn session(&self, cookie: &str) -> Result<Option<UserRow>> {
        if cookie.is_empty() {
            return Ok(None);
        }
        let now = self.now();
        let uid: Option<String> = self.db.with(|c| {
            c.query_row("SELECT user_id FROM sessions WHERE id_hash = ?1 AND expires_at > ?2", params![sha256_hex(cookie), now], |r| {
                r.get(0)
            })
            .optional()
        })?;
        match uid {
            Some(u) => Ok(self.user_by_id(&u)?.filter(|u| u.disabled == 0)),
            None => Ok(None),
        }
    }

    // --- device codes (RFC 8628) ------------------------------------------------------------------

    /// A new code for a device called `name`: what the device shows and polls with.
    pub fn device_code(&self, name: &str) -> Result<Value> {
        let n: String = name.trim().chars().take(60).collect();
        let n = if n.is_empty() { "A device".to_owned() } else { n };
        let code = token("");
        let pick = || (0..4).map(|_| char::from(USER_CODE[usize::from(rand::random::<u8>()) % USER_CODE.len()])).collect::<String>();
        let now = self.now();
        let user_code = self.db.with(|c| {
            let mut uc = format!("{}-{}", pick(), pick());
            while c.query_row("SELECT 1 FROM device_codes WHERE user_code = ?1", [&uc], |_| Ok(())).optional()?.is_some() {
                uc = format!("{}-{}", pick(), pick());
            }
            c.execute(
                "INSERT INTO device_codes (code_hash, user_code, name, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![sha256_hex(&code), uc, n, now, now + CODE_TTL_MS],
            )?;
            c.execute("DELETE FROM device_codes WHERE expires_at < ?1", [now - DAY])?;
            Ok(uc)
        })?;
        Ok(json!({ "device_code": code, "user_code": user_code, "expires_in": CODE_TTL_MS / 1000, "interval": INTERVAL_S }))
    }

    /// The device's name for a code still waiting, for the approval page; None when it isn't one.
    pub fn pending(&self, user_code: &str) -> Result<Option<String>> {
        let now = self.now();
        self.db.with(|c| {
            c.query_row(
                "SELECT name FROM device_codes WHERE user_code = ?1 AND expires_at >= ?2 AND consumed_at IS NULL AND approved_at IS NULL AND denied_at IS NULL",
                params![normal_code(user_code), now],
                |r| r.get(0),
            )
            .optional()
        })
    }

    /// The signed-in person allows (or declines) a code.
    pub fn decide(&self, user_code: &str, user_id: &str, allow: bool) -> Result<()> {
        if self.pending(user_code)?.is_none() {
            return Err(bad("That code expired or was already used. Start again on the device.", 400));
        }
        let now = self.now();
        let col = if allow { "approved_at" } else { "denied_at" };
        self.db.with(|c| {
            c.execute(
                &format!("UPDATE device_codes SET {col} = ?1, user_id = ?2 WHERE user_code = ?3"),
                params![now, user_id, normal_code(user_code)],
            )
        })?;
        Ok(())
    }

    /// The device polls: RFC 8628's answer, or its token (once).
    pub fn poll(&self, device_code: &str) -> Result<Poll> {
        type Code = (i64, Option<i64>, Option<i64>, Option<i64>, Option<i64>, Option<String>, String);
        let h = sha256_hex(device_code);
        let now = self.now();
        let row: Option<Code> = self.db.with(|c| {
            c.query_row("SELECT expires_at, approved_at, denied_at, consumed_at, last_poll_at, user_id, name FROM device_codes WHERE code_hash = ?1", [&h], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?))).optional()
        })?;
        let Some((expires, approved, denied, consumed, last_poll, user_id, name)) = row else { return Ok(Poll::Invalid) };
        if consumed.is_some() {
            return Ok(Poll::Invalid);
        }
        if expires < now {
            return Ok(Poll::Expired);
        }
        if denied.is_some() {
            return Ok(Poll::Denied);
        }
        if approved.is_none() {
            let fast = last_poll.is_some_and(|l| now - l < INTERVAL_S * 1000 - 250);
            self.db.with(|c| c.execute("UPDATE device_codes SET last_poll_at = ?1 WHERE code_hash = ?2", params![now, h]))?;
            return Ok(if fast { Poll::SlowDown } else { Poll::Pending });
        }
        let uid = user_id.unwrap_or_default();
        let t = token("wgd_");
        let id = hex_id(12);
        self.db.tx(|tx| {
            tx.execute("UPDATE device_codes SET consumed_at = ?1 WHERE code_hash = ?2", params![now, h])?;
            tx.execute(
                "INSERT INTO devices (id, user_id, name, token_hash, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                params![id, uid, name, sha256_hex(&t), now],
            )?;
            Ok(())
        })?;
        let user = self.user_by_id(&uid)?.ok_or_else(|| bad("That account is gone.", 410))?;
        Ok(Poll::Token { token: t, user })
    }

    // --- devices ----------------------------------------------------------------------------------

    /// Who holds this device token (`Bearer wgd_…` or the token alone); None when it's unknown or revoked.
    pub fn device(&self, bearer: &str) -> Result<Option<(UserRow, DeviceRow)>> {
        let t = bearer.strip_prefix("Bearer ").or_else(|| bearer.strip_prefix("bearer ")).unwrap_or(bearer).trim();
        if !t.starts_with("wgd_") {
            return Ok(None);
        }
        let d: Option<DeviceRow> = self.db.with(|c| {
            c.query_row(&format!("SELECT {} FROM devices WHERE token_hash = ?1", DeviceRow::COLS), [sha256_hex(t)], DeviceRow::from_row)
                .optional()
        })?;
        let Some(d) = d.filter(|d| d.revoked_at.is_none()) else { return Ok(None) };
        let Some(u) = self.user_by_id(&d.user_id)?.filter(|u| u.disabled == 0) else { return Ok(None) };
        let now = self.now();
        if d.last_seen_at.is_none_or(|l| now - l > 60_000) {
            self.db.with(|c| c.execute("UPDATE devices SET last_seen_at = ?1 WHERE id = ?2", params![now, d.id]))?;
        }
        Ok(Some((u, d)))
    }

    /// A revoked device's computer goes with it: it can't hold its tunnel any more.
    pub fn revoke_device(&self, user_id: &str, id: &str) -> Result<bool> {
        let now = self.now();
        self.db.tx(|tx| {
            let n = tx.execute(
                "UPDATE devices SET revoked_at = ?1 WHERE id = ?2 AND user_id = ?3 AND revoked_at IS NULL",
                params![now, id, user_id],
            )?;
            tx.execute("DELETE FROM computers WHERE device_id = ?1 AND user_id = ?2", params![id, user_id])?;
            Ok(n > 0)
        })
    }

    // --- computers --------------------------------------------------------------------------------

    /// The device's computer (one each), added or renamed.
    pub fn add_computer(&self, user: &UserRow, device: &DeviceRow, name: &str) -> Result<ComputerRow> {
        let n: String = name.trim().chars().take(40).collect();
        let n = if n.is_empty() { "Computer".to_owned() } else { n };
        let have: Option<ComputerRow> = self.db.with(|c| {
            c.query_row(&format!("SELECT {} FROM computers WHERE device_id = ?1", ComputerRow::COLS), [&device.id], ComputerRow::from_row)
                .optional()
        })?;
        if let Some(mut h) = have {
            if h.name != n {
                self.db.with(|c| c.execute("UPDATE computers SET name = ?1 WHERE id = ?2", params![n, h.id]))?;
                h.name = n;
            }
            return Ok(h);
        }
        let slug = computer_slug(&n);
        let now = self.now();
        let id = hex_id(12);
        let label = self.db.with(|c| {
            let taken = |l: &str| -> rusqlite::Result<bool> {
                Ok(c.query_row("SELECT 1 FROM computers WHERE label = ?1", [l], |_| Ok(())).optional()?.is_some()
                    || c.query_row("SELECT 1 FROM users WHERE handle = ?1", [l], |_| Ok(())).optional()?.is_some())
            };
            let mut label = format!("{slug}--{}", user.handle);
            let mut k = 2;
            while taken(&label)? {
                label = format!("{slug}-{k}--{}", user.handle);
                k += 1;
            }
            c.execute(
                "INSERT INTO computers (id, user_id, device_id, name, label, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![id, user.id, device.id, n, label, now],
            )?;
            Ok(label)
        })?;
        Ok(ComputerRow { id, user_id: user.id.clone(), device_id: device.id.clone(), name: n, label, created_at: now, last_seen_at: None })
    }

    pub fn computers(&self, user_id: &str) -> Result<Vec<ComputerRow>> {
        self.db.with(|c| crate::rows::find::computers_of(c, user_id))
    }

    pub fn computer(&self, id: &str) -> Result<Option<ComputerRow>> {
        self.db.with(|c| crate::rows::find::computer_by_id(c, id))
    }

    pub fn computer_by_label(&self, label: &str) -> Result<Option<ComputerRow>> {
        self.db.with(|c| crate::rows::find::computer_by_label(c, &label.to_ascii_lowercase()))
    }

    pub fn seen_computer(&self, id: &str) -> Result<()> {
        let now = self.now();
        self.db.with(|c| c.execute("UPDATE computers SET last_seen_at = ?1 WHERE id = ?2", params![now, id]))?;
        Ok(())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::clock::ManualClock;

    fn accounts() -> (Accounts, Arc<ManualClock>) {
        let clock = ManualClock::new(1_000_000);
        (Accounts { db: Arc::new(Db::memory().unwrap()), clock: clock.clone() }, clock)
    }

    #[test]
    fn device_sign_in_follows_rfc_8628() {
        let (a, clock) = accounts();
        let ada = a.dev_user("ada").unwrap();
        let c = a.device_code("studio (wisp)").unwrap();
        let (code, user) = (c["device_code"].as_str().unwrap().to_owned(), c["user_code"].as_str().unwrap().to_owned());
        assert_eq!((c["interval"].clone(), c["expires_in"].clone()), (json!(5), json!(600)));
        assert_eq!(a.poll(&code).unwrap(), Poll::Pending);
        // faster than the interval
        clock.advance(1000);
        assert_eq!(a.poll(&code).unwrap(), Poll::SlowDown);
        clock.advance(5000);
        assert_eq!(a.poll(&code).unwrap(), Poll::Pending);
        assert_eq!(a.pending(&user.to_lowercase().replace('-', " ")).unwrap().as_deref(), Some("studio (wisp)"));
        a.decide(&user, &ada.id, true).unwrap();
        let Poll::Token { token, user: who } = a.poll(&code).unwrap() else { panic!("no token") };
        assert!(token.starts_with("wgd_") && who.handle == "ada");
        // once: the code is used
        assert_eq!(a.poll(&code).unwrap(), Poll::Invalid);
        assert!(a.decide(&user, &ada.id, true).is_err());
        let (u, d) = a.device(&format!("Bearer {token}")).unwrap().unwrap();
        assert_eq!((u.handle.as_str(), d.name.as_str()), ("ada", "studio (wisp)"));
        // kept hashed only
        assert_ne!(d.token_hash, token);
        // expired
        let late = a.device_code("x").unwrap();
        clock.advance(CODE_TTL_MS + 1);
        assert_eq!(a.poll(late["device_code"].as_str().unwrap()).unwrap(), Poll::Expired);
        assert_eq!(a.poll("nope").unwrap().error(), Some("invalid_grant"));
        // a revoked device is nobody
        a.revoke_device(&ada.id, &d.id).unwrap();
        assert!(a.device(&token).unwrap().is_none());
    }

    #[test]
    fn a_denied_sign_in_stops() {
        let (a, _) = accounts();
        let ada = a.dev_user("ada").unwrap();
        let c = a.device_code("laptop").unwrap();
        a.decide(c["user_code"].as_str().unwrap(), &ada.id, false).unwrap();
        assert_eq!(a.poll(c["device_code"].as_str().unwrap()).unwrap(), Poll::Denied);
    }

    #[test]
    fn computers_get_labels_that_never_read_as_another_address() {
        let (a, _) = accounts();
        assert_eq!(computer_slug("Ada's MacBook Pro"), "ada-s-macbook-pro");
        assert_eq!(computer_slug("p5173"), "p5173-pc");
        assert_eq!(computer_slug("sb-0123abcd"), "sb-0123abcd-pc");
        assert_eq!(computer_slug("!!!"), "computer");
        let ada = a.dev_user("ada").unwrap();
        assert!(a.dev_user("a--b").is_err());
        let mk = |name: &str| {
            let c = a.device_code(name).unwrap();
            a.decide(c["user_code"].as_str().unwrap(), &ada.id, true).unwrap();
            let Poll::Token { token, .. } = a.poll(c["device_code"].as_str().unwrap()).unwrap() else { panic!() };
            a.device(&token).unwrap().unwrap().1
        };
        let (d1, d2) = (mk("one"), mk("two"));
        let c1 = a.add_computer(&ada, &d1, "Studio").unwrap();
        let c2 = a.add_computer(&ada, &d2, "Studio").unwrap();
        assert_eq!((c1.label.as_str(), c2.label.as_str()), ("studio--ada", "studio-2--ada"));
        // the same device again: renamed, same label
        assert_eq!(a.add_computer(&ada, &d1, "Studio 2").unwrap().label, "studio--ada");
    }
}
