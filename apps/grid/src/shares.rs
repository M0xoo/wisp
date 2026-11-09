//! Shares (ADR-0038, v1 grid/shares.js): everything shared through wisp Cloud, one store for every kind
//! (a task, a setup or module, crew, a workflow, an app, a plugin, a doc, a report, a My Stuff item).
//!
//! - **Versions:** a share is `(user, key)`, at one link. Sharing the same key again with other content makes
//!   version n+1; the same content changes nothing. `?ref=v2` reads that version.
//! - **Signed:** each version carries the sharer's ed25519 signature over its bytes and the key that made
//!   it. The grid checks it, and pins the key at the first version: a later version must be signed by
//!   the same key, so nobody but the sharer's wisp can update a link. A receiver checks it again.
//! - **Access:** `anyone` with the link (the default), `people` (handles, signed in), `teams` (members of
//!   the teams named), or `password` (kept as v1's scrypt `salt:hash`, compared in constant time). Expiry
//!   and revoke answer 410. A refused reader learns only that it's locked, and how it opens.
//! - **Counts:** a read of the page or the content is a view, an import an import; the sharer's own
//!   reads count for nothing.
//! - **Gallery:** a share its sharer published (and whose access is `anyone`) is listed and searchable.
use std::fmt::Write as _;
use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use ed25519_dalek::{Signature, Verifier as _, VerifyingKey};
use rusqlite::{OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};
use subtle::ConstantTimeEq;

use crate::accounts::sha256_hex;
use crate::clock::SharedClock;
use crate::db::Db;
use crate::error::{Result, bad};
use crate::rows::UserRow;
use crate::teams::Teams;

/// What a share may be.
pub const KINDS: &[&str] = &["task", "setup", "module", "crew", "workflow", "agent", "app", "plugin", "doc", "report", "stuff"];
pub const MAX_BYTES: usize = 8 * 1024 * 1024;
pub const PER_USER: i64 = 200;
pub const PASSWORD_MAX: usize = 128;

/// A password as kept: `<salt hex>:<hash hex>` (v1's `hashPasskey`: scrypt N=16384, r=8, p=1, 32 bytes).
pub fn hash_password(pass: &str) -> String {
    let salt: [u8; 16] = rand::random();
    format!("{}:{}", hex(&salt), hex(&derive(pass, &salt)))
}

fn derive(pass: &str, salt: &[u8]) -> Vec<u8> {
    let mut out = vec![0u8; 32];
    if let Ok(p) = scrypt::Params::new(14, 8, 1, 32) {
        let _ = scrypt::scrypt(pass.as_bytes(), salt, &p, &mut out);
    }
    out
}

fn hex(b: &[u8]) -> String {
    b.iter().fold(String::with_capacity(b.len() * 2), |mut out, x| {
        let _ = write!(out, "{x:02x}");
        out
    })
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    s.len().is_multiple_of(2).then(|| (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok()).collect::<Option<Vec<u8>>>()).flatten()
}

pub fn check_password(kept: &str, pass: &str) -> bool {
    let Some((salt, hash)) = kept.split_once(':') else { return false };
    let (Some(salt), Some(want)) = (unhex(salt), unhex(hash)) else { return false };
    if pass.is_empty() {
        return false;
    }
    let got = derive(pass, &salt);
    got.len() == want.len() && bool::from(got.ct_eq(&want))
}

/// Who may read a share.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Access {
    /// `anyone` | `people` | `teams` | `password`
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub people: Vec<String>,
    #[serde(default)]
    pub teams: Vec<String>,
    #[serde(default)]
    pub password: Option<String>,
}

/// What a sharer's wisp sends.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Put {
    pub kind: String,
    /// what it is on the sharer's wisp (a task id, a setup's name), so sharing it again updates the link
    pub key: String,
    pub title: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub tags: Vec<String>,
    /// the content, base64: the exact bytes signed
    pub body: String,
    /// the sharer's ed25519 public key and signature, base64
    pub signer: String,
    pub sig: String,
    #[serde(default)]
    pub access: Option<Access>,
    /// ms since the epoch; `0` clears it
    #[serde(default)]
    pub expires_at: Option<i64>,
    #[serde(default)]
    pub publish: Option<bool>,
}

