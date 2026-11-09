//! opencode's own sessions (ADR-0035), as recorded on 2026-11-09 (opencode 1.x): one SQLite file,
//! `<data home>/opencode/opencode.db`, with `session` (`id`, `directory`, `title`, `time_created`,
//! `time_updated`), `message` (`id`, `session_id`, `time_created`, `data` JSON with `role` and `modelID`) and
//! `part` (`message_id`, `data` JSON with `type` and `text`). wisp opens it read-only and never writes it; the
//! reads run on the blocking pool.

use std::path::PathBuf;

use rusqlite::{Connection, OpenFlags, params};
use serde_json::Value;
use wisp_kernel::BoxFuture;
use wisp_runtime_api::harness::sessions::{HarnessSessions, OutsideSession, SessionTurn, folder_forms, safe_id};

#[derive(Debug)]
pub struct OpencodeSessions {
    pub db: PathBuf,
}

impl OpencodeSessions {
    pub fn from_env() -> Self {
        Self { db: PathBuf::from(super::data_home()).join("opencode").join("opencode.db") }
    }
}

fn open(db: &PathBuf) -> Option<Connection> {
    if !db.is_file() {
        return None;
    }
    Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX).ok()
}

/// A session's turns: a user message's text parts are its prompt, an assistant's text parts its answer.
pub fn turns(c: &Connection, id: &str) -> Vec<SessionTurn> {
    let Ok(mut st) = c.prepare("SELECT m.id, m.time_created, m.data, p.data FROM message m LEFT JOIN part p ON p.message_id = m.id WHERE m.session_id = ?1 ORDER BY m.time_created, m.id, p.time_created, p.id") else {
        return Vec::new();
    };
    let Ok(rows) = st.query_map(params![id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?, r.get::<_, Option<String>>(3)?))) else {
        return Vec::new();
    };
    let mut out: Vec<SessionTurn> = Vec::new();
    let mut last_msg = String::new();
    for (mid, at, data, part) in rows.flatten() {
        let m: Value = serde_json::from_str(&data).unwrap_or(Value::Null);
        let p: Value = part.and_then(|p| serde_json::from_str(&p).ok()).unwrap_or(Value::Null);
        let text = (p.get("type").and_then(Value::as_str) == Some("text") && p.get("synthetic") != Some(&Value::Bool(true))).then(|| p.get("text").and_then(Value::as_str).unwrap_or_default().to_owned());
        let new_msg = mid != last_msg;
        last_msg = mid;
        match m.get("role").and_then(Value::as_str) {
            Some("user") => {
                if new_msg {
                    out.push(SessionTurn { started_at: at, ended_at: at, ..SessionTurn::default() });
                }
                if let (Some(t), Some(text)) = (out.last_mut(), text) {
                    if !t.prompt.is_empty() {
                        t.prompt.push('\n');
                    }
                    t.prompt.push_str(text.trim());
                }
            }
            Some("assistant") => {
                if let Some(t) = out.last_mut() {
                    t.ended_at = at;
                    m.get("modelID").and_then(Value::as_str).unwrap_or_default().clone_into(&mut t.model);
                    if let Some(text) = text {
                        if !t.text.is_empty() {
                            t.text.push('\n');
                        }
                        t.text.push_str(&text);
                    }
                }
            }
            _ => {}
        }
    }
    out.retain(|t| !t.prompt.is_empty());
    out
}

fn session(row: (String, String, String, i64, i64), n: usize) -> OutsideSession {
    let (id, cwd, title, started_at, updated_at) = row;
    OutsideSession { harness: "opencode".into(), id, cwd, title: title.chars().take(80).collect(), started_at, updated_at, prompts: u32::try_from(n).unwrap_or(u32::MAX) }
}

type Row = (String, String, String, i64, i64);

fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Row> {
    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
}

pub fn list_in(c: &Connection, forms: &[String]) -> Vec<OutsideSession> {
    let mut out = Vec::new();
    for f in forms {
        let Ok(mut st) = c.prepare("SELECT id, directory, title, time_created, time_updated FROM session WHERE directory = ?1") else { continue };
        let rows: Vec<Row> = st.query_map(params![f], row).map(|r| r.flatten().collect()).unwrap_or_default();
        for r in rows {
            let n = turns(c, &r.0).len();
            if n > 0 {
                out.push(session(r, n));
            }
        }
    }
    out.sort_by_key(|s| std::cmp::Reverse(s.updated_at));
    out
}

pub fn read_in(c: &Connection, id: &str) -> Option<(OutsideSession, Vec<SessionTurn>)> {
    let r = c.query_row("SELECT id, directory, title, time_created, time_updated FROM session WHERE id = ?1", params![id], row).ok()?;
    let t = turns(c, id);
    Some((session(r, t.len()), t))
}

impl HarnessSessions for OpencodeSessions {
    fn harness(&self) -> &'static str {
        "opencode"
    }
    fn list(&self, cwd: &str) -> BoxFuture<'static, Vec<OutsideSession>> {
        let (db, cwd) = (self.db.clone(), cwd.to_owned());
        Box::pin(async move {
            let resolved = tokio::fs::canonicalize(&cwd).await.ok();
            let forms = folder_forms(&cwd, resolved.as_deref());
            tokio::task::spawn_blocking(move || open(&db).map(|c| list_in(&c, &forms)).unwrap_or_default()).await.unwrap_or_default()
        })
    }
    fn read(&self, id: &str) -> BoxFuture<'static, Option<(OutsideSession, Vec<SessionTurn>)>> {
        let (db, id) = (self.db.clone(), id.to_owned());
        Box::pin(async move {
            if !safe_id(&id) {
                return None;
            }
            tokio::task::spawn_blocking(move || read_in(&open(&db)?, &id)).await.ok().flatten()
        })
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    const SAMPLE: &str = include_str!("../tests/fixtures/session.sql");
    const ID: &str = "ses_e40975a50ffe4ZKyFPHyIIU1zg";

    fn db(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("wisp-opencode-{name}-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&p);
        Connection::open(&p).unwrap().execute_batch(SAMPLE).unwrap();
        p
    }

    #[tokio::test]
    async fn an_opencode_session_is_read_from_its_database() {
        let p = db("read");
        let before = std::fs::read(&p).unwrap();
        let o = OpencodeSessions { db: p.clone() };
        let (s, t) = o.read(ID).await.unwrap();
        assert_eq!((s.cwd.as_str(), s.title.as_str(), s.prompts), ("/private/tmp/wisp-samples/run", "Reply with OK", 1));
        assert_eq!((t[0].prompt.as_str(), t[0].text.as_str(), t[0].model.as_str()), ("\"Reply with OK.\"", "OK.", "beam-free"));
        assert!(t[0].ended_at >= t[0].started_at && t[0].started_at > 0);
        assert!(o.read("ses_nope").await.is_none() && o.read("../x").await.is_none());
        // read-only: a write through wisp's handle is refused, and the file is as it was
        assert!(open(&p).unwrap().execute("DELETE FROM session", []).is_err());
        assert_eq!(std::fs::read(&p).unwrap(), before);
        assert!(OpencodeSessions { db: p.with_extension("missing") }.read(ID).await.is_none());
        let _ = std::fs::remove_file(p);
    }

    #[tokio::test]
    async fn a_session_of_another_folder_isnt_listed() {
        let p = db("list");
        let o = OpencodeSessions { db: p.clone() };
        assert_eq!(o.list("/private/tmp/wisp-samples/run").await.len(), 1);
        assert_eq!(o.list("/private/tmp").await, Vec::new());
        let _ = std::fs::remove_file(p);
    }
}
