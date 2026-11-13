//! Sandboxes (v1 grid/sandboxes.js): a box of its own for one task. wisp (on a computer, or in the cloud wisp) asks
//! for one here; the task then runs in it instead of on that computer or in the user's own box. A sandbox is one
//! more of hostd's boxes, with a home of its own, so nothing in it can read the user's box or their other sandboxes.
//! wisp keeps it as a peer (a `grid` machine with its own token): ADR-0041's "sandboxes as peers".
//!
//! - **address:** `sb-<id>--<handle>.<domain>`, reached with its own token (`Bearer wsb_<id>_<secret>`): only that
//!   sandbox opens with it (`trust`: a sandbox's credential reaches that sandbox only).
//! - **sign-ins:** a box starts with an empty home. The user signs in once for all their sandboxes (a Claude token
//!   from `claude setup-token`), sealed per user, and every sandbox starts with it in its environment
//!   (`CLAUDE_CODE_OAUTH_TOKEN`). It never reaches the user's own box. The same for their env vars (names back,
//!   never values).
//! - **hostd:** the box is `{ id: "<user id>-sb-<id>", handle: <label>, owner, sandbox }`; hostd and boxd key
//!   everything on that id (its container `wisp-u-<id>`, its home).

use std::collections::BTreeMap;
use std::sync::Arc;

use rusqlite::{OptionalExtension as _, params};
use serde_json::{Value, json};

use crate::clock::SharedClock;
use crate::db::Db;
use crate::error::{Result, bad};
use crate::rows::{BoxUser, SandboxRow, UserRow};
use crate::secrets::{Secrets, safe_equal};

/// Sign-ins a sandbox can start with: the agent, the env var that carries it, what a token looks like, its name.
pub const LOGINS: [(&str, &str, &str, &str); 1] = [("claude", "CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-", "Claude")];
pub const ENV_MAX: usize = 40;