/// A change to a share's settings (no new content).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Patch {
    #[serde(default)]
    pub access: Option<Access>,
    #[serde(default)]
    pub expires_at: Option<i64>,
    #[serde(default)]
    pub publish: Option<bool>,
}

/// One share, as stored.
#[derive(Debug, Clone, PartialEq)]
pub struct Rec {
    pub id: String,
    pub user_id: String,
    pub handle: String,
    pub key: String,
    pub kind: String,
    pub title: String,
    pub summary: String,
    pub tags: Vec<String>,
    pub version: i64,
    pub access: String,
    pub people: Vec<String>,
    pub teams: Vec<String>,
    pub pass: Option<String>,
    pub expires_at: Option<i64>,
    pub revoked_at: Option<i64>,
    pub views: i64,
    pub imports: i64,
    pub signer: Option<String>,
    pub published: bool,
    pub size: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A version's content, as read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Content {
    pub version: i64,
    pub body: Vec<u8>,
    pub sig: String,
    pub signer: String,
}

/// Why a read was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refused {
    /// 410: `revoked` or `expired`
    Gone(&'static str),
    /// 403: locked, and how it opens (`people`, `teams`, `password`)
    Locked(String),
    /// 404
    NoVersion,
}

const SELECT: &str = "SELECT s.id, s.user_id, u.handle, s.key, s.kind, s.title, s.summary, s.tags, s.version, s.access, s.people, s.teams, s.pass, s.expires_at, s.revoked_at, s.views, s.imports, s.signer, s.published, s.size, s.created_at, s.updated_at FROM shares s JOIN users u ON u.id = s.user_id";

fn list(v: &str) -> Vec<String> {
    serde_json::from_str(v).unwrap_or_default()
}

fn rec(r: &rusqlite::Row<'_>) -> rusqlite::Result<Rec> {
    Ok(Rec {
        id: r.get(0)?,
        user_id: r.get(1)?,
        handle: r.get(2)?,
        key: r.get(3)?,
        kind: r.get(4)?,
        title: r.get(5)?,
        summary: r.get(6)?,
        tags: list(&r.get::<_, String>(7)?),
        version: r.get(8)?,
        access: r.get(9)?,
        people: list(&r.get::<_, String>(10)?),
        teams: list(&r.get::<_, String>(11)?),
        pass: r.get(12)?,
        expires_at: r.get(13)?,
        revoked_at: r.get(14)?,
        views: r.get(15)?,
        imports: r.get(16)?,
        signer: r.get(17)?,
        published: r.get::<_, i64>(18)? != 0,
        size: r.get(19)?,
        created_at: r.get(20)?,
        updated_at: r.get(21)?,
    })
}

fn key_ok(k: &str) -> bool {
    !k.is_empty() && k.len() <= 64 && k.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
}

/// `v2`, `2` → 2.
pub fn parse_ref(r: &str) -> Option<i64> {
    r.strip_prefix('v').unwrap_or(r).parse().ok().filter(|n| *n > 0)
}

/// Checks `sig` (base64) over `body` against `signer` (a base64 ed25519 public key).
pub fn verify(signer: &str, sig: &str, body: &[u8]) -> bool {
    let (Ok(k), Ok(s)) = (B64.decode(signer.trim()), B64.decode(sig.trim())) else { return false };
    let (Ok(k), Ok(s)) = (<[u8; 32]>::try_from(k.as_slice()), <[u8; 64]>::try_from(s.as_slice())) else { return false };
    VerifyingKey::from_bytes(&k).is_ok_and(|vk| vk.verify(body, &Signature::from_bytes(&s)).is_ok())
}

