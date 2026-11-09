//! Grok CLI's own sessions (ADR-0035), as recorded on 2026-11-09: `<root>/sessions/<cwd, percent-encoded>/<id>/`
//! holds `chat_history.jsonl` (`{type: system|user|reasoning|assistant, content}` lines; only a user entry with a
//! `prompt_index` is the user's prompt, inside `<user_query>`) and `summary.json` (`info.cwd`, `created_at`,
//! `updated_at`). `<root>` is `~/.grok`.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use serde_json::Value;
use wisp_kernel::BoxFuture;
use wisp_runtime_api::harness::sessions::{HarnessSessions, OutsideSession, SessionTurn, content_text, folder_forms, iso_ms, safe_id, tagged};

/// The folder name Grok keeps a project's sessions under: the path, percent-encoded.
pub fn project_dir(cwd: &str) -> String {
    let mut out = String::new();
    for b in cwd.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(char::from(b));
        } else {
            let _ = write!(out, "%{b:02X}");
        }
    }
    out
}

/// A session's turns.
pub fn parse(text: &str) -> Vec<SessionTurn> {
    let mut turns: Vec<SessionTurn> = Vec::new();
    for v in text.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()) {
        let Some(body) = v.get("content").and_then(content_text) else { continue };
        match v.get("type").and_then(Value::as_str) {
            Some("user") if v.get("prompt_index").is_some() => {
                let prompt = tagged(&body, "user_query").unwrap_or_else(|| body.trim().to_owned());
                turns.push(SessionTurn { prompt, ..SessionTurn::default() });
            }
            Some("assistant") => {
                if let Some(t) = turns.last_mut() {
                    if !t.text.is_empty() {
                        t.text.push('\n');
                    }
                    t.text.push_str(&body);
                    v.get("model_id").and_then(Value::as_str).unwrap_or_default().clone_into(&mut t.model);
                }
            }
            _ => {}
        }
    }
    turns
}

/// The session `summary.json` and the turns make.
pub fn session(id: &str, summary: &Value, turns: &mut [SessionTurn]) -> OutsideSession {
    let at = |k: &str| iso_ms(summary.get(k).and_then(Value::as_str).unwrap_or_default());
    let (started, updated) = (at("created_at"), at("updated_at"));
    for t in turns.iter_mut() {
        (t.started_at, t.ended_at) = (started, updated);
    }
    OutsideSession {
        harness: "grok".into(),
        id: id.to_owned(),
        cwd: summary.pointer("/info/cwd").and_then(Value::as_str).unwrap_or_default().to_owned(),
        title: turns.first().map(|t| t.prompt.lines().next().unwrap_or_default().chars().take(80).collect()).unwrap_or_default(),
        started_at: started,
        updated_at: updated,
        prompts: u32::try_from(turns.len()).unwrap_or(u32::MAX),
    }
}

#[derive(Debug)]
pub struct GrokSessions {
    pub root: PathBuf,
}

impl GrokSessions {
    pub fn from_env() -> Self {
        Self { root: PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".grok") }
    }
}

async fn load(dir: &Path, id: &str) -> Option<(OutsideSession, Vec<SessionTurn>)> {
    let text = tokio::fs::read_to_string(dir.join("chat_history.jsonl")).await.ok()?;
    let summary: Value = tokio::fs::read(dir.join("summary.json")).await.ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null);
    let mut turns = parse(&text);
    let s = session(id, &summary, &mut turns);
    Some((s, turns))
}

impl HarnessSessions for GrokSessions {
    fn harness(&self) -> &'static str {
        "grok"
    }
    fn list(&self, cwd: &str) -> BoxFuture<'static, Vec<OutsideSession>> {
        let (root, cwd) = (self.root.clone(), cwd.to_owned());
        Box::pin(async move {
            let resolved = tokio::fs::canonicalize(&cwd).await.ok();
            let mut out: Vec<OutsideSession> = Vec::new();
            for form in folder_forms(&cwd, resolved.as_deref()) {
                let Ok(mut rd) = tokio::fs::read_dir(root.join("sessions").join(project_dir(&form))).await else { continue };
                while let Ok(Some(e)) = rd.next_entry().await {
                    let id = e.file_name().to_string_lossy().into_owned();
                    if !safe_id(&id) || out.iter().any(|s| s.id == id) {
                        continue;
                    }
                    if let Some((mut s, _)) = load(&e.path(), &id).await {
                        if s.cwd.is_empty() {
                            s.cwd.clone_from(&form);
                        }
                        if s.prompts > 0 {
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
            let mut rd = tokio::fs::read_dir(root.join("sessions")).await.ok()?;
            while let Ok(Some(e)) = rd.next_entry().await {
                let p = e.path().join(&id);
                if tokio::fs::metadata(p.join("chat_history.jsonl")).await.is_ok() {
                    return load(&p, &id).await;
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

    const HISTORY: &str = include_str!("../tests/fixtures/chat_history.jsonl");
    const SUMMARY: &str = include_str!("../tests/fixtures/summary.json");
    const ID: &str = "01a1bf68-b252-7d61-a4f7-6ef81ccd32f5";

    fn home(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("wisp-grok-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let s = d.join("sessions/%2Fprivate%2Ftmp%2Fwisp-samples%2Frun").join(ID);
        std::fs::create_dir_all(&s).unwrap();
        std::fs::write(s.join("chat_history.jsonl"), HISTORY).unwrap();
        std::fs::write(s.join("summary.json"), SUMMARY).unwrap();
        d
    }

    #[tokio::test]
    async fn a_grok_session_keeps_only_the_users_prompts() {
        let t = parse(HISTORY);
        assert_eq!(t.len(), 1, "{t:?}");
        assert_eq!((t[0].prompt.as_str(), t[0].text.as_str(), t[0].model.as_str()), ("Reply with OK.", "OK", "grok-4.7-build"));
        let root = home("read");
        let (s, _) = GrokSessions { root: root.clone() }.read(ID).await.unwrap();
        assert_eq!((s.cwd.as_str(), s.title.as_str(), s.prompts), ("/private/tmp/wisp-samples/run", "Reply with OK.", 1));
        assert_eq!((s.started_at, s.updated_at), (iso_ms("2026-11-09T08:24:32.103Z"), iso_ms("2026-11-09T08:24:36.531Z")));
        assert!(GrokSessions { root: root.clone() }.read("..").await.is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn a_session_of_another_folder_isnt_listed() {
        let root = home("list");
        let g = GrokSessions { root: root.clone() };
        assert_eq!(project_dir("/private/tmp/wisp-samples/run"), "%2Fprivate%2Ftmp%2Fwisp-samples%2Frun");
        assert_eq!(g.list("/private/tmp/wisp-samples/run/").await.len(), 1);
        assert_eq!(g.list("/private/tmp/wisp-samples").await, Vec::new());
        let _ = std::fs::remove_dir_all(root);
    }
}
