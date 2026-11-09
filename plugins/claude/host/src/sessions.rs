//! Claude Code's own sessions (ADR-0035): `<config>/projects/<folder, every non-alphanumeric as ->/<id>.jsonl`
//! (`CLAUDE_CONFIG_DIR`, else `~/.claude`). A user's prompt (a string, not a tool result, not a meta
//! line) starts a turn; the assistant's text after it is the turn's answer.

use std::path::PathBuf;

use serde_json::Value;
use wisp_kernel::BoxFuture;
use wisp_runtime_api::harness::sessions::{HarnessSessions, OutsideSession, SessionTurn, content_text, iso_ms};

pub fn store() -> PathBuf {
    std::env::var("CLAUDE_CONFIG_DIR").ok().filter(|d| !d.is_empty()).map_or_else(|| PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".claude"), PathBuf::from)
}

/// The folder name Claude Code keeps a project's sessions under.
pub fn project_dir(cwd: &str) -> String {
    cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

/// A session file read: the session and its turns.
pub fn parse(id: &str, text: &str) -> (OutsideSession, Vec<SessionTurn>) {
    let mut s = OutsideSession { harness: "claude".into(), id: id.to_owned(), ..OutsideSession::default() };
    let mut turns: Vec<SessionTurn> = Vec::new();
    for v in text.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()) {
        let at = iso_ms(v.get("timestamp").and_then(Value::as_str).unwrap_or_default());
        if s.cwd.is_empty() {
            v.get("cwd").and_then(Value::as_str).unwrap_or_default().clone_into(&mut s.cwd);
        }
        if at > 0 {
            if s.started_at == 0 {
                s.started_at = at;
            }
            s.updated_at = at;
        }
        let msg = v.get("message").cloned().unwrap_or_default();
        match v.get("type").and_then(Value::as_str) {
            Some("user") if v.get("isMeta") != Some(&Value::Bool(true)) => {
                if let Some(p) = msg.get("content").and_then(|c| c.as_str().map(str::to_owned)).filter(|p| !p.starts_with('<')) {
                    turns.push(SessionTurn { prompt: p, started_at: at, ended_at: at, ..SessionTurn::default() });
                }
            }
            Some("assistant") => {
                if let (Some(t), Some(text)) = (turns.last_mut(), msg.get("content").and_then(content_text)) {
                    if !t.text.is_empty() {
                        t.text.push('\n');
                    }
                    t.text.push_str(&text);
                    t.ended_at = at;
                    msg.get("model").and_then(Value::as_str).unwrap_or_default().clone_into(&mut t.model);
                }
            }
            _ => {}
        }
    }
    s.title = turns.first().map(|t| t.prompt.lines().next().unwrap_or_default().chars().take(80).collect()).unwrap_or_default();
    s.prompts = u32::try_from(turns.len()).unwrap_or(u32::MAX);
    (s, turns)
}

#[derive(Debug)]
pub struct ClaudeSessions;

pub use wisp_runtime_api::harness::sessions::safe_id;

/// A session's log, from whichever project folder holds it.
async fn find(id: &str) -> Option<Vec<u8>> {
    if !safe_id(id) {
        return None;
    }
    let mut rd = tokio::fs::read_dir(store().join("projects")).await.ok()?;
    while let Ok(Some(e)) = rd.next_entry().await {
        if let Ok(b) = tokio::fs::read(e.path().join(format!("{id}.jsonl"))).await {
            return Some(b);
        }
    }
    None
}

impl HarnessSessions for ClaudeSessions {
    fn harness(&self) -> &'static str {
        "claude"
    }
    fn list(&self, cwd: &str) -> BoxFuture<'static, Vec<OutsideSession>> {
        let dir = store().join("projects").join(project_dir(cwd));
        Box::pin(async move {
            let mut out = Vec::new();
            let Ok(mut rd) = tokio::fs::read_dir(&dir).await else { return out };
            while let Ok(Some(e)) = rd.next_entry().await {
                let name = e.file_name().to_string_lossy().into_owned();
                let Some(id) = name.strip_suffix(".jsonl") else { continue };
                if let Ok(text) = tokio::fs::read_to_string(e.path()).await {
                    let (s, _) = parse(id, &text);
                    if s.prompts > 0 {
                        out.push(s);
                    }
                }
            }
            out.sort_by_key(|s| std::cmp::Reverse(s.updated_at));
            out
        })
    }
    fn read(&self, id: &str) -> BoxFuture<'static, Option<(OutsideSession, Vec<SessionTurn>)>> {
        let id = id.to_owned();
        Box::pin(async move {
            let text = String::from_utf8(find(&id).await?).ok()?;
            Some(parse(&id, &text))
        })
    }
    fn raw(&self, id: &str) -> BoxFuture<'static, Option<Vec<u8>>> {
        let id = id.to_owned();
        Box::pin(async move { find(&id).await })
    }
    fn restore(&self, id: &str, cwd: &str, raw: Vec<u8>) -> BoxFuture<'static, bool> {
        let dir = store().join("projects").join(project_dir(cwd));
        let id = id.to_owned();
        Box::pin(async move {
            if !safe_id(&id) || tokio::fs::create_dir_all(&dir).await.is_err() {
                return false;
            }
            let p = dir.join(format!("{id}.jsonl"));
            // a log already here is the CLI's own (newer, or this computer's): never overwritten
            if tokio::fs::metadata(&p).await.is_ok() {
                return true;
            }
            tokio::fs::write(&p, raw).await.is_ok()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_session_file_reads_as_turns() {
        let text = [
            r#"{"type":"user","message":{"role":"user","content":"fix the add bug"},"cwd":"/w/api","sessionId":"s1","timestamp":"2026-11-08T10:00:00.000Z"}"#,
            r#"{"type":"assistant","message":{"role":"assistant","model":"claude-opus-4","content":[{"type":"tool_use","name":"Edit"}]},"timestamp":"2026-11-08T10:00:05.000Z"}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]},"timestamp":"2026-11-08T10:00:06.000Z"}"#,
            r#"{"type":"assistant","message":{"role":"assistant","model":"claude-opus-4","content":[{"type":"text","text":"Fixed: a + b."}]},"timestamp":"2026-11-08T10:00:09.000Z"}"#,
            r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"<command-name>/clear</command-name>"},"timestamp":"2026-11-08T10:01:00.000Z"}"#,
            r#"{"type":"user","message":{"role":"user","content":"now add a test"},"timestamp":"2026-11-08T10:02:00.000Z"}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Added."}]},"timestamp":"2026-11-08T10:02:30.000Z"}"#,
            "not json",
        ]
        .join("\n");
        let (s, t) = parse("s1", &text);
        assert_eq!((s.cwd.as_str(), s.title.as_str(), s.prompts), ("/w/api", "fix the add bug", 2));
        assert_eq!((t[0].text.as_str(), t[0].model.as_str()), ("Fixed: a + b.", "claude-opus-4"));
        assert_eq!(t[1].prompt, "now add a test");
        assert_eq!(project_dir("/Users/me/my.app"), "-Users-me-my-app");
        assert!(safe_id("5f1c2e1a-0000-4000-8000-00000000abcd") && !safe_id("../x") && !safe_id("a/b") && !safe_id(""));
    }
}
