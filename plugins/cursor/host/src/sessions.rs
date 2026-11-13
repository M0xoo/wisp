//! Cursor CLI's own sessions (ADR-0035), as recorded on 2026-11-09: each is
//! `<root>/projects/<cwd without its leading />, every other non-alphanumeric as ->/agent-transcripts/<id>/<id>.jsonl`
//! (`{"role":"user"|"assistant","message":{"content":[{type:text,text}]}}` lines, no times), and its folder and
//! times are in `<root>/chats/<hash>/<id>/meta.json` (`cwd`, `createdAtMs`, `updatedAtMs`). `<root>` is `~/.cursor`.

use std::path::{Path, PathBuf};

use serde_json::Value;
use wisp_kernel::BoxFuture;
use wisp_runtime_api::harness::sessions::{HarnessSessions, OutsideSession, SessionTurn, content_text, folder_forms, safe_id, tagged};

/// The folder name Cursor keeps a project's transcripts under.
pub fn project_dir(cwd: &str) -> String {
    cwd.trim_start_matches('/').chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

/// A transcript's turns: the prompt is inside `<user_query>` (Cursor puts a `<timestamp>` line before it).
pub fn parse(text: &str) -> Vec<SessionTurn> {
    let mut turns: Vec<SessionTurn> = Vec::new();
    for v in text.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()) {
        let Some(body) = v.pointer("/message/content").and_then(content_text) else { continue };
        match v.get("role").and_then(Value::as_str) {
            Some("user") => {
                let prompt = tagged(&body, "user_query").or_else(|| (!body.starts_with('<')).then(|| body.trim().to_owned()));
                if let Some(prompt) = prompt.filter(|p| !p.is_empty()) {
                    turns.push(SessionTurn { prompt, ..SessionTurn::default() });
                }
            }
            Some("assistant") => {
                if let Some(t) = turns.last_mut() {
                    if !t.text.is_empty() {
                        t.text.push('\n');
                    }
                    t.text.push_str(&body);
                }
            }
            _ => {}
        }
    }
    turns
}

/// The session a transcript and its meta make.
pub fn session(id: &str, meta: &Value, turns: &mut [SessionTurn]) -> OutsideSession {
    let n = |k: &str| meta.get(k).and_then(Value::as_i64).unwrap_or(0);
    let (started, updated) = (n("createdAtMs"), n("updatedAtMs"));
    for t in turns.iter_mut() {
        (t.started_at, t.ended_at) = (started, updated);
    }
    OutsideSession {
        harness: "cursor".into(),
        id: id.to_owned(),
        cwd: meta.get("cwd").and_then(Value::as_str).unwrap_or_default().to_owned(),
        title: turns.first().map(|t| t.prompt.lines().next().unwrap_or_default().chars().take(80).collect()).unwrap_or_default(),
        started_at: started,
        updated_at: updated,
        prompts: u32::try_from(turns.len()).unwrap_or(u32::MAX),
    }
}

#[derive(Debug)]
pub struct CursorSessions {
    pub root: PathBuf,
}

impl CursorSessions {
    pub fn from_env() -> Self {
        Self { root: PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".cursor") }
    }
}

/// `chats/<hash>/<id>/meta.json`, from whichever hash folder holds it.
async fn meta(root: &Path, id: &str) -> Value {
    let Ok(mut rd) = tokio::fs::read_dir(root.join("chats")).await else { return Value::Null };
    while let Ok(Some(e)) = rd.next_entry().await {
        if let Ok(b) = tokio::fs::read(e.path().join(id).join("meta.json")).await {
            return serde_json::from_slice(&b).unwrap_or(Value::Null);
        }
    }
    Value::Null
}

async fn load(root: &Path, transcript: &Path, id: &str) -> Option<(OutsideSession, Vec<SessionTurn>)> {
    let text = tokio::fs::read_to_string(transcript).await.ok()?;
    let mut turns = parse(&text);
    let mut m = meta(root, id).await;
    if m.get("updatedAtMs").is_none() {
        // no meta: the transcript's own times
        let at = tokio::fs::metadata(transcript)
            .await
            .ok()
            .and_then(|md| md.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(0));
        m = serde_json::json!({ "cwd": m.get("cwd").cloned().unwrap_or_default(), "createdAtMs": at, "updatedAtMs": at });
    }
    let s = session(id, &m, &mut turns);
    Some((s, turns))
}

