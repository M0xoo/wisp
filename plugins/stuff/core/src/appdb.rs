//! An app's own SQLite database (v1 app-db.js): off unless its wisp-app.json says `"db": true` (or
//! names its seed). Its pages reach it on their own origin with `import { sql } from '/_wisp/db.js'`.
//! These are the rules a query is checked against before it runs; the host runs it.

use serde_json::Value;

/// The page side, served at `/_wisp/db.js`.
pub const DB_CLIENT: &str = "// This app's database (wisp). sql(query, ...params): rows for a read, { changes, lastId } for a write.
export async function sql(query, ...params) {
  const r = await fetch('/_wisp/db', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sql: String(query), params }) });
  const j = await r.json().catch(() => ({ error: 'HTTP ' + r.status }));
  if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
  return j.rows || j;
}
export default sql;
";

pub const BODY_LIMIT: usize = 1024 * 1024;
pub const MAX_ROWS: usize = 10_000;
pub const MAX_PARAMS: usize = 999;
/// A launched app's database, at most (the grid's published copy has its own cap).
pub const MAX_BYTES: u64 = 100 * 1024 * 1024;
pub const TIMEOUT_MS: u64 = 5000;
/// In `PRAGMA user_version` while a seed runs: a seed stopped halfway leaves a file that looks made,
/// and this says it wasn't (apps can't set it: no PRAGMA in their SQL).
pub const SEEDING: i64 = 0x7769_7370;

/// Nothing that reaches past the app's own file (ATTACH writes anywhere), loads code, or changes the
/// limits set on it. Whole words, so a string that merely says them is refused too: rare.
const DENY: &[&str] = &[
    "attach",
    "detach",
    "pragma",
    "vacuum",
    "load_extension",
    "sqlite_dbpage",
];

fn words(sql: &str) -> impl Iterator<Item = String> + '_ {
    sql.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .filter(|w| !w.is_empty())
        .map(str::to_ascii_lowercase)
}

pub fn allowed_sql(sql: &str) -> bool {
    !words(sql).any(|w| DENY.contains(&w.as_str()))
}

/// Reads give rows; writes say what changed (with RETURNING: its rows).
pub fn returns_rows(sql: &str) -> bool {
    let first = words(sql).next().unwrap_or_default();
    matches!(first.as_str(), "select" | "with" | "values") || words(sql).any(|w| w == "returning")
}

/// One bound parameter: booleans go in as 0 and 1.
#[derive(Debug, Clone, PartialEq)]
pub enum Param {
    Null,
    Int(i64),
    Real(f64),
    Text(String),
}

/// A query the app may run.
#[derive(Debug, Clone, PartialEq)]
pub struct Query {
    pub sql: String,
    pub params: Vec<Param>,
}

/// A refusal: the HTTP status and the words the page shows.
pub type Refused = (u16, String);

fn refused(status: u16, msg: &str) -> Refused {
    (status, msg.to_owned())
}

/// The request's own checks, in v1's order: POST, JSON, from the app's own origin.
pub fn check_request(
    method: &str,
    content_type: Option<&str>,
    origin: Option<&str>,
    host: Option<&str>,
) -> Result<(), Refused> {
    if method != "POST" {
        return Err(refused(405, "POST { sql, params }"));
    }
    if !content_type
        .unwrap_or_default()
        .to_ascii_lowercase()
        .starts_with("application/json")
    {
        return Err(refused(415, "Send JSON: { sql, params }."));
    }
    if let Some(o) = origin.filter(|o| !o.is_empty() && *o != "null") {
        let from = o
            .split_once("://")
            .map(|(_, rest)| rest.split('/').next().unwrap_or_default())
            .unwrap_or_default();
        if Some(from) != host || from.is_empty() {
            return Err(refused(403, "Only this app’s own pages can use its data."));
        }
    }
    Ok(())
}

/// `{ sql, params }` → a query, or why not. `seed`: the app's seed SQL, checked by the same rule.
pub fn parse_query(body: &[u8], seed: &str) -> Result<Query, Refused> {
    if body.len() > BODY_LIMIT {
        return Err(refused(413, "That query is too long (1 MB at most)."));
    }
    let v: Value = serde_json::from_slice(body).map_err(|_| refused(400, "Bad JSON."))?;
    let sql = v.get("sql").and_then(Value::as_str).unwrap_or_default();
    if sql.trim().is_empty() {
        return Err(refused(400, "No SQL."));
    }
    if !allowed_sql(sql) {
        return Err(refused(
            400,
            "Not in an app’s data: ATTACH, DETACH, PRAGMA, VACUUM and loading extensions.",
        ));
    }
    let raw = v
        .get("params")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let bad = || {
        refused(
            400,
            "params: up to 999 strings, numbers, booleans or nulls.",
        )
    };
    if raw.len() > MAX_PARAMS {
        return Err(bad());
    }
    let params = raw
        .iter()
        .map(|p| param(p).ok_or_else(bad))
        .collect::<Result<Vec<_>, _>>()?;
    if !seed.is_empty() && !allowed_sql(seed) {
        return Err(refused(
            400,
            "The app’s seed file uses ATTACH, PRAGMA or the like, which apps can’t.",
        ));
    }
    Ok(Query {
        sql: sql.to_owned(),
        params,
    })
}

fn param(v: &Value) -> Option<Param> {
    Some(match v {
        Value::Null => Param::Null,
        Value::Bool(b) => Param::Int(i64::from(*b)),
        Value::Number(n) => n
            .as_i64()
            .map_or_else(|| Param::Real(n.as_f64().unwrap_or(0.0)), Param::Int),
        Value::String(s) => Param::Text(s.clone()),
        _ => return None,
    })
}

/// SQLite's words for an error, as the page shows them.
pub fn error_words(e: &str, max_bytes: u64) -> String {
    if e.to_ascii_lowercase().contains("database or disk is full") {
        return format!(
            "This app’s data is full ({} MB at most).",
            max_bytes / 1024 / 1024
        );
    }
    match e.strip_prefix("SQLITE_") {
        Some(rest) => rest.split_once(": ").map_or(e, |(_, m)| m).to_owned(),
        None => e.to_owned(),
    }
}

/// `max_page_count` for a size cap, in 4096-byte pages (at least 16).
pub fn max_pages(max_bytes: u64) -> u64 {
    max_bytes.div_ceil(4096).max(16)
}

pub fn timeout_words(ms: u64) -> String {
    format!("That query took over {} s and was stopped.", ms / 1000)
}
