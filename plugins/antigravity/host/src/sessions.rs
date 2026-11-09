//! Antigravity CLI's (`agy`) own sessions (ADR-0035), as recorded on 2026-11-09: a conversation's steps are
//! `<root>/brain/<id>/.system_generated/logs/transcript.jsonl` (`{type: USER_INPUT|PLANNER_RESPONSE, source,
//! created_at, content}`; the prompt inside `<USER_REQUEST>`), and its folder is the first `file://` URI in the
//! protobuf blob of `<root>/conversations/<id>.db`'s `trajectory_metadata_blob`. `<root>` is
//! `~/.gemini/antigravity-cli`. The databases are opened read-only, on the blocking pool.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use wisp_kernel::BoxFuture;
use wisp_runtime_api::harness::sessions::{HarnessSessions, OutsideSession, SessionTurn, folder_forms, iso_ms, safe_id, tagged};

/// A conversation's turns.
pub fn parse(text: &str) -> Vec<SessionTurn> {
    let mut turns: Vec<SessionTurn> = Vec::new();
    for v in text.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()) {
        let body = v.get("content").and_then(Value::as_str).unwrap_or_default();
        let at = iso_ms(v.get("created_at").and_then(Value::as_str).unwrap_or_default());
        match (v.get("type").and_then(Value::as_str), v.get("source").and_then(Value::as_str)) {
            (Some("USER_INPUT"), Some("USER_EXPLICIT")) => {
                let prompt = tagged(body, "USER_REQUEST").unwrap_or_else(|| body.trim().to_owned());
                turns.push(SessionTurn { prompt, started_at: at, ended_at: at, ..SessionTurn::default() });
            }
            (Some("PLANNER_RESPONSE"), _) if !body.is_empty() => {
                if let Some(t) = turns.last_mut() {
                    if !t.text.is_empty() {
                        t.text.push('\n');
                    }
                    t.text.push_str(body);
                    t.ended_at = at;
                }
            }
            _ => {}
        }
    }
    turns
}

/// The first `file://` URI in a metadata blob, as a path.
pub fn folder_of(blob: &[u8]) -> Option<String> {
    let at = blob.windows(7).position(|w| w == b"file://")? + 7;
    let end = blob[at..].iter().position(|b| !b.is_ascii_graphic()).map_or(blob.len(), |n| at + n);
    let p = std::str::from_utf8(&blob[at..end]).ok()?;
    // percent-encoded bytes in the URI
    let mut out = Vec::new();
    let b = p.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if let Some(v) = (b[i] == b'%').then(|| p.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok())).flatten() {
            out.push(v);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8(out).ok().map(|s| s.trim_end_matches('/').to_owned()).filter(|s| s.starts_with('/'))
}

fn folder(root: &Path, id: &str) -> Option<String> {
    let db = root.join("conversations").join(format!("{id}.db"));
    if !db.is_file() {
        return None;
    }
    let c = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX).ok()?;
    let blob: Vec<u8> = c.query_row("SELECT data FROM trajectory_metadata_blob LIMIT 1", [], |r| r.get(0)).ok()?;
    folder_of(&blob)
}

fn load(root: &Path, id: &str, cwd: Option<String>) -> Option<(OutsideSession, Vec<SessionTurn>)> {
    let text = std::fs::read_to_string(root.join("brain").join(id).join(".system_generated/logs/transcript.jsonl")).ok()?;
    let turns = parse(&text);
    let s = OutsideSession {
        harness: "antigravity".into(),
        id: id.to_owned(),
        cwd: cwd.or_else(|| folder(root, id)).unwrap_or_default(),
        title: turns.first().map(|t| t.prompt.lines().next().unwrap_or_default().chars().take(80).collect()).unwrap_or_default(),
        started_at: turns.first().map_or(0, |t| t.started_at),
        updated_at: turns.iter().map(|t| t.ended_at).max().unwrap_or(0),
        prompts: u32::try_from(turns.len()).unwrap_or(u32::MAX),
    };
    Some((s, turns))
}