#[derive(Debug, Clone)]
pub struct Shares {
    pub db: Arc<Db>,
    pub clock: SharedClock,
    pub teams: Teams,
    /// `<publicUrl>`, for links
    pub public_url: String,
}

impl Shares {
    pub fn url(&self, id: &str) -> String {
        format!("{}/s/{id}", self.public_url)
    }

    /// What the sharer sees: everything but the password.
    pub fn view(&self, s: &Rec) -> Value {
        json!({
            "id": s.id, "url": self.url(&s.id), "key": s.key, "kind": s.kind, "title": s.title, "summary": s.summary,
            "tags": s.tags, "version": s.version, "ref": format!("v{}", s.version),
            "access": { "kind": s.access, "people": s.people, "teams": s.teams },
            "expiresAt": s.expires_at, "revoked": s.revoked_at.is_some(), "views": s.views, "imports": s.imports,
            "published": s.published, "size": s.size, "createdAt": s.created_at, "updatedAt": s.updated_at,
            "source": format!("grid://{}/{}", s.handle, s.key),
        })
    }

    /// What a reader sees before the content: who shared it, what it is.
    pub fn card(&self, s: &Rec) -> Value {
        json!({
            "id": s.id, "url": self.url(&s.id), "kind": s.kind, "title": s.title, "summary": s.summary, "tags": s.tags,
            "version": s.version, "ref": format!("v{}", s.version), "from": { "handle": s.handle },
            "source": format!("grid://{}/{}", s.handle, s.key), "updatedAt": s.updated_at,
        })
    }

    pub fn get(&self, id: &str) -> Result<Option<Rec>> {
        if id.is_empty() || id.len() > 64 {
            return Ok(None);
        }
        self.db.with(|c| c.query_row(&format!("{SELECT} WHERE s.id = ?1"), [id], rec).optional())
    }

    /// `grid://<handle>/<key>`'s share.
    pub fn by_name(&self, handle: &str, key: &str) -> Result<Option<Rec>> {
        self.db.with(|c| c.query_row(&format!("{SELECT} WHERE u.handle = ?1 AND s.key = ?2"), params![handle, key], rec).optional())
    }

    pub fn mine(&self, user_id: &str) -> Result<Vec<Value>> {
        let rows: Vec<Rec> = self.db.with(|c| {
            let mut s = c.prepare(&format!("{SELECT} WHERE s.user_id = ?1 ORDER BY s.updated_at DESC"))?;
            s.query_map([user_id], rec)?.collect()
        })?;
        Ok(rows.iter().map(|r| self.view(r)).collect())
    }

    fn check_access(&self, user: &UserRow, a: &Access) -> Result<(String, String, String, Option<String>)> {
        let kind = if a.kind.is_empty() { "anyone" } else { a.kind.as_str() };
        match kind {
            "anyone" => Ok(("anyone".into(), "[]".into(), "[]".into(), None)),
            "people" => {
                if a.people.is_empty() {
                    return Err(bad("Name the people it's for.", 400));
                }
                Ok(("people".into(), json!(a.people).to_string(), "[]".into(), None))
            }
            "teams" => {
                if a.teams.is_empty() {
                    return Err(bad("Name the teams it's for.", 400));
                }
                for t in &a.teams {
                    if !self.teams.role(&user.id, t)?.is_some_and(crate::teams::Role::shares) {
                        return Err(bad(format!("You can't share to {t}: you'd need to be a member there (not a viewer)."), 403));
                    }
                }
                Ok(("teams".into(), "[]".into(), json!(a.teams).to_string(), None))
            }
            "password" => {
                let p = a.password.as_deref().unwrap_or_default();
                if p.is_empty() || p.len() > PASSWORD_MAX {
                    return Err(bad(format!("A password is 1 to {PASSWORD_MAX} characters."), 400));
                }
                Ok(("password".into(), "[]".into(), "[]".into(), Some(hash_password(p))))
            }
            _ => Err(bad("Access is anyone, people, teams or password.", 400)),
        }
    }

