//! The grid's keys and every secret it keeps for users. Envelope encryption: each user has a random
//! data key (DEK) that seals their secrets (AES-256-GCM, bound to "user|purpose"); the DEK itself is
//! stored wrapped by a master key (KEK) with a key id, so rotating the master re-wraps small keys, not
//! data. Deleting a user's DEK makes everything sealed with it unreadable (crypto-shredding).
//!
//! The master key comes from `GRID_MASTER_KEY` (base64, 32 bytes), `GRID_MASTER_KEY_FILE`, or
//! `secrets/master.json` in the data folder (`{ current, keys: { <kid>: base64 } }`, made by init).
//! Read at start and by the CLI. The sealed format is v1's (`iv.tag.ct`, base64url), so a live grid.db
//! opens with the same master key.
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use rand::RngCore;
use rusqlite::OptionalExtension;
use sha2::{Digest, Sha256};

use crate::config::Env;
use crate::db::Db;
use crate::error::{GridError, Result};

pub fn b64u(b: impl AsRef<[u8]>) -> String {
    URL_SAFE_NO_PAD.encode(b)
}

pub fn unb64u(s: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(s.trim_end_matches('=')).ok()
}

/// sha256, base64url: how every token is kept (never the token itself).
pub fn sha256(s: impl AsRef<[u8]>) -> String {
    b64u(Sha256::digest(s.as_ref()))
}

/// sha256, hex.
pub fn sha256_hex(s: impl AsRef<[u8]>) -> String {
    hex(&Sha256::digest(s.as_ref()))
}

pub fn hex(b: &[u8]) -> String {
    use std::fmt::Write;
    b.iter()
        .fold(String::with_capacity(b.len() * 2), |mut s, x| {
            let _ = write!(s, "{x:02x}");
            s
        })
}

/// `n` random bytes.
pub fn random_bytes(n: usize) -> Vec<u8> {
    let mut b = vec![0u8; n];
    rand::rng().fill_bytes(&mut b);
    b
}

/// A fresh token: `prefix` + `n` random bytes, base64url.
pub fn token(prefix: &str, n: usize) -> String {
    format!("{prefix}{}", b64u(random_bytes(n)))
}

/// Constant-time string compare.
pub fn safe_equal(a: &str, b: &str) -> bool {
    use subtle::ConstantTimeEq;
    a.len() == b.len() && bool::from(a.as_bytes().ct_eq(b.as_bytes()))
}

