//! Codex's own sessions (ADR-0035): `<CODEX_HOME or ~/.codex>/sessions/YYYY/MM/DD/rollout-*.jsonl`, whose
//! first line (`session_meta`) has the id and the folder. A user message that isn't Codex's own context
//! (`<environment_context>`, `<user_instructions>`) starts a turn; the assistant's messages are its answer.

use std::path::PathBuf;

use serde_json::Value;
use wisp_kernel::BoxFuture;
use wisp_runtime_api::harness::sessions::{HarnessSessions, OutsideSession, SessionTurn, content_text, iso_ms};

pub fn store() -> PathBuf {
    std::env::var("CODEX_HOME").ok().filter(|d| !d.is_empty()).map_or_else(|| PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".codex"), PathBuf::from).join("sessions")
}

/// A rollout file read: the session and its turns.
pub fn parse(text: &str) -> (OutsideSession, Vec<SessionTurn>) {
    let mut s = OutsideSession { harness: "codex".into(), ..OutsideSession::default() };
    let mut turns: Vec<SessionTurn> = Vec::new();
    for v in text.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()) {
        let at = iso_ms(v.get("timestamp").and_then(Value::as_str).unwrap_or_default());
        if at > 0 {
            if s.started_at == 0 {
                s.started_at = at;
            }
            s.updated_at = at;
        }
        let p = v.get("payload").cloned().unwrap_or_default();
        match (v.get("type").and_then(Value::as_str), p.get("type").and_then(Value::as_str), p.get("role").and_then(Value::as_str)) {
            (Some("session_meta"), ..) => {
                p.get("id").and_then(Value::as_str).unwrap_or_default().clone_into(&mut s.id);
                p.get("cwd").and_then(Value::as_str).unwrap_or_default().clone_into(&mut s.cwd);
            }
            (Some("response_item"), Some("message"), Some("user")) => {
                if let Some(text) = p.get("content").and_then(content_text).filter(|t| !t.trim_start().starts_with('<')) {
                    turns.push(SessionTurn { prompt: text, started_at: at, ended_at: at, ..SessionTurn::default() });
                }
            }
            (Some("response_item"), Some("message"), Some("assistant")) => {
                if let (Some(t), Some(text)) = (turns.last_mut(), p.get("content").and_then(content_text)) {
                    if !t.text.is_empty() {
                        t.text.push('\n');
                    }
                    t.text.push_str(&text);
                    t.ended_at = at;
                }
            }
            _ => {}
        }
    }
    s.title = turns.first().map(|t| t.prompt.lines().next().unwrap_or_default().chars().take(80).collect()).unwrap_or_default();
    s.prompts = u32::try_from(turns.len()).unwrap_or(u32::MAX);
    (s, turns)
}

/// Every rollout file, newest first (at most `cap`).
async fn rollouts(cap: usize) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![store()];
    while let Some(d) = stack.pop() {
        let Ok(mut rd) = tokio::fs::read_dir(&d).await else { continue };
        while let Ok(Some(e)) = rd.next_entry().await {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.extension().is_some_and(|x| x == "jsonl") {
                out.push(p);
            }
        }
    }
    out.sort();
    out.reverse();
    out.truncate(cap);
    out
}

#[derive(Debug)]
pub struct CodexSessions;

impl HarnessSessions for CodexSessions {
    fn harness(&self) -> &'static str {
        "codex"
    }
    fn list(&self, cwd: &str) -> BoxFuture<'static, Vec<OutsideSession>> {
        let cwd = cwd.trim_end_matches('/').to_owned();
        Box::pin(async move {
            let mut out = Vec::new();
            for p in rollouts(500).await {
                if let Ok(text) = tokio::fs::read_to_string(&p).await {
                    let (s, _) = parse(&text);
                    if s.cwd.trim_end_matches('/') == cwd && s.prompts > 0 {
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
            for p in rollouts(5000).await.into_iter().filter(|p| p.to_string_lossy().contains(&id)) {
                if let Ok(text) = tokio::fs::read_to_string(&p).await {
                    let r = parse(&text);
                    if r.0.id == id {
                        return Some(r);
                    }
                }
            }
            None
        })
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_rollout_reads_as_turns() {
        let text = [
            r#"{"timestamp":"2026-11-08T10:00:00.000Z","type":"session_meta","payload":{"id":"0199-abc","cwd":"/w/api"}}"#,
            r#"{"timestamp":"2026-11-08T10:00:00.100Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>cwd</environment_context>"}]}}"#,
            r#"{"timestamp":"2026-11-08T10:00:01.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"fix the add bug"}]}}"#,
            r#"{"timestamp":"2026-11-08T10:00:09.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Fixed."}]}}"#,
        ]
        .join("\n");
        let (s, t) = super::parse(&text);
        assert_eq!((s.id.as_str(), s.cwd.as_str(), s.prompts), ("0199-abc", "/w/api", 1));
        assert_eq!((t[0].prompt.as_str(), t[0].text.as_str()), ("fix the add bug", "Fixed."));
    }
}