    /// Share (or update) `put.key`: a new version when the content changed.
    pub fn put(&self, user: &UserRow, p: &Put) -> Result<Value> {
        if !KINDS.contains(&p.kind.as_str()) {
            return Err(bad(format!("A share is one of: {}.", KINDS.join(", ")), 400));
        }
        if !key_ok(&p.key) {
            return Err(bad("Bad share key.", 400));
        }
        let body = B64.decode(p.body.trim()).map_err(|_| bad("The content isn't base64.", 400))?;
        if body.len() > MAX_BYTES {
            return Err(bad(format!("A share is at most {} MB.", MAX_BYTES / (1024 * 1024)), 413));
        }
        if !verify(&p.signer, &p.sig, &body) {
            return Err(bad("The signature doesn't match the content.", 400));
        }
        let have = self.by_name(&user.handle, &p.key)?;
        if let Some(h) = &have
            && h.signer.as_deref().is_some_and(|k| k != p.signer.trim())
        {
            return Err(bad("This share was signed by another key: only the wisp that shared it can update it.", 403));
        }
        if have.is_none() {
            let n: i64 = self.db.with(|c| c.query_row("SELECT count(*) FROM shares WHERE user_id = ?1", [&user.id], |r| r.get(0)))?;
            if n >= PER_USER {
                return Err(bad(format!("You have {PER_USER} shares, as many as this grid keeps. Revoke one first."), 409));
            }
        }
        let access = p.access.as_ref().map(|a| self.check_access(user, a)).transpose()?;
        let hash = sha256_hex(&B64.encode(&body));
        let now = self.clock.now_ms();
        let title: String = p.title.trim().chars().take(200).collect();
        let title = if title.is_empty() { p.key.clone() } else { title };
        let summary: String = p.summary.chars().take(500).collect();
        let tags: Vec<String> = p.tags.iter().map(|t| t.trim().to_lowercase()).filter(|t| !t.is_empty() && t.len() <= 30).take(12).collect();
        let id = have.as_ref().map_or_else(|| crate::accounts::token("").chars().take(16).collect(), |h| h.id.clone());
        let expires = p.expires_at.map(|e| (e > 0).then_some(e));
        self.db.tx(|tx| {
            if have.is_none() {
                tx.execute(
                    "INSERT INTO shares (id, user_id, key, title, pass, size, meta, created_at, updated_at, kind, version, signer, summary, tags) VALUES (?1, ?2, ?3, ?4, NULL, ?5, '{}', ?6, ?6, ?7, 0, ?8, ?9, ?10)",
                    params![id, user.id, p.key, title, i64::try_from(body.len()).unwrap_or(i64::MAX), now, p.kind, p.signer.trim(), summary, json!(tags).to_string()],
                )?;
            }
            let last: Option<String> = tx.query_row("SELECT hash FROM share_versions WHERE share_id = ?1 ORDER BY version DESC LIMIT 1", [&id], |r| r.get(0)).optional()?;
            if last.as_deref() != Some(hash.as_str()) {
                let v: i64 = tx.query_row("SELECT version FROM shares WHERE id = ?1", [&id], |r| r.get(0))?;
                tx.execute("INSERT INTO share_versions (share_id, version, body, hash, sig, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)", params![id, v + 1, body, hash, p.sig.trim(), now])?;
                tx.execute("UPDATE shares SET version = ?1, size = ?2, updated_at = ?3 WHERE id = ?4", params![v + 1, i64::try_from(body.len()).unwrap_or(i64::MAX), now, id])?;
            }
            // sharing again brings back a revoked link
            tx.execute("UPDATE shares SET title = ?1, summary = ?2, tags = ?3, kind = ?4, revoked_at = NULL WHERE id = ?5", params![title, summary, json!(tags).to_string(), p.kind, id])?;
            if let Some((kind, people, teams, pass)) = &access {
                tx.execute("UPDATE shares SET access = ?1, people = ?2, teams = ?3, pass = ?4 WHERE id = ?5", params![kind, people, teams, pass, id])?;
            }
            if let Some(e) = expires {
                tx.execute("UPDATE shares SET expires_at = ?1 WHERE id = ?2", params![e, id])?;
            }
            if let Some(pb) = p.publish {
                tx.execute("UPDATE shares SET published = ?1 WHERE id = ?2", params![i64::from(pb), id])?;
            }
            Ok(())
        })?;
        let r = self.get(&id)?.ok_or_else(|| bad("The share wasn't kept.", 500))?;
        Ok(self.view(&r))
    }

