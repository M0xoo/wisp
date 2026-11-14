//! A launched app's own SQLite database (v1 server/app-db.js + app-db-worker.js): one connection per
//! file, opened on its first query with v1's limits (a size cap by `max_page_count`, WAL, a busy
//! timeout), seeded once from the app's seed SQL, and every query stopped past [`TIMEOUT_MS`] through
//! SQLite's interrupt. The SQL itself was checked by `wisp_stuff_core::appdb::parse_query`. Queries run
//! on the blocking pool: never on a request's worker.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::types::Value as Sql;
use rusqlite::{Connection, params_from_iter};
use serde_json::{Map, Value, json};
use wisp_stuff_core::appdb::{
    MAX_BYTES, MAX_ROWS, Param, Query, Refused, SEEDING, TIMEOUT_MS, error_words, max_pages, returns_rows, timeout_words,
};

/// What the page gets for an app with no database.
pub fn no_db() -> Value {
    json!({ "error": "This app has no database: put \"db\": true in its wisp-app.json." })
}

#[derive(Debug)]
pub struct AppDb {
    open: Mutex<HashMap<PathBuf, Arc<Mutex<Connection>>>>,
    max_bytes: u64,
    timeout_ms: u64,
}

impl Default for AppDb {
    fn default() -> Self {
        Self::new(MAX_BYTES, TIMEOUT_MS)
    }
}

fn refuse(status: u16, m: impl Into<String>) -> Refused {
    (status, m.into())
}

fn connect(file: &Path, max_bytes: u64) -> rusqlite::Result<Connection> {
    let c = Connection::open(file)?;
    c.busy_timeout(Duration::from_millis(2000))?;
    c.execute_batch(&format!("PRAGMA page_size = 4096; PRAGMA journal_mode = WAL; PRAGMA max_page_count = {};", max_pages(max_bytes)))?;
    Ok(c)
}

/// A file a stopped seed left half made goes; then the seed runs on a database with no tables.
fn open_seeded(file: &Path, seed: &str, max_bytes: u64) -> Result<Connection, Refused> {
    let words = |e: rusqlite::Error| refuse(500, error_words(&e.to_string(), max_bytes));
    let mut c = connect(file, max_bytes).map_err(words)?;
    let v: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(words)?;
    if v == SEEDING {
        drop(c);
        for ext in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{ext}", file.display()));
        }
        c = connect(file, max_bytes).map_err(words)?;
    }
    let empty = c.query_row("SELECT 1 FROM sqlite_schema LIMIT 1", [], |_| Ok(())).is_err();
    if !seed.trim().is_empty() && empty {
        c.execute_batch(&format!("PRAGMA user_version = {SEEDING};")).map_err(words)?;
        c.execute_batch(seed).map_err(|e| refuse(500, format!("The app's seed.sql failed: {}", error_words(&e.to_string(), max_bytes))))?;
        c.execute_batch("PRAGMA user_version = 0;").map_err(words)?;
    }
    Ok(c)
}

fn bind(p: &Param) -> Sql {
    match p {
        Param::Null => Sql::Null,
        Param::Int(i) => Sql::Integer(*i),
        Param::Real(f) => Sql::Real(*f),
        Param::Text(s) => Sql::Text(s.clone()),
    }
}

fn cell(v: rusqlite::types::ValueRef<'_>) -> Value {
    use rusqlite::types::ValueRef as R;
    match v {
        R::Null => Value::Null,
        R::Integer(i) => Value::from(i),
        R::Real(f) => Value::from(f),
        R::Text(t) => Value::from(String::from_utf8_lossy(t).into_owned()),
        // v1's node:sqlite gave a Uint8Array, which JSON wrote as an object of bytes
        R::Blob(b) => Value::Object(b.iter().enumerate().map(|(i, x)| (i.to_string(), Value::from(*x))).collect()),
    }
}

