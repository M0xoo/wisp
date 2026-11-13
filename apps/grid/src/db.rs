//! The grid's control-plane database (ADR-0014): one SQLite file, WAL, forward-only migrations
//! (`migrations.rs`). Not wisp-store: grid.db is live on every grid with `meta(k, v)` and a plain schema
//! counter, and the grid has no peers to sync with, so a change feed would only add write
//! amplification. It keeps the store's discipline instead: numbered migrations that only add, each in
//! its own transaction, a database newer than the code refused, and a `VACUUM INTO` copy taken before
//! an upgrade touches a database that holds data.
//!
//! One connection behind a mutex. Every query here is a few rows by primary key, well under a
//! millisecond in WAL mode, so callers on the async edge run them inline rather than paying a thread
//! hop each time; anything that scans (backup, the CLI's lists) is off the request path.
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use rusqlite::{Connection, OptionalExtension, Transaction};

use crate::error::{GridError, Result};
use crate::migrations::MIGRATIONS;

#[derive(Debug)]
pub struct Db {
    conn: Mutex<Connection>,
    dir: Option<PathBuf>,
}

/// Where the copy taken before an upgrade goes, next to grid.db.
pub fn backups_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("backups")
}

fn quote(p: &Path) -> String {
    p.to_string_lossy().replace('\'', "''")
}

fn schema_of(conn: &Connection) -> Result<usize> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)")?;
    let v: Option<String> = conn.query_row("SELECT v FROM meta WHERE k = 'schema'", [], |r| r.get(0)).optional()?;
    Ok(v.and_then(|s| s.parse().ok()).unwrap_or(0))
}

fn migrate(conn: &mut Connection, dir: Option<&Path>, now_ms: i64) -> Result<()> {
    let at = schema_of(conn)?;
    if at > MIGRATIONS.len() {
        let hint = dir.map_or_else(String::new, |d| format!(", or restore a copy from {}", backups_dir(d).display()));
        return Err(GridError::Config(format!(
            "grid.db has schema v{at}, but this grid only knows up to v{}: a newer grid wrote it. Update{hint}.",
            MIGRATIONS.len()
        )));
    }
    if at == MIGRATIONS.len() {
        return Ok(());
    }
    // A fresh database has nothing to lose; one with data gets a copy first.
    if let (true, Some(d)) = (at > 0, dir) {
        std::fs::create_dir_all(backups_dir(d))?;
        let file = backups_dir(d).join(format!("grid-v{at}-{now_ms}.db"));
        conn.execute_batch(&format!("VACUUM INTO '{}'", quote(&file)))?;
    }
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(at) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.execute("INSERT INTO meta (k, v) VALUES ('schema', ?1) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [(i + 1).to_string()])?;
        tx.commit()?;
    }
    Ok(())
}

fn pragmas(conn: &Connection) -> Result<()> {
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")?;
    Ok(())
}

impl Db {
    /// Open (and migrate) `<data_dir>/grid.db`. Startup only: the folder is made if it's missing.
    pub fn open(data_dir: &Path, now_ms: i64) -> Result<Self> {
        std::fs::create_dir_all(data_dir)?;
        let mut conn = Connection::open(data_dir.join("grid.db"))?;
        pragmas(&conn)?;
        migrate(&mut conn, Some(data_dir), now_ms)?;
        Ok(Self { conn: Mutex::new(conn), dir: Some(data_dir.to_path_buf()) })
    }

    /// A private in-memory grid.db, for tests.
    pub fn memory() -> Result<Self> {
        let mut conn = Connection::open_in_memory()?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        migrate(&mut conn, None, 0)?;
        Ok(Self { conn: Mutex::new(conn), dir: None })
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        // A panic while holding the lock leaves SQLite itself consistent (statements are atomic), so a
        // poisoned lock is still safe to use.
        self.conn.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Run queries on the connection. Use `prepare_cached`: every query in the grid is a literal.
    pub fn with<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<T> {
        Ok(f(&self.lock())?)
    }

    /// Like `with`, for closures that fail with a `GridError` of their own.
    pub fn with_grid<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        f(&self.lock())
    }

    /// One transaction: committed if `f` returns Ok, rolled back otherwise.
    pub fn tx<T>(&self, f: impl FnOnce(&Transaction<'_>) -> Result<T>) -> Result<T> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        let out = f(&tx)?;
        tx.commit()?;
        Ok(out)
    }

    /// A consistent copy while running (`wisp grid backup`).
    pub fn backup(&self, file: &Path) -> Result<()> {
        match std::fs::remove_file(file) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        self.lock().execute_batch(&format!("VACUUM INTO '{}'", quote(file)))?;
        Ok(())
    }

    /// The data folder grid.db is in (None for an in-memory one).
    pub fn dir(&self) -> Option<&Path> {
        self.dir.as_deref()
    }

    /// The schema version in `meta`.
    pub fn schema(&self) -> Result<usize> {
        schema_of(&self.lock())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migrations::tables;

    #[test]
    fn fresh_db_has_every_table_and_the_latest_schema() {
        let db = Db::memory().unwrap();
        assert_eq!(db.schema().unwrap(), MIGRATIONS.len());
        let have: Vec<String> = db
            .with(|c| {
                let mut s = c.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")?;
                s.query_map([], |r| r.get(0))?.collect()
            })
            .unwrap();
        let mut want: Vec<String> = tables().iter().map(|s| (*s).to_owned()).collect();
        let mut have = have;
        want.sort();
        have.sort();
        assert_eq!(have, want);
        // v1's grid.db: 25 tables made by 11 migrations, plus meta; v2's 12th adds share_versions, teams
        // and team_members (ADR-0038, ADR-0041); the 13th adds channel_urls.channel_key (Discord's key), no table.
        assert_eq!(want.len(), 29);
        assert_eq!(MIGRATIONS.len(), 13);
    }
}
