//! The durable event log (ADR-0044): `event`, `event_cursor` and `event_parked`, kernel-owned tables.
//!
//! - `event` is rowid-only (no secondary index, as `change`): `seq` is the rowid. One writer appends, so
//!   committed seqs are contiguous (what the kernel's workers rely on to never skip one). `data` is compact
//!   JSON, zstd above 1 KB (`codec` 1).
//! - **In the command's transaction:** `Store::write` asks the kernel (`durable::take`) for the durable
//!   events the running command emitted so far and the cursor of the handler it runs in, and writes them
//!   in the same transaction as the command's own ops. A rollback takes them with it.
//! - **Dedupe:** a `(type, key)` appended within 24 h is recorded once. The keys of the last 24 h are kept in
//!   memory (read back at open), so the check needs no index.
//! - **Retention:** 30 days or 1 M rows, whichever is first, trimmed from the oldest every 10 k appends and at
//!   open. A cursor behind the first kept seq gets a gap from the kernel.
use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;
use wisp_kernel::BoxFuture;
use wisp_kernel::durable::{EventLog, NewEvent, Parked, StoredEvent};

use crate::error::{Result, StoreError};
use crate::store::{Store, lock};
use crate::writer::Writer;

pub const DEDUPE_MS: i64 = 24 * 3_600_000;
pub const KEEP_MS: i64 = 30 * 24 * 3_600_000;
pub const KEEP_ROWS: i64 = 1_000_000;
const TRIM_EVERY: u64 = 10_000;
const ZSTD_OVER: usize = 1024;

/// The tables, as the kernel owner's migration 2.
pub const SQL: &str = r"
    CREATE TABLE event (
      seq INTEGER PRIMARY KEY,
      type TEXT NOT NULL,
      plugin TEXT NOT NULL,
      subject TEXT,
      key TEXT,
      cause INTEGER,
      root TEXT NOT NULL,
      at INTEGER NOT NULL,
      codec INTEGER NOT NULL DEFAULT 0,
      data BLOB NOT NULL
    ) STRICT;
    CREATE TABLE event_cursor (plugin TEXT NOT NULL, name TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (plugin, name)) STRICT, WITHOUT ROWID;
    CREATE TABLE event_parked (plugin TEXT NOT NULL, name TEXT NOT NULL, seq INTEGER NOT NULL, why TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (plugin, name, seq)) STRICT, WITHOUT ROWID;
";

/// What the store keeps in memory for the log.
#[derive(Debug, Default)]
pub(crate) struct LogState {
    /// (type, key) → when it was appended, the last 24 h
    pub(crate) recent: Mutex<HashMap<(String, String), i64>>,
    pub(crate) appended: AtomicU64,
}

fn encode(v: &Value) -> (i64, Vec<u8>) {
    let raw = serde_json::to_vec(v).unwrap_or_default();
    if raw.len() > ZSTD_OVER
        && let Ok(z) = zstd::encode_all(raw.as_slice(), 3)
    {
        return (1, z);
    }
    (0, raw)
}

fn decode(codec: i64, b: &[u8]) -> Value {
    let raw = if codec == 1 { zstd::decode_all(b).unwrap_or_default() } else { b.to_vec() };
    serde_json::from_slice(&raw).unwrap_or(Value::Null)
}

/// Appends `rows` on `db` (inside the caller's transaction), deduping by (type, key) within 24 h. Keys it
/// added are returned so a rollback can take them out again.
/// Each row's seq (`None`: a repeat), and the dedupe keys added.
type Appended = (Vec<Option<u64>>, Vec<(String, String)>);