fn gcm(key: &[u8; 32], plain: &[u8], aad: &str) -> Result<String> {
    let iv = random_bytes(12);
    let c = Aes256Gcm::new(key.into());
    let mut out = c
        .encrypt(
            Nonce::from_slice(&iv),
            Payload {
                msg: plain,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| GridError::Crypto("Can’t seal a secret.".into()))?;
    // aes-gcm appends the 16-byte tag; v1's format keeps it apart: iv.tag.ct
    let tag = out.split_off(out.len() - 16);
    Ok(format!("{}.{}.{}", b64u(&iv), b64u(&tag), b64u(&out)))
}

fn ungcm(key: &[u8; 32], sealed: &str, aad: &str) -> Result<Vec<u8>> {
    let damaged = || GridError::Crypto("A sealed secret is damaged.".into());
    let mut parts = sealed.split('.').map(unb64u);
    let (Some(Some(iv)), Some(Some(tag)), Some(Some(mut ct))) =
        (parts.next(), parts.next(), parts.next())
    else {
        return Err(damaged());
    };
    if iv.len() != 12 || tag.len() != 16 {
        return Err(damaged());
    }
    ct.extend_from_slice(&tag);
    Aes256Gcm::new(key.into())
        .decrypt(
            Nonce::from_slice(&iv),
            Payload {
                msg: &ct,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| damaged())
}

mod master;
use master::{Masters, load_masters};
pub use master::{add_master_key, ensure_master, master_file, prune_master_keys};

/// The grid's secrets: signatures for what it hands out, and each user's sealed values.
#[derive(Clone)]
pub struct Secrets {
    db: Arc<Db>,
    master: Masters,
    sign_key: [u8; 32],
}

impl std::fmt::Debug for Secrets {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Secrets")
            .field("kid", &self.master.current)
            .finish_non_exhaustive()
    }
}

type HmacSha256 = Hmac<Sha256>;

impl Secrets {
    pub fn open(db: Arc<Db>, data_dir: &Path, env: &Env) -> Result<Self> {
        Self::with_masters(db, load_masters(data_dir, env)?)
    }

    /// For tests: one fixed master key.
    pub fn for_test(db: Arc<Db>, key: [u8; 32]) -> Result<Self> {
        Self::with_masters(
            db,
            Masters {
                current: "k1".into(),
                keys: BTreeMap::from([("k1".to_owned(), key)]),
            },
        )
    }

    fn with_masters(db: Arc<Db>, master: Masters) -> Result<Self> {
        let kek = *master
            .keys
            .get(&master.current)
            .ok_or_else(|| GridError::Crypto("no current master key".into()))?;
        // Keys derived from the master for one job each: cookie signatures, CSRF tokens.
        let mut sign_key = [0u8; 32];
        hkdf::Hkdf::<Sha256>::new(Some(&[]), &kek)
            .expand(b"wisp-grid sign", &mut sign_key)
            .map_err(|_| GridError::Crypto("hkdf".into()))?;
        Ok(Self {
            db,
            master,
            sign_key,
        })
    }

    /// The current master key's id.
    pub fn kid(&self) -> &str {
        &self.master.current
    }

    fn kek(&self, kid: &str) -> Result<[u8; 32]> {
        self.master.keys.get(kid).copied().ok_or_else(|| {
            GridError::Crypto(format!(
                "The master key \"{kid}\" that wrapped this data key is gone."
            ))
        })
    }

    fn dek(&self, user_id: &str, create: bool) -> Result<Option<[u8; 32]>> {
        let row: Option<(String, String)> = self.db.with(|c| {
            c.prepare_cached("SELECT kid, wrapped FROM keys WHERE user_id = ?1")?
                .query_row([user_id], |r| Ok((r.get(0)?, r.get(1)?)))
                .optional()
        })?;
        let aad = format!("dek|{user_id}");
        if let Some((kid, wrapped)) = row {
            let k = ungcm(&self.kek(&kid)?, &wrapped, &aad)?;
            return Ok(Some(<[u8; 32]>::try_from(k).map_err(|_| {
                GridError::Crypto("A data key is damaged.".into())
            })?));
        }
        if !create {
            return Ok(None);
        }
        let mut k = [0u8; 32];
        rand::rng().fill_bytes(&mut k);
        let wrapped = gcm(&self.kek(&self.master.current)?, &k, &aad)?;
        self.db.with(|c| {
            c.prepare_cached("INSERT INTO keys (user_id, kid, wrapped) VALUES (?1, ?2, ?3)")?
                .execute([user_id, &self.master.current, &wrapped])
        })?;
        Ok(Some(k))
    }

    /// HMAC for values we hand out and take back (cookies, state).
    pub fn sign(&self, s: &str) -> String {
        let Ok(mut m) = <HmacSha256 as KeyInit>::new_from_slice(&self.sign_key) else {
            return String::new();
        };
        m.update(s.as_bytes());
        b64u(m.finalize().into_bytes())
    }

    pub fn verify(&self, s: &str, sig: &str) -> bool {
        safe_equal(&self.sign(s), sig)
    }

    pub fn seal(&self, user_id: &str, purpose: &str, plain: &str) -> Result<()> {
        let k = self
            .dek(user_id, true)?
            .ok_or_else(|| GridError::Crypto("No data key.".into()))?;
        let sealed = gcm(&k, plain.as_bytes(), &format!("{user_id}|{purpose}"))?;
        self.db.with(|c| {
            c.prepare_cached(
                "INSERT INTO user_secrets (user_id, purpose, sealed) VALUES (?1, ?2, ?3) \
                 ON CONFLICT(user_id, purpose) DO UPDATE SET sealed = excluded.sealed",
            )?
            .execute([user_id, purpose, &sealed])
        })?;
        Ok(())
    }

    pub fn open_secret(&self, user_id: &str, purpose: &str) -> Result<Option<String>> {
        let sealed: Option<String> = self.db.with(|c| {
            c.prepare_cached("SELECT sealed FROM user_secrets WHERE user_id = ?1 AND purpose = ?2")?
                .query_row([user_id, purpose], |r| r.get(0))
                .optional()
        })?;
        let Some(sealed) = sealed else {
            return Ok(None);
        };
        let Some(k) = self.dek(user_id, false)? else {
            return Ok(None);
        };
        let plain = ungcm(&k, &sealed, &format!("{user_id}|{purpose}"))?;
        Ok(Some(String::from_utf8_lossy(&plain).into_owned()))
    }

    pub fn drop_secret(&self, user_id: &str, purpose: &str) -> Result<()> {
        self.db.with(|c| {
            c.prepare_cached("DELETE FROM user_secrets WHERE user_id = ?1 AND purpose = ?2")?
                .execute([user_id, purpose])
        })?;
        Ok(())
    }

    /// The user's secret for `purpose`, made once (a 32-byte token unless `make` says otherwise).
    pub fn ensure(&self, user_id: &str, purpose: &str) -> Result<String> {
        self.ensure_with(user_id, purpose, || token("", 32))
    }

    pub fn ensure_with(
        &self,
        user_id: &str,
        purpose: &str,
        make: impl FnOnce() -> String,
    ) -> Result<String> {
        if let Some(have) = self
            .open_secret(user_id, purpose)?
            .filter(|s| !s.is_empty())
        {
            return Ok(have);
        }
        let v = make();
        self.seal(user_id, purpose, &v)?;
        Ok(v)
    }

    /// Re-wrap every data key with the current master key. Returns how many moved.
    pub fn rewrap(&self) -> Result<usize> {
        let rows: Vec<(String, String, String)> = self.db.with(|c| {
            c.prepare_cached("SELECT user_id, kid, wrapped FROM keys WHERE kid != ?1")?
                .query_map([&self.master.current], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                })?
                .collect()
        })?;
        let cur = self.kek(&self.master.current)?;
        for (user, kid, wrapped) in &rows {
            let aad = format!("dek|{user}");
            let k = ungcm(&self.kek(kid)?, wrapped, &aad)?;
            let again = gcm(&cur, &k, &aad)?;
            self.db.with(|c| {
                c.prepare_cached("UPDATE keys SET kid = ?1, wrapped = ?2 WHERE user_id = ?3")?
                    .execute([&self.master.current, &again, user])
            })?;
        }
        Ok(rows.len())
    }

    /// Crypto-shred: the user's data key and everything sealed with it.
    pub fn forget(&self, user_id: &str) -> Result<()> {
        self.db.with(|c| {
            c.prepare_cached("DELETE FROM user_secrets WHERE user_id = ?1")?
                .execute([user_id])?;
            c.prepare_cached("DELETE FROM keys WHERE user_id = ?1")?
                .execute([user_id])
        })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests;
