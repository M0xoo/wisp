//! The master keys: `secrets/master.json` (0600), or one key from the environment. Startup and CLI only.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};

use super::random_bytes;
use crate::config::Env;
use crate::error::{GridError, Result};

pub fn master_file(data_dir: &Path) -> PathBuf {
    data_dir.join("secrets").join("master.json")
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct MasterJson {
    #[serde(default)]
    current: String,
    #[serde(default)]
    keys: BTreeMap<String, String>,
}

fn write_master(f: &Path, j: &MasterJson) -> Result<()> {
    if let Some(d) = f.parent() {
        std::fs::create_dir_all(d)?;
        set_mode(d, 0o700)?;
    }
    std::fs::write(f, serde_json::to_string_pretty(j)?)?;
    set_mode(f, 0o600)
}

#[cfg(unix)]
fn set_mode(p: &Path, mode: u32) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode))?;
    Ok(())
}
#[cfg(not(unix))]
fn set_mode(_: &Path, _: u32) -> Result<()> {
    Ok(())
}

/// Make the master key file if there's none (init and dev do this; production may bring its own).
pub fn ensure_master(data_dir: &Path) -> Result<bool> {
    let f = master_file(data_dir);
    if f.exists() {
        return Ok(false);
    }
    let mut keys = BTreeMap::new();
    keys.insert("k1".to_owned(), STANDARD.encode(random_bytes(32)));
    write_master(
        &f,
        &MasterJson {
            current: "k1".into(),
            keys,
        },
    )?;
    Ok(true)
}

fn read_master_json(f: &Path) -> Result<MasterJson> {
    Ok(serde_json::from_str(&std::fs::read_to_string(f)?)?)
}

#[derive(Clone)]
pub(super) struct Masters {
    pub(super) current: String,
    pub(super) keys: BTreeMap<String, [u8; 32]>,
}

impl std::fmt::Debug for Masters {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Masters")
            .field("current", &self.current)
            .field("keys", &self.keys.keys())
            .finish()
    }
}

fn one_key(b64: &str, kid: &str) -> Result<[u8; 32]> {
    STANDARD
        .decode(b64.trim())
        .ok()
        .and_then(|k| <[u8; 32]>::try_from(k).ok())
        .ok_or_else(|| GridError::Config(format!("The master key {kid} isn’t 32 bytes of base64.")))
}

pub(super) fn load_masters(data_dir: &Path, env: &Env) -> Result<Masters> {
    let env_one = |k: [u8; 32]| Masters {
        current: "env".into(),
        keys: BTreeMap::from([("env".to_owned(), k)]),
    };
    if let Some(k) = env.get("GRID_MASTER_KEY").filter(|k| !k.is_empty()) {
        return Ok(env_one(one_key(k, "env")?));
    }
    if let Some(f) = env.get("GRID_MASTER_KEY_FILE").filter(|k| !k.is_empty()) {
        return Ok(env_one(one_key(&std::fs::read_to_string(f)?, "env")?));
    }
    let f = master_file(data_dir);
    if !f.exists() {
        return Err(GridError::Config(
            "No master key: run `wisp grid init`, or set GRID_MASTER_KEY(_FILE).".into(),
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if std::fs::metadata(&f)?.permissions().mode() & 0o077 != 0 {
            return Err(GridError::Config(format!(
                "{} is readable by others: chmod 600 it.",
                f.display()
            )));
        }
    }
    let j = read_master_json(&f)?;
    let keys = j
        .keys
        .iter()
        .map(|(kid, v)| Ok((kid.clone(), one_key(v, kid)?)))
        .collect::<Result<BTreeMap<_, _>>>()?;
    if !keys.contains_key(&j.current) {
        return Err(GridError::Config(format!(
            "master.json: the current key \"{}\" isn’t in keys.",
            j.current
        )));
    }
    Ok(Masters {
        current: j.current,
        keys,
    })
}

/// `wisp grid rotate-key`: a new current master key; the old ones stay until every DEK is re-wrapped.
pub fn add_master_key(data_dir: &Path) -> Result<String> {
    let f = master_file(data_dir);
    let mut j = read_master_json(&f)?;
    let n = j
        .keys
        .keys()
        .filter_map(|k| k.trim_start_matches('k').parse::<u64>().ok())
        .max()
        .unwrap_or(0)
        + 1;
    let kid = format!("k{n}");
    j.keys
        .insert(kid.clone(), STANDARD.encode(random_bytes(32)));
    j.current.clone_from(&kid);
    write_master(&f, &j)?;
    Ok(kid)
}

/// After rewrap: drop master keys no data key uses any more.
pub fn prune_master_keys(
    data_dir: &Path,
    in_use: &std::collections::HashSet<String, impl std::hash::BuildHasher>,
) -> Result<Vec<String>> {
    let f = master_file(data_dir);
    let mut j = read_master_json(&f)?;
    let gone: Vec<String> = j
        .keys
        .keys()
        .filter(|k| **k != j.current && !in_use.contains(*k))
        .cloned()
        .collect();
    for k in &gone {
        j.keys.remove(k);
    }
    write_master(&f, &j)?;
    Ok(gone)
}