fn is_hex8(s: &str) -> bool {
    s.len() == 8 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `sb-<8 hex>--<handle>`
pub fn is_label(s: &str) -> bool {
    s.strip_prefix("sb-")
        .and_then(|r| r.split_once("--"))
        .is_some_and(|(id, h)| is_hex8(id) && !h.is_empty() && h.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'))
}

fn env_key_ok(k: &str) -> std::result::Result<(), String> {
    let mut b = k.bytes();
    let shaped = k.len() <= 64
        && b.next().is_some_and(|c| c.is_ascii_alphabetic() || c == b'_')
        && b.all(|c| c.is_ascii_alphanumeric() || c == b'_');
    if !shaped {
        return Err("A name like DATABASE_URL: letters, digits and _, not starting with a digit.".into());
    }
    let reserved = k.starts_with("WISP_")
        || k.starts_with("LD_")
        || ["CLAUDE_CODE_OAUTH_TOKEN", "PATH", "HOME", "USER", "SHELL", "NODE_OPTIONS", "HOSTNAME"].contains(&k);
    if reserved {
        return Err(format!("{k} is wisp's own: pick another name."));
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub struct Sandboxes {
    pub db: Arc<Db>,
    pub clock: SharedClock,
    /// None: the grid has no master key, so it can't seal a sandbox's token
    pub secrets: Option<Arc<Secrets>>,
    pub enabled: bool,
    pub per_user: i64,
}

impl Sandboxes {
    fn secrets(&self) -> Result<&Secrets> {
        self.secrets.as_deref().ok_or_else(|| bad("This grid has no master key, so it keeps no sandboxes.", 503))
    }

    pub fn get(&self, id: &str) -> Result<Option<SandboxRow>> {
        if !is_hex8(id) {
            return Ok(None);
        }
        self.db.with(|c| c.query_row("SELECT * FROM sandboxes WHERE id = ?1", [id], SandboxRow::from_row).optional())
    }

    pub fn by_label(&self, label: &str) -> Result<Option<SandboxRow>> {
        self.db.with(|c| crate::rows::find::sandbox_by_label(c, &label.to_lowercase()))
    }

    pub fn list(&self, user_id: &str) -> Result<Vec<SandboxRow>> {
        self.db.with(|c| {
            c.prepare_cached("SELECT * FROM sandboxes WHERE user_id = ?1 ORDER BY created_at")?
                .query_map([user_id], SandboxRow::from_row)?
                .collect()
        })
    }

    /// What hostd runs: its own box, keyed apart from the owner's.
    pub fn box_user(row: &SandboxRow) -> BoxUser {
        BoxUser {
            id: format!("{}-sb-{}", row.user_id, row.id),
            handle: row.label.clone(),
            sandbox: Some(row.id.clone()),
            owner: Some(row.user_id.clone()),
        }
    }

    pub fn view(row: &SandboxRow, url: &str) -> Value {
        json!({ "id": row.id, "name": row.name, "url": url, "createdAt": row.created_at })
    }

    /// A new sandbox for `user` (`taken`: a label some computer or handle already has) → its row and its bearer.
    pub fn create(&self, user: &UserRow, name: &str, taken: &dyn Fn(&str) -> bool) -> Result<(SandboxRow, String)> {
        if !self.enabled {
            return Err(bad("This grid doesn't make sandboxes.", 403));
        }
        let s = self.secrets()?;
        let have: i64 = self.db.with(|c| c.query_row("SELECT count(*) FROM sandboxes WHERE user_id = ?1", [&user.id], |r| r.get(0)))?;
        if have >= self.per_user {
            return Err(bad(
                format!("You have {have} sandboxes, the most this grid keeps. Delete a sandboxed task you're done with first."),
                409,
            ));
        }
        let (id, label) = loop {
            let id: String = (0..8).map(|_| char::from(b"0123456789abcdef"[usize::from(rand::random::<u8>() & 15)])).collect();
            let label = format!("sb-{id}--{}", user.handle);
            if self.get(&id)?.is_none() && !taken(&label) {
                break (id, label);
            }
        };
        let name: String = name.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(60).collect();
        let row = SandboxRow {
            id,
            user_id: user.id.clone(),
            label,
            name: if name.is_empty() { "Sandbox".into() } else { name },
            created_at: self.clock.now_ms(),
        };
        self.db.with(|c| {
            c.execute(
                "INSERT INTO sandboxes (id, user_id, label, name, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![row.id, row.user_id, row.label, row.name, row.created_at],
            )
        })?;
        let token = s.ensure(&row.user_id, &format!("sandbox:{}", row.id))?;
        Ok((row.clone(), format!("wsb_{}_{token}", row.id)))
    }

    /// Its row and secrets (the box and its home go first, through hostd).
    pub fn remove(&self, row: &SandboxRow) -> Result<()> {
        self.db.with(|c| c.execute("DELETE FROM sandboxes WHERE id = ?1", [&row.id]))?;
        if let Ok(s) = self.secrets() {
            s.drop_secret(&row.user_id, &format!("sandbox:{}", row.id))?;
        }
        Ok(())
    }

    /// The sandbox a `Bearer wsb_<id>_<secret>` opens, compared in constant time.
    pub fn by_bearer(&self, auth: &str) -> Option<SandboxRow> {
        let rest = auth.strip_prefix("Bearer ")?.trim().strip_prefix("wsb_")?;
        let (id, secret) = rest.split_once('_')?;
        let row = self.get(id).ok()??;
        let want = self.secrets().ok()?.open_secret(&row.user_id, &format!("sandbox:{}", row.id)).ok()??;
        safe_equal(secret, &want).then_some(row)
    }

    /// Which sign-ins the user's sandboxes start with (never the tokens).
    pub fn logins(&self, user_id: &str) -> Value {
        let s = self.secrets.as_deref();
        Value::Object(
            LOGINS
                .iter()
                .map(|(a, ..)| {
                    (
                        (*a).to_owned(),
                        json!(s.is_some_and(|s| s.open_secret(user_id, &format!("sandbox-login:{a}")).ok().flatten().is_some())),
                    )
                })
                .collect(),
        )
    }

    pub fn set_login(&self, user_id: &str, agent: &str, token: &str) -> Result<()> {
        let Some((_, _, prefix, name)) = LOGINS.iter().find(|(a, ..)| *a == agent) else {
            return Err(bad("Sandboxes can start signed in to Claude only.", 400));
        };
        let t = token.trim();
        let body = t.strip_prefix(prefix).unwrap_or_default();
        if !(20..=400).contains(&body.len()) || !body.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
            return Err(bad(format!("That isn't a {name} token (from `claude setup-token`)."), 400));
        }
        self.secrets()?.seal(user_id, &format!("sandbox-login:{agent}"), t)
    }

    pub fn drop_login(&self, user_id: &str, agent: &str) -> Result<()> {
        if !LOGINS.iter().any(|(a, ..)| *a == agent) {
            return Err(bad("No such sign-in.", 404));
        }
        self.secrets()?.drop_secret(user_id, &format!("sandbox-login:{agent}"))
    }

    fn read_env(&self, user_id: &str) -> BTreeMap<String, String> {
        self.secrets
            .as_deref()
            .and_then(|s| s.open_secret(user_id, "sandbox-env").ok().flatten())
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    /// Their env vars' names, never the values.
    pub fn env_keys(&self, user_id: &str) -> Vec<String> {
        self.read_env(user_id).into_keys().collect()
    }

    pub fn set_env(&self, user_id: &str, key: &str, value: &str) -> Result<()> {
        let k = key.trim();
        env_key_ok(k).map_err(|e| bad(e, 400))?;
        if value.is_empty() || value.len() > 8192 || value.contains(['\r', '\n', '\0']) {
            return Err(bad("A value on one line, up to 8 KB.", 400));
        }
        let mut env = self.read_env(user_id);
        if !env.contains_key(k) && env.len() >= ENV_MAX {
            return Err(bad(format!("Up to {ENV_MAX} env vars."), 400));
        }
        env.insert(k.to_owned(), value.to_owned());
        self.secrets()?.seal(user_id, "sandbox-env", &serde_json::to_string(&env).unwrap_or_default())
    }

    pub fn drop_env(&self, user_id: &str, key: &str) -> Result<()> {
        let mut env = self.read_env(user_id);
        env.remove(key);
        let s = self.secrets()?;
        if env.is_empty() {
            s.drop_secret(user_id, "sandbox-env")
        } else {
            s.seal(user_id, "sandbox-env", &serde_json::to_string(&env).unwrap_or_default())
        }
    }

    /// A sandbox's environment: its owner's env vars, then the sign-ins they gave sandboxes, and `WISP_SANDBOX`.
    pub fn env_for(&self, owner: &str) -> Vec<(String, String)> {
        let mut out: Vec<(String, String)> = self.read_env(owner).into_iter().collect();
        if let Some(s) = self.secrets.as_deref() {
            for (a, var, ..) in LOGINS {
                if let Ok(Some(t)) = s.open_secret(owner, &format!("sandbox-login:{a}")) {
                    out.push((var.to_owned(), t));
                }
            }
        }
        out.push(("WISP_SANDBOX".into(), "1".into()));
        out
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::clock::ManualClock;

    fn sb() -> (Sandboxes, UserRow) {
        let db = Arc::new(Db::memory().unwrap());
        let secrets = Some(Arc::new(Secrets::for_test(db.clone(), [3u8; 32]).unwrap()));
        let a = crate::accounts::Accounts { db: db.clone(), clock: ManualClock::new(1) };
        let ada = a.dev_user("ada").unwrap();
        (Sandboxes { db, clock: ManualClock::new(1_000), secrets, enabled: true, per_user: 2 }, ada)
    }

    #[test]
    fn a_sandboxs_token_opens_that_sandbox_only() {
        let (s, ada) = sb();
        let (one, t1) = s.create(&ada, "  fix   the login ", &|_| false).unwrap();
        let (two, t2) = s.create(&ada, "", &|_| false).unwrap();
        assert!(is_label(&one.label) && one.label.ends_with("--ada"));
        assert_eq!((one.name.as_str(), two.name.as_str()), ("fix the login", "Sandbox"));
        assert_eq!(s.by_bearer(&format!("Bearer {t1}")).map(|r| r.id), Some(one.id.clone()));
        assert_eq!(s.by_bearer(&format!("Bearer {t2}")).map(|r| r.id), Some(two.id.clone()));
        // another sandbox's id with this one's secret, or a changed secret: nothing
        let secret1 = t1.rsplit_once('_').unwrap().1;
        assert!(s.by_bearer(&format!("Bearer wsb_{}_{secret1}", two.id)).is_none());
        assert!(s.by_bearer(&format!("Bearer {t1}x")).is_none());
        assert!(s.by_bearer("Bearer wgd_device").is_none());
        // the box is keyed apart from the owner's
        let b = Sandboxes::box_user(&one);
        assert_eq!(
            (b.id, b.owner.as_deref(), b.sandbox.as_deref()),
            (format!("{}-sb-{}", ada.id, one.id), Some(ada.id.as_str()), Some(one.id.as_str()))
        );
        // the most per user, then removed: its token stops working
        assert!(s.create(&ada, "x", &|_| false).unwrap_err().to_string().contains("most"));
        s.remove(&one).unwrap();
        assert!(s.by_bearer(&format!("Bearer {t1}")).is_none());
    }

    #[test]
    fn sandbox_sign_ins_and_env_are_sealed_and_only_named_back() {
        let (s, ada) = sb();
        assert!(s.set_login(&ada.id, "claude", "not-a-token").is_err());
        let tok = format!("sk-ant-oat01-{}", "a".repeat(30));
        s.set_login(&ada.id, "claude", &tok).unwrap();
        assert_eq!(s.logins(&ada.id)["claude"], json!(true));
        s.set_env(&ada.id, "DATABASE_URL", "postgres://x").unwrap();
        for (k, v) in [("WISP_PORT", "1"), ("PATH", "/x"), ("1X", "y"), ("OK", "a\nb")] {
            assert!(s.set_env(&ada.id, k, v).is_err(), "{k}");
        }
        assert_eq!(s.env_keys(&ada.id), vec!["DATABASE_URL".to_owned()], "names back, never values");
        let env = s.env_for(&ada.id);
        assert!(
            env.contains(&("CLAUDE_CODE_OAUTH_TOKEN".into(), tok.clone()))
                && env.contains(&("WISP_SANDBOX".into(), "1".into()))
                && env.contains(&("DATABASE_URL".into(), "postgres://x".into()))
        );
        // sealed: the table holds no plain value
        let raw: Vec<String> = s.db.with(|c| c.prepare("SELECT sealed FROM user_secrets")?.query_map([], |r| r.get(0))?.collect()).unwrap();
        assert!(raw.iter().all(|v| !v.contains("postgres") && !v.contains("sk-ant")));
        s.drop_login(&ada.id, "claude").unwrap();
        s.drop_env(&ada.id, "DATABASE_URL").unwrap();
        assert_eq!((s.logins(&ada.id)["claude"].clone(), s.env_keys(&ada.id).len()), (json!(false), 0));
    }
}
