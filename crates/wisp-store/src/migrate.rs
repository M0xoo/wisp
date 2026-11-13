//! Forward-only migrations, tracked per owner in `meta` (`schema:<owner>`, plan §4.2). Each step runs in
//! its own transaction. Before upgrading an owner that already has data, the whole database is copied
//! with `VACUUM INTO`, so a bad migration costs a restore, not the data. A database newer than the code is
//! refused: old code on a newer schema is how data gets silently dropped.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, params};

use crate::error::{Result, StoreError, invalid};

/// One step of an owner's schema. Version `n` is the `n`-th entry of the owner's list.
#[derive(Debug, Clone, Copy)]
pub struct Migration {
    pub version: u32,
    pub up: Up,
    /// for a table rebuild: foreign keys are off while it runs and checked before it commits
    pub foreign_keys_off: bool,
}

#[derive(Debug, Clone, Copy)]
pub enum Up {
    Sql(&'static str),
    /// a data migration in code; it runs inside the step's transaction
    Fn(fn(&Connection) -> Result<()>),
}

impl Migration {
    pub const fn sql(version: u32, sql: &'static str) -> Self {
        Self { version, up: Up::Sql(sql), foreign_keys_off: false }
    }
    pub const fn func(version: u32, f: fn(&Connection) -> Result<()>) -> Self {
        Self { version, up: Up::Fn(f), foreign_keys_off: false }
    }
    #[must_use]
    pub const fn with_foreign_keys_off(mut self) -> Self {
        self.foreign_keys_off = true;
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrateReport {
    pub from: u32,
    pub to: u32,
    /// the `VACUUM INTO` copy taken before the upgrade (none for a fresh owner or an in-memory store)
    pub snapshot: Option<PathBuf>,
}

/// snapshots kept per owner; older ones are removed after a new one is taken
const KEEP_SNAPSHOTS: usize = 3;

pub(crate) fn valid_owner(owner: &str) -> bool {
    let mut b = owner.bytes();
    b.next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && b.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"._-".contains(&c))
}

pub(crate) fn schema_version(db: &Connection, owner: &str) -> Result<u32> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT")?;
    let v: Option<String> = db.query_row("SELECT value FROM meta WHERE key = ?", [format!("schema:{owner}")], |r| r.get(0)).optional()?;
    v.map_or(Ok(0), |s| s.parse().map_err(|_| StoreError::Internal(format!("meta schema:{owner} is not a number: {s}"))))
}

pub(crate) fn run(db: &Connection, home: Option<&Path>, now: i64, owner: &str, list: &[Migration]) -> Result<MigrateReport> {
    if !valid_owner(owner) {
        return Err(invalid(format!("bad migration owner: {owner}")));
    }
    if !db.is_autocommit() {
        return Err(invalid(format!("migrate({owner}) inside a transaction: migrations run on their own")));
    }
    for (i, m) in list.iter().enumerate() {
        if m.version as usize != i + 1 {
            return Err(invalid(format!("{owner} migrations must be numbered 1, 2, 3, … in order; #{} says v{}", i + 1, m.version)));
        }
    }
    let from = schema_version(db, owner)?;
    let known = u32::try_from(list.len()).map_err(|_| invalid("too many migrations"))?;
    if from > known {
        let at = home.map_or_else(|| "backups/".to_owned(), |h| h.join("backups").display().to_string());
        return Err(StoreError::Conflict(format!(
            "the database has {owner} schema v{from}, but this wisp only knows up to v{known}: it was written by a newer wisp. Update wisp, or restore a backup from {at}."
        )));
    }
    if from == known {
        return Ok(MigrateReport { from, to: from, snapshot: None });
    }
    // A fresh owner (v0) has no data of its own to lose, so it gets no snapshot.
    let snapshot = match home {
        Some(h) if from > 0 => Some(snapshot(db, h, owner, from, now)?),
        _ => None,
    };
    for m in &list[from as usize..] {
        apply_one(db, owner, m)?;
    }
    db.flush_prepared_statement_cache(); // tables changed under cached statements
    Ok(MigrateReport { from, to: known, snapshot })
}

fn apply_one(db: &Connection, owner: &str, m: &Migration) -> Result<()> {
    // PRAGMA foreign_keys is a no-op inside a transaction, so it is switched around it.
    if m.foreign_keys_off {
        db.execute_batch("PRAGMA foreign_keys = OFF")?;
    }
    let out = step(db, owner, m);
    if m.foreign_keys_off {
        db.execute_batch("PRAGMA foreign_keys = ON")?;
    }
    out
}

fn step(db: &Connection, owner: &str, m: &Migration) -> Result<()> {
    db.execute_batch("BEGIN IMMEDIATE")?;
    let body = || -> Result<()> {
        match m.up {
            Up::Sql(sql) => db.execute_batch(sql)?,
            Up::Fn(f) => f(db)?,
        }
        if m.foreign_keys_off {
            let bad: i64 = db.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r.get(0))?;
            if bad > 0 {
                return Err(invalid(format!("{owner} v{} left {bad} rows with broken foreign keys", m.version)));
            }
        }
        db.execute(
            "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            params![format!("schema:{owner}"), m.version.to_string()],
        )?;
        Ok(())
    };
    match body() {
        Ok(()) => Ok(db.execute_batch("COMMIT")?),
        Err(e) => {
            db.execute_batch("ROLLBACK")?;
            Err(match e {
                StoreError::Invalid(_) | StoreError::Conflict(_) | StoreError::Wire(_) => e,
                other => StoreError::Internal(format!("{owner} migration v{} failed: {other}", m.version)),
            })
        }
    }
}

fn snapshot(db: &Connection, home: &Path, owner: &str, version: u32, now: i64) -> Result<PathBuf> {
    let dir = home.join("backups");
    fs::create_dir_all(&dir)?;
    let file = dir.join(format!("{owner}-v{version}-{now}.db"));
    if file.exists() {
        fs::remove_file(&file)?; // VACUUM INTO refuses an existing file
    }
    let target = file.to_str().ok_or_else(|| invalid("the backups path is not UTF-8"))?;
    db.execute("VACUUM INTO ?", [target])?;
    prune_snapshots(&dir, owner)?;
    Ok(file)
}

fn prune_snapshots(dir: &Path, owner: &str) -> Result<()> {
    let prefix = format!("{owner}-v");
    let mut mine: Vec<(i64, PathBuf)> = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        // <owner>-v<version>-<at>.db, and the owner part must match exactly (crew vs crew.x)
        let Some(rest) = name.strip_prefix(&prefix).and_then(|r| r.strip_suffix(".db")) else {
            continue;
        };
        let Some((v, at)) = rest.split_once('-') else {
            continue;
        };
        if let (true, Ok(at)) = (v.bytes().all(|c| c.is_ascii_digit()) && !v.is_empty(), at.parse::<i64>()) {
            mine.push((at, entry.path()));
        }
    }
    mine.sort_by_key(|m| std::cmp::Reverse(m.0));
    for (_, path) in mine.into_iter().skip(KEEP_SNAPSHOTS) {
        fs::remove_file(path)?;
    }
    Ok(())
}