pub(crate) fn append_on(db: &Connection, st: &LogState, now: i64, rows: &[NewEvent]) -> Result<Appended> {
    let mut out = Vec::with_capacity(rows.len());
    let mut added = Vec::new();
    let mut recent = lock(&st.recent);
    for r in rows {
        if let Some(k) = &r.key {
            let id = (r.ty.clone(), k.clone());
            if recent.get(&id).is_some_and(|at| now - at < DEDUPE_MS) {
                out.push(None);
                continue;
            }
            recent.insert(id.clone(), now);
            added.push(id);
        }
        let (codec, data) = encode(&r.data);
        db.prepare_cached(
            "INSERT INTO event (type, plugin, subject, key, cause, root, at, codec, data) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        )?
        .execute(params![
            r.ty,
            r.plugin,
            r.subject,
            r.key,
            r.cause.and_then(|c| i64::try_from(c).ok()),
            r.root,
            if r.at > 0 { r.at } else { now },
            codec,
            data
        ])?;
        out.push(u64::try_from(db.last_insert_rowid()).ok());
    }
    Ok((out, added))
}

pub(crate) fn forget(st: &LogState, keys: &[(String, String)]) {
    let mut recent = lock(&st.recent);
    for k in keys {
        recent.remove(k);
    }
}

pub(crate) fn set_cursor_on(db: &Connection, plugin: &str, name: &str, seq: u64) -> Result<()> {
    db.prepare_cached("INSERT INTO event_cursor (plugin, name, seq) VALUES (?1, ?2, ?3) ON CONFLICT (plugin, name) DO UPDATE SET seq = max(seq, excluded.seq)")?
        .execute(params![plugin, name, i64::try_from(seq).unwrap_or(i64::MAX)])?;
    Ok(())
}

/// Trims what's past retention: older than 30 days, or beyond the newest 1 M.
pub(crate) fn trim_on(db: &Connection, now: i64, keep_ms: i64, keep_rows: i64) -> Result<usize> {
    let max: i64 = db.query_row("SELECT coalesce(max(seq), 0) FROM event", [], |r| r.get(0))?;
    let a = db.execute("DELETE FROM event WHERE seq <= ?1", [max - keep_rows])?;
    // oldest first: stop at the first row young enough (rowid order is time order)
    let cut: Option<i64> =
        db.query_row("SELECT seq FROM event WHERE at >= ?1 ORDER BY seq LIMIT 1", [now - keep_ms], |r| r.get(0)).optional()?;
    let b = match cut {
        Some(s) => db.execute("DELETE FROM event WHERE seq < ?1", [s])?,
        None => db.execute("DELETE FROM event", [])?,
    };
    Ok(a + b)
}

fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<StoredEvent> {
    let codec: i64 = r.get(8)?;
    let data: Vec<u8> = r.get(9)?;
    Ok(StoredEvent {
        seq: u64::try_from(r.get::<_, i64>(0)?).unwrap_or(0),
        event: NewEvent {
            ty: r.get(1)?,
            plugin: r.get(2)?,
            subject: r.get(3)?,
            key: r.get(4)?,
            cause: r.get::<_, Option<i64>>(5)?.and_then(|c| u64::try_from(c).ok()),
            root: r.get(6)?,
            at: r.get(7)?,
            data: decode(codec, &data),
        },
    })
}

const COLS: &str = "seq, type, plugin, subject, key, cause, root, at, codec, data";

impl Store {
    /// At open: the dedupe keys of the last 24 h, and a first trim.
    pub(crate) fn init_events(&self) -> Result<()> {
        let now = self.shared.clock.now_ms();
        let keys: Vec<(String, String, i64)> = self.read(|r| {
            let mut s = r.db.prepare("SELECT type, key, at FROM event WHERE key IS NOT NULL AND seq >= coalesce((SELECT seq FROM event WHERE at >= ?1 ORDER BY seq LIMIT 1), 9223372036854775807)")?;
            let v = s.query_map([now - DEDUPE_MS], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(v)
        })?;
        {
            let mut recent = lock(&self.shared.log.recent);
            for (t, k, at) in keys {
                recent.insert((t, k), at);
            }
        }
        self.thread.run_raw(move |db| trim_on(db, now, KEEP_MS, KEEP_ROWS).map(|_| ()))
    }

    /// Trims now with these limits (tests, and `wisp events` maintenance).
    pub async fn trim_events(&self, keep_ms: i64, keep_rows: i64) -> Result<usize> {
        self.write(move |w| {
            let now = w.now();
            trim_on(w.db, now, keep_ms, keep_rows)
        })
        .await
    }

    fn after_append(&self, n: usize) {
        let before = self.shared.log.appended.fetch_add(n as u64, Ordering::Relaxed);
        if before / TRIM_EVERY != (before + n as u64) / TRIM_EVERY {
            let now = self.shared.clock.now_ms();
            let s = self.clone();
            s.write_detached(move |w| trim_on(w.db, now, KEEP_MS, KEEP_ROWS).map(|_| ()));
        }
    }

    /// `write`, carrying the running command's durable events and its handler's cursor (ADR-0044).
    pub(crate) async fn write_durable<T, F>(&self, intx: wisp_kernel::durable::InTx, f: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Writer<'_>) -> Result<T> + Send + 'static,
    {
        let rows = intx.rows().to_vec();
        let cursor = intx.cursor().map(|(p, n, s)| (p.to_owned(), n.to_owned(), s));
        let n = rows.len();
        let shared = self.shared.clone();
        let added = std::sync::Arc::new(Mutex::new(Vec::new()));
        let added2 = added.clone();
        let r = self
            .thread
            .queued(move |s| {
                crate::thread::transact(s, move |w| {
                    let v = f(w)?;
                    let now = w.now();
                    let (seqs, keys) = append_on(w.db, &shared.log, now, &rows)?;
                    *lock(&added2) = keys;
                    if let Some((p, name, seq)) = &cursor {
                        set_cursor_on(w.db, p, name, *seq)?;
                    }
                    Ok::<(T, Vec<Option<u64>>), StoreError>((v, seqs))
                })
            })
            .await;
        match r {
            Ok((v, seqs)) => {
                intx.committed(&seqs);
                self.after_append(n);
                Ok(v)
            }
            Err(e) => {
                forget(&self.shared.log, &lock(&added));
                intx.rolled_back();
                Err(e)
            }
        }
    }
}

fn i(s: u64) -> i64 {
    i64::try_from(s).unwrap_or(i64::MAX)
}

fn wire(e: &StoreError) -> wisp_kernel::WireError {
    wisp_kernel::WireError::internal(e.to_string())
}

impl EventLog for Store {
    fn append(&self, rows: Vec<NewEvent>) -> BoxFuture<'static, wisp_kernel::Result<Vec<Option<u64>>>> {
        let s = self.clone();
        Box::pin(async move {
            let n = rows.len();
            let shared = s.shared.clone();
            let added = std::sync::Arc::new(Mutex::new(Vec::new()));
            let added2 = added.clone();
            let r = s
                .thread
                .queued(move |st| {
                    crate::thread::transact(st, move |w| {
                        let now = w.now();
                        let (seqs, keys) = append_on(w.db, &shared.log, now, &rows)?;
                        *lock(&added2) = keys;
                        Ok(seqs)
                    })
                })
                .await;
            match r {
                Ok(v) => {
                    s.after_append(n);
                    Ok(v)
                }
                Err(e) => {
                    forget(&s.shared.log, &lock(&added));
                    Err(wire(&e))
                }
            }
        })
    }
    fn read(&self, after: u64, limit: usize) -> BoxFuture<'static, wisp_kernel::Result<Vec<StoredEvent>>> {
        let s = self.clone();
        Box::pin(async move {
            s.read_async(move |r| {
                let mut st = r.db.prepare_cached(&format!("SELECT {COLS} FROM event WHERE seq > ?1 ORDER BY seq LIMIT ?2"))?;
                Ok(st.query_map(params![i(after), i64::try_from(limit).unwrap_or(256)], row)?.collect::<rusqlite::Result<Vec<_>>>()?)
            })
            .await
            .map_err(|e| wire(&e))
        })
    }
    fn get(&self, seq: u64) -> BoxFuture<'static, wisp_kernel::Result<Option<StoredEvent>>> {
        let s = self.clone();
        Box::pin(async move {
            s.read_async(move |r| {
                Ok(r.db.prepare_cached(&format!("SELECT {COLS} FROM event WHERE seq = ?1"))?.query_row([i(seq)], row).optional()?)
            })
            .await
            .map_err(|e| wire(&e))
        })
    }
    fn bounds(&self) -> BoxFuture<'static, wisp_kernel::Result<(u64, u64)>> {
        let s = self.clone();
        Box::pin(async move {
            s.read_async(|r| {
                let (a, b): (i64, i64) =
                    r.db.query_row("SELECT coalesce(min(seq), 0), coalesce(max(seq), 0) FROM event", [], |x| Ok((x.get(0)?, x.get(1)?)))?;
                Ok((u64::try_from(a).unwrap_or(0), u64::try_from(b).unwrap_or(0)))
            })
            .await
            .map_err(|e| wire(&e))
        })
    }
    fn cursor(&self, plugin: &str, name: &str) -> BoxFuture<'static, wisp_kernel::Result<Option<u64>>> {
        let (s, p, n) = (self.clone(), plugin.to_owned(), name.to_owned());
        Box::pin(async move {
            s.read_async(move |r| {
                Ok(r.db
                    .query_row("SELECT seq FROM event_cursor WHERE plugin = ?1 AND name = ?2", params![p, n], |x| x.get::<_, i64>(0))
                    .optional()?
                    .and_then(|v| u64::try_from(v).ok()))
            })
            .await
            .map_err(|e| wire(&e))
        })
    }
    fn set_cursor(&self, plugin: &str, name: &str, seq: u64) -> BoxFuture<'static, wisp_kernel::Result<()>> {
        let (s, p, n) = (self.clone(), plugin.to_owned(), name.to_owned());
        Box::pin(async move { s.write(move |w| set_cursor_on(w.db, &p, &n, seq)).await.map_err(|e| wire(&e)) })
    }
    fn park(&self, x: Parked) -> BoxFuture<'static, wisp_kernel::Result<()>> {
        let s = self.clone();
        Box::pin(async move {
            s.write(move |w| {
                w.db.execute(
                    "INSERT OR REPLACE INTO event_parked (plugin, name, seq, why, at) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![x.plugin, x.name, i(x.seq), x.why, x.at],
                )?;
                Ok(())
            })
            .await
            .map_err(|e| wire(&e))
        })
    }
    fn parked(&self) -> BoxFuture<'static, wisp_kernel::Result<Vec<Parked>>> {
        let s = self.clone();
        Box::pin(async move {
            s.read_async(|r| {
                let mut st = r.db.prepare("SELECT plugin, name, seq, why, at FROM event_parked ORDER BY seq")?;
                Ok(st
                    .query_map([], |x| {
                        Ok(Parked {
                            plugin: x.get(0)?,
                            name: x.get(1)?,
                            seq: u64::try_from(x.get::<_, i64>(2)?).unwrap_or(0),
                            why: x.get(3)?,
                            at: x.get(4)?,
                        })
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?)
            })
            .await
            .map_err(|e| wire(&e))
        })
    }
    fn unpark(&self, plugin: &str, name: &str, seq: u64) -> BoxFuture<'static, wisp_kernel::Result<bool>> {
        let (s, p, n) = (self.clone(), plugin.to_owned(), name.to_owned());
        Box::pin(async move {
            s.write(move |w| {
                Ok(w.db.execute("DELETE FROM event_parked WHERE plugin = ?1 AND name = ?2 AND seq = ?3", params![p, n, i(seq)])? > 0)
            })
            .await
            .map_err(|e| wire(&e))
        })
    }
}