fn run(c: &Connection, q: &Query, max_bytes: u64) -> Result<Value, Refused> {
    let words = |e: rusqlite::Error| {
        let s = e.to_string();
        if s.contains("interrupted") { refuse(408, timeout_words(TIMEOUT_MS)) } else { refuse(400, error_words(&s, max_bytes)) }
    };
    let mut st = c.prepare(&q.sql).map_err(words)?;
    let params = params_from_iter(q.params.iter().map(bind));
    if returns_rows(&q.sql) {
        let names: Vec<String> = st.column_names().map(str::to_owned).collect();
        let mut rows = st.query(params).map_err(words)?;
        let mut out = Vec::new();
        while let Some(r) = rows.next().map_err(words)? {
            if out.len() >= MAX_ROWS {
                return Err(refuse(400, format!("That query returns over {MAX_ROWS} rows. Add a LIMIT.")));
            }
            let mut o = Map::new();
            for (i, n) in names.iter().enumerate() {
                o.insert(n.clone(), r.get_ref(i).map_or(Value::Null, cell));
            }
            out.push(Value::Object(o));
        }
        Ok(json!({ "rows": out }))
    } else {
        let changes = st.execute(params).map_err(words)?;
        Ok(json!({ "changes": changes, "lastId": c.last_insert_rowid() }))
    }
}

impl AppDb {
    pub fn new(max_bytes: u64, timeout_ms: u64) -> Self {
        Self { open: Mutex::new(HashMap::new()), max_bytes, timeout_ms }
    }

    /// Runs `q` on the app's database at `file` (made and seeded from `seed` on first use).
    pub async fn query(&self, file: PathBuf, seed: String, q: Query) -> Result<Value, Refused> {
        let max = self.max_bytes;
        let have = self.open.lock().ok().and_then(|m| m.get(&file).cloned());
        let conn = if let Some(c) = have {
            c
        } else {
            let (f, s) = (file.clone(), seed);
            let c = tokio::task::spawn_blocking(move || open_seeded(&f, &s, max)).await.map_err(|e| refuse(500, e.to_string()))??;
            let c = Arc::new(Mutex::new(c));
            if let Ok(mut m) = self.open.lock() {
                m.insert(file, c.clone());
            }
            c
        };
        let handle = conn.lock().map_err(|_| refuse(500, "The app's database is unavailable."))?.get_interrupt_handle();
        let job = tokio::task::spawn_blocking(move || {
            let c = conn.lock().map_err(|_| refuse(500, "The app's database is unavailable."))?;
            run(&c, &q, max)
        });
        let limit = Duration::from_millis(self.timeout_ms);
        let mut job = std::pin::pin!(job);
        if let Ok(r) = tokio::time::timeout(limit, &mut job).await {
            r.map_err(|e| refuse(500, e.to_string()))?
        } else {
            handle.interrupt();
            let _ = job.await;
            Err(refuse(408, timeout_words(self.timeout_ms)))
        }
    }

    /// Lets the file go (the app was removed or its data reset).
    pub fn release(&self, file: &Path) {
        if let Ok(mut m) = self.open.lock() {
            m.remove(file);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(sql: &str, params: Vec<Param>) -> Query {
        Query { sql: sql.into(), params }
    }

    #[tokio::test]
    async fn seeds_once_then_reads_and_writes() {
        let dir = std::env::temp_dir().join(format!("wisp-appdb-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("data.db");
        let _ = std::fs::remove_file(&file);
        let db = AppDb::default();
        let seed = "CREATE TABLE todos (id INTEGER PRIMARY KEY, text TEXT); INSERT INTO todos (text) VALUES ('first');".to_owned();
        let w = db
            .query(file.clone(), seed.clone(), q("INSERT INTO todos (text) VALUES (?)", vec![Param::Text("second".into())]))
            .await
            .unwrap();
        assert_eq!(w, json!({ "changes": 1, "lastId": 2 }));
        db.release(&file);
        let r = db.query(file.clone(), seed, q("SELECT text FROM todos ORDER BY id", vec![])).await.unwrap();
        assert_eq!(r, json!({ "rows": [{ "text": "first" }, { "text": "second" }] }));
        let bad = db.query(file, String::new(), q("SELECT nope FROM todos", vec![])).await.unwrap_err();
        assert_eq!(bad.0, 400);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