fn list_in(root: &Path, forms: &[String]) -> Vec<OutsideSession> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(root.join("conversations")) else { return out };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(id) = name.strip_suffix(".db").filter(|i| safe_id(i)) else { continue };
        let Some(cwd) = folder(root, id).filter(|c| forms.contains(c)) else { continue };
        if let Some((s, _)) = load(root, id, Some(cwd)).filter(|(s, _)| s.prompts > 0) {
            out.push(s);
        }
    }
    out.sort_by_key(|s| std::cmp::Reverse(s.updated_at));
    out
}

#[derive(Debug)]
pub struct AntigravitySessions {
    pub root: PathBuf,
}

impl AntigravitySessions {
    pub fn from_env() -> Self {
        Self { root: PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".gemini").join("antigravity-cli") }
    }
}

impl HarnessSessions for AntigravitySessions {
    fn harness(&self) -> &'static str {
        "antigravity"
    }
    fn list(&self, cwd: &str) -> BoxFuture<'static, Vec<OutsideSession>> {
        let (root, cwd) = (self.root.clone(), cwd.to_owned());
        Box::pin(async move {
            let resolved = tokio::fs::canonicalize(&cwd).await.ok();
            let forms = folder_forms(&cwd, resolved.as_deref());
            tokio::task::spawn_blocking(move || list_in(&root, &forms)).await.unwrap_or_default()
        })
    }
    fn read(&self, id: &str) -> BoxFuture<'static, Option<(OutsideSession, Vec<SessionTurn>)>> {
        let (root, id) = (self.root.clone(), id.to_owned());
        Box::pin(async move {
            if !safe_id(&id) {
                return None;
            }
            tokio::task::spawn_blocking(move || load(&root, &id, None)).await.ok().flatten()
        })
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    const TRANSCRIPT: &str = include_str!("../tests/fixtures/transcript.jsonl");
    const BLOB: &[u8] = include_bytes!("../tests/fixtures/metadata.bin");
    const ID: &str = "a1d499cc-2f77-4461-8f4d-672829429889";

    fn home(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("wisp-agy-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let logs = d.join("brain").join(ID).join(".system_generated/logs");
        std::fs::create_dir_all(&logs).unwrap();
        std::fs::write(logs.join("transcript.jsonl"), TRANSCRIPT).unwrap();
        std::fs::create_dir_all(d.join("conversations")).unwrap();
        let c = Connection::open(d.join("conversations").join(format!("{ID}.db"))).unwrap();
        c.execute_batch("CREATE TABLE `trajectory_metadata_blob` (`id` text DEFAULT \"main\",`data` blob,PRIMARY KEY (`id`));").unwrap();
        c.execute("INSERT INTO trajectory_metadata_blob (id, data) VALUES ('main', ?1)", [BLOB]).unwrap();
        d
    }

    #[tokio::test]
    async fn an_antigravity_conversation_finds_its_folder() {
        assert_eq!(folder_of(BLOB).as_deref(), Some("/tmp/wisp-samples/run"));
        assert_eq!(folder_of(b"\x0a\x1cfile:///w/my%20app/\x12"), Some("/w/my app".to_owned()));
        assert_eq!(folder_of(b"no uri"), None);
        let t = parse(TRANSCRIPT);
        assert_eq!((t.len(), t[0].prompt.as_str(), t[0].text.as_str()), (1, "Reply with OK.", "OK"));
        let root = home("read");
        let (s, _) = AntigravitySessions { root: root.clone() }.read(ID).await.unwrap();
        assert_eq!((s.cwd.as_str(), s.title.as_str(), s.prompts, s.started_at), ("/tmp/wisp-samples/run", "Reply with OK.", 1, iso_ms("2026-11-09T08:24:39Z")));
        assert!(AntigravitySessions { root: root.clone() }.read("../x").await.is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn a_session_of_another_folder_isnt_listed() {
        let root = home("list");
        let a = AntigravitySessions { root: root.clone() };
        assert_eq!(a.list("/tmp/wisp-samples/run").await.len(), 1);
        assert_eq!(a.list("/tmp/wisp-samples").await, Vec::new());
        let _ = std::fs::remove_dir_all(root);
    }
}