    fn own(&self, user: &UserRow, id: &str) -> Result<Rec> {
        self.get(id)?.filter(|s| s.user_id == user.id).ok_or_else(|| bad("You have no share with that id.", 404))
    }

    /// Change who may read it, its expiry, whether it's in the gallery.
    pub fn patch(&self, user: &UserRow, id: &str, p: &Patch) -> Result<Value> {
        let s = self.own(user, id)?;
        let access = p.access.as_ref().map(|a| self.check_access(user, a)).transpose()?;
        self.db.tx(|tx| {
            if let Some((kind, people, teams, pass)) = &access {
                tx.execute("UPDATE shares SET access = ?1, people = ?2, teams = ?3, pass = ?4 WHERE id = ?5", params![kind, people, teams, pass, s.id])?;
            }
            if let Some(e) = p.expires_at {
                tx.execute("UPDATE shares SET expires_at = ?1 WHERE id = ?2", params![(e > 0).then_some(e), s.id])?;
            }
            if let Some(pb) = p.publish {
                tx.execute("UPDATE shares SET published = ?1 WHERE id = ?2", params![i64::from(pb), s.id])?;
            }
            Ok(())
        })?;
        Ok(self.view(&self.own(user, id)?))
    }

    /// The link stops working (sharing it again brings it back, at the next version).
    pub fn revoke(&self, user: &UserRow, id: &str) -> Result<Value> {
        let s = self.own(user, id)?;
        let now = self.clock.now_ms();
        self.db.with(|c| c.execute("UPDATE shares SET revoked_at = ?1, published = 0 WHERE id = ?2", params![now, s.id]))?;
        Ok(self.view(&self.own(user, id)?))
    }

    /// Whether `who` (signed in, or not) with `password` may read `s`; why not otherwise.
    pub fn may_read(&self, s: &Rec, who: Option<&UserRow>, password: Option<&str>) -> Result<std::result::Result<(), Refused>> {
        if who.is_some_and(|u| u.id == s.user_id) {
            return Ok(Ok(()));
        }
        if s.revoked_at.is_some() {
            return Ok(Err(Refused::Gone("revoked")));
        }
        if s.expires_at.is_some_and(|e| e <= self.clock.now_ms()) {
            return Ok(Err(Refused::Gone("expired")));
        }
        let ok = match s.access.as_str() {
            "anyone" => true,
            "people" => who.is_some_and(|u| s.people.iter().any(|p| p == &u.handle)),
            "teams" => match who {
                Some(u) => {
                    let mut any = false;
                    for t in &s.teams {
                        any |= self.teams.role(&u.id, t)?.is_some();
                    }
                    any
                }
                None => false,
            },
            "password" => s.pass.as_deref().zip(password).is_some_and(|(k, p)| check_password(k, p)),
            _ => false,
        };
        Ok(if ok { Ok(()) } else { Err(Refused::Locked(s.access.clone())) })
    }

    /// A version's content (the latest, or `version`). Counts a view unless it's the sharer's own.
    pub fn read(&self, s: &Rec, who: Option<&UserRow>, version: Option<i64>, count: bool) -> Result<std::result::Result<Content, Refused>> {
        let v = version.unwrap_or(s.version);
        let row: Option<(Vec<u8>, String)> = self.db.with(|c| c.query_row("SELECT body, sig FROM share_versions WHERE share_id = ?1 AND version = ?2", params![s.id, v], |r| Ok((r.get(0)?, r.get(1)?))).optional())?;
        let Some((body, sig)) = row else { return Ok(Err(Refused::NoVersion)) };
        if count {
            self.count_view(s, who)?;
        }
        Ok(Ok(Content { version: v, body, sig, signer: s.signer.clone().unwrap_or_default() }))
    }