impl HarnessSessions for CursorSessions {
    fn harness(&self) -> &'static str {
        "cursor"
    }
    fn list(&self, cwd: &str) -> BoxFuture<'static, Vec<OutsideSession>> {
        let (root, cwd) = (self.root.clone(), cwd.to_owned());
        Box::pin(async move {
            let resolved = tokio::fs::canonicalize(&cwd).await.ok();
            let forms = folder_forms(&cwd, resolved.as_deref());
            let mut out: Vec<OutsideSession> = Vec::new();
            let mut dirs: Vec<String> = forms.iter().map(|f| project_dir(f)).collect();
            dirs.dedup();
            for d in dirs {
                let Ok(mut rd) = tokio::fs::read_dir(root.join("projects").join(d).join("agent-transcripts")).await else { continue };
                while let Ok(Some(e)) = rd.next_entry().await {
                    let id = e.file_name().to_string_lossy().into_owned();
                    if !safe_id(&id) || out.iter().any(|s| s.id == id) {
                        continue;
                    }
                    if let Some((mut s, _)) = load(&root, &e.path().join(format!("{id}.jsonl")), &id).await {
                        // the folder name is lossy: a meta naming another folder is that folder's
                        if s.cwd.is_empty() {
                            s.cwd.clone_from(&cwd);
                        }
                        if s.prompts > 0 && forms.contains(&s.cwd) {
                            out.push(s);
                        }
                    }
                }
            }
            out.sort_by_key(|s| std::cmp::Reverse(s.updated_at));
            out
        })
    }
    fn read(&self, id: &str) -> BoxFuture<'static, Option<(OutsideSession, Vec<SessionTurn>)>> {
        let (root, id) = (self.root.clone(), id.to_owned());
        Box::pin(async move {
            if !safe_id(&id) {
                return None;
            }
            let mut rd = tokio::fs::read_dir(root.join("projects")).await.ok()?;
            while let Ok(Some(e)) = rd.next_entry().await {
                let p = e.path().join("agent-transcripts").join(&id).join(format!("{id}.jsonl"));
                if tokio::fs::metadata(&p).await.is_ok() {
                    return load(&root, &p, &id).await;
                }
            }
            None
        })
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    const SAMPLE: &str = include_str!("../tests/fixtures/session.jsonl");
    const ID: &str = "30769d4a-c1a3-43f0-8697-086b894a13d2";

    fn home(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("wisp-cursor-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let t = d.join("projects/private-tmp-wisp-samples-run/agent-transcripts").join(ID);
        std::fs::create_dir_all(&t).unwrap();
        std::fs::write(t.join(format!("{ID}.jsonl")), SAMPLE).unwrap();
        let m = d.join("chats/0e836b909a1179ef1afd39eaa380b3d8").join(ID);
        std::fs::create_dir_all(&m).unwrap();
        std::fs::write(m.join("meta.json"), r#"{"schemaVersion":1,"createdAtMs":1794212660234,"hasConversation":true,"updatedAtMs":1794212665364,"cwd":"/private/tmp/wisp-samples/run"}"#).unwrap();
        d
    }

    #[tokio::test]
    async fn a_cursor_transcript_reads_as_turns() {
        let t = parse(SAMPLE);
        assert_eq!(t.len(), 1);
        assert_eq!((t[0].prompt.as_str(), t[0].text.as_str()), ("Reply with OK.", "OK."));
        let root = home("read");
        let (s, turns) = CursorSessions { root: root.clone() }.read(ID).await.unwrap();
        assert_eq!(
            (s.cwd.as_str(), s.title.as_str(), s.prompts, s.started_at, s.updated_at),
            ("/private/tmp/wisp-samples/run", "Reply with OK.", 1, 1_794_212_660_234, 1_794_212_665_364)
        );
        assert_eq!(turns[0].ended_at, 1_794_212_665_364);
        assert!(CursorSessions { root: root.clone() }.read("../x").await.is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn a_session_of_another_folder_isnt_listed() {
        let root = home("list");
        let c = CursorSessions { root: root.clone() };
        assert_eq!(c.list("/private/tmp/wisp-samples/run").await.len(), 1);
        // the same lossy folder name, another folder: its meta says so
        assert_eq!(c.list("/private/tmp/wisp/samples/run").await, Vec::new());
        assert_eq!(c.list("/elsewhere").await, Vec::new());
        assert_eq!(project_dir("/private/tmp/wisp-samples/run"), "private-tmp-wisp-samples-run");
        let _ = std::fs::remove_dir_all(root);
    }
}