    pub fn count_view(&self, s: &Rec, who: Option<&UserRow>) -> Result<()> {
        if who.is_none_or(|u| u.id != s.user_id) {
            self.db.with(|c| c.execute("UPDATE shares SET views = views + 1 WHERE id = ?1", [&s.id]))?;
        }
        Ok(())
    }

    pub fn count_import(&self, s: &Rec, who: Option<&UserRow>) -> Result<()> {
        if who.is_none_or(|u| u.id != s.user_id) {
            self.db.with(|c| c.execute("UPDATE shares SET imports = imports + 1 WHERE id = ?1", [&s.id]))?;
        }
        Ok(())
    }

    /// The versions there are (newest first): number and when.
    pub fn versions(&self, s: &Rec) -> Result<Vec<Value>> {
        self.db.with(|c| {
            let mut st = c.prepare("SELECT version, created_at, length(body) FROM share_versions WHERE share_id = ?1 ORDER BY version DESC")?;
            st.query_map([&s.id], |r| Ok(json!({ "version": r.get::<_, i64>(0)?, "ref": format!("v{}", r.get::<_, i64>(0)?), "at": r.get::<_, i64>(1)?, "size": r.get::<_, i64>(2)? })))?.collect()
        })
    }

    /// The gallery: published shares anyone may read, matching every word of `q` (title, summary, tags).
    pub fn gallery(&self, q: &str, kind: Option<&str>) -> Result<Vec<Value>> {
        let now = self.clock.now_ms();
        let rows: Vec<Rec> = self.db.with(|c| {
            let mut s = c.prepare(&format!("{SELECT} WHERE s.published = 1 AND s.access = 'anyone' AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > ?1) ORDER BY s.imports DESC, s.updated_at DESC LIMIT 500"))?;
            s.query_map([now], rec)?.collect()
        })?;
        let words: Vec<String> = q.split_whitespace().map(str::to_lowercase).collect();
        Ok(rows
            .iter()
            .filter(|r| kind.is_none_or(|k| r.kind == k))
            .filter(|r| {
                let hay = format!("{} {} {} {}", r.title, r.summary, r.tags.join(" "), r.kind).to_lowercase();
                words.iter().all(|w| hay.contains(w.as_str()))
            })
            .take(100)
            .map(|r| json!({ "card": self.card(r), "imports": r.imports, "views": r.views }))
            .collect())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use ed25519_dalek::{Signer as _, SigningKey};

    use super::*;
    use crate::accounts::Accounts;
    use crate::clock::ManualClock;

    struct T {
        a: Accounts,
        s: Shares,
        clock: Arc<ManualClock>,
    }

    fn t() -> T {
        let db = Arc::new(Db::memory().unwrap());
        let clock = ManualClock::new(1_000);
        let teams = Teams { db: db.clone(), clock: clock.clone() };
        T { a: Accounts { db: db.clone(), clock: clock.clone() }, s: Shares { db, clock: clock.clone(), teams, public_url: "http://wisp.localhost:8080".into() }, clock }
    }

    fn put(key: &SigningKey, k: &str, body: &str) -> Put {
        Put { kind: "setup".into(), key: k.into(), title: "Review team".into(), body: B64.encode(body), signer: B64.encode(key.verifying_key().to_bytes()), sig: B64.encode(key.sign(body.as_bytes()).to_bytes()), ..Put::default() }
    }

    #[test]
    fn a_share_must_be_signed_by_its_sharer() {
        let t = t();
        let ada = t.a.dev_user("ada").unwrap();
        let (k1, k2) = (SigningKey::from_bytes(&[1; 32]), SigningKey::from_bytes(&[2; 32]));
        let mut bad_sig = put(&k1, "review", "files: 1");
        bad_sig.body = B64.encode("files: 2");
        assert_eq!(t.s.put(&ada, &bad_sig).unwrap_err().status(), 400);
        let v = t.s.put(&ada, &put(&k1, "review", "files: 1")).unwrap();
        assert_eq!((v["version"].clone(), v["source"].clone()), (json!(1), json!("grid://ada/review")));
        // another key can't update it, even signed properly
        assert_eq!(t.s.put(&ada, &put(&k2, "review", "files: 2")).unwrap_err().status(), 403);
        let s = t.s.get(v["id"].as_str().unwrap()).unwrap().unwrap();
        let c = t.s.read(&s, None, None, false).unwrap().unwrap();
        assert!(verify(&c.signer, &c.sig, &c.body));
    }

    #[test]
    fn sharing_again_is_a_new_version_and_ref_pins_one() {
        let t = t();
        let ada = t.a.dev_user("ada").unwrap();
        let k = SigningKey::from_bytes(&[1; 32]);
        let id = t.s.put(&ada, &put(&k, "review", "one")).unwrap()["id"].as_str().unwrap().to_owned();
        // the same content: no new version
        assert_eq!(t.s.put(&ada, &put(&k, "review", "one")).unwrap()["version"], 1);
        t.clock.advance(10);
        let v = t.s.put(&ada, &put(&k, "review", "two")).unwrap();
        assert_eq!((v["id"].as_str().unwrap(), v["version"].clone()), (id.as_str(), json!(2)));
        let s = t.s.get(&id).unwrap().unwrap();
        assert_eq!(t.s.read(&s, None, parse_ref("v1"), false).unwrap().unwrap().body, b"one");
        assert_eq!(t.s.read(&s, None, None, false).unwrap().unwrap().body, b"two");
        assert_eq!(t.s.read(&s, None, parse_ref("v9"), false).unwrap(), Err(Refused::NoVersion));
        assert_eq!(t.s.versions(&s).unwrap().len(), 2);
        assert_eq!(t.s.by_name("ada", "review").unwrap().unwrap().id, id);
    }

    #[test]
    fn share_access_anyone_people_teams_password() {
        let t = t();
        let (ada, bo, cy) = (t.a.dev_user("ada").unwrap(), t.a.dev_user("bo").unwrap(), t.a.dev_user("cy").unwrap());
        let k = SigningKey::from_bytes(&[1; 32]);
        let id = t.s.put(&ada, &put(&k, "x", "x")).unwrap()["id"].as_str().unwrap().to_owned();
        let may = |who: Option<&UserRow>, pass: Option<&str>| t.s.may_read(&t.s.get(&id).unwrap().unwrap(), who, pass).unwrap();
        assert_eq!(may(None, None), Ok(()));
        let set = |a: Access| t.s.patch(&ada, &id, &Patch { access: Some(a), ..Patch::default() });
        set(Access { kind: "people".into(), people: vec!["bo".into()], ..Access::default() }).unwrap();
        assert_eq!((may(Some(&bo), None), may(Some(&cy), None), may(None, None)), (Ok(()), Err(Refused::Locked("people".into())), Err(Refused::Locked("people".into()))));
        // the sharer always reads it
        assert_eq!(may(Some(&ada), None), Ok(()));
        // teams: only a member (not a viewer) shares to one; any member reads
        t.s.teams.create(&bo, "acme", "").unwrap();
        assert_eq!(set(Access { kind: "teams".into(), teams: vec!["acme".into()], ..Access::default() }).unwrap_err().status(), 403);
        t.s.teams.add(&bo, "acme", "ada", "member").unwrap();
        t.s.teams.add(&bo, "acme", "cy", "viewer").unwrap();
        set(Access { kind: "teams".into(), teams: vec!["acme".into()], ..Access::default() }).unwrap();
        assert_eq!((may(Some(&cy), None), may(None, None)), (Ok(()), Err(Refused::Locked("teams".into()))));
        // a password, kept hashed
        set(Access { kind: "password".into(), password: Some("hunter2".into()), ..Access::default() }).unwrap();
        assert_eq!((may(None, Some("hunter2")), may(None, Some("nope")), may(None, None)), (Ok(()), Err(Refused::Locked("password".into())), Err(Refused::Locked("password".into()))));
        let kept = t.s.get(&id).unwrap().unwrap().pass.unwrap();
        assert!(!kept.contains("hunter2") && check_password(&kept, "hunter2"));
        assert_eq!(set(Access { kind: "secret".into(), ..Access::default() }).unwrap_err().status(), 400);
    }

    #[test]
    fn an_expired_or_revoked_link_is_gone() {
        let t = t();
        let ada = t.a.dev_user("ada").unwrap();
        let k = SigningKey::from_bytes(&[1; 32]);
        let id = t.s.put(&ada, &Put { expires_at: Some(2_000), ..put(&k, "x", "x") }).unwrap()["id"].as_str().unwrap().to_owned();
        let may = |who: Option<&UserRow>| t.s.may_read(&t.s.get(&id).unwrap().unwrap(), who, None).unwrap();
        assert_eq!(may(None), Ok(()));
        t.clock.set(2_000);
        assert_eq!(may(None), Err(Refused::Gone("expired")));
        t.s.patch(&ada, &id, &Patch { expires_at: Some(0), ..Patch::default() }).unwrap();
        assert_eq!(may(None), Ok(()));
        t.s.revoke(&ada, &id).unwrap();
        assert_eq!(may(None), Err(Refused::Gone("revoked")));
        // sharing again brings it back
        t.s.put(&ada, &put(&k, "x", "y")).unwrap();
        assert_eq!(may(None), Ok(()));
    }

    #[test]
    fn views_and_imports_are_counted() {
        let t = t();
        let (ada, bo) = (t.a.dev_user("ada").unwrap(), t.a.dev_user("bo").unwrap());
        let k = SigningKey::from_bytes(&[1; 32]);
        let id = t.s.put(&ada, &put(&k, "x", "x")).unwrap()["id"].as_str().unwrap().to_owned();
        let s = t.s.get(&id).unwrap().unwrap();
        t.s.read(&s, Some(&ada), None, true).unwrap().unwrap();
        t.s.read(&s, Some(&bo), None, true).unwrap().unwrap();
        t.s.read(&s, None, None, true).unwrap().unwrap();
        t.s.count_import(&s, Some(&bo)).unwrap();
        t.s.count_import(&s, Some(&ada)).unwrap();
        let s = t.s.get(&id).unwrap().unwrap();
        assert_eq!((s.views, s.imports), (2, 1));
    }

    #[test]
    fn the_gallery_lists_only_what_was_published() {
        let t = t();
        let ada = t.a.dev_user("ada").unwrap();
        let k = SigningKey::from_bytes(&[1; 32]);
        let one = t.s.put(&ada, &Put { publish: Some(true), summary: "reviews every PR".into(), tags: vec!["Review".into()], ..put(&k, "review", "a") }).unwrap();
        t.s.put(&ada, &put(&k, "private", "b")).unwrap();
        let found = t.s.gallery("", None).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0]["card"]["id"], one["id"]);
        assert_eq!(t.s.gallery("every review", None).unwrap().len(), 1);
        assert_eq!(t.s.gallery("deploy", None).unwrap().len(), 0);
        assert_eq!(t.s.gallery("", Some("task")).unwrap().len(), 0);
        // locked or revoked: out of the gallery
        let id = one["id"].as_str().unwrap();
        t.s.patch(&ada, id, &Patch { access: Some(Access { kind: "password".into(), password: Some("p".into()), ..Access::default() }), ..Patch::default() }).unwrap();
        assert_eq!(t.s.gallery("", None).unwrap().len(), 0);
    }
}
