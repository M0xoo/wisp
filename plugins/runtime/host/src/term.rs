//! Terminal tasks (v1 services/tui.js, Settings → General → Terminal sessions, or a prompt that starts with
//! `/terminal`): the task is the harness's own CLI in a terminal in wisp, started on the prompt, instead of wisp's
//! headless run and its cards. wisp keeps the task (folder, worktree, title); the CLI is told it's in wisp and
//! names its conversation by wisp's id where it can (`--session-id`), so a follow-up is typed into the terminal
//! while it runs, opens it again resumed once it ended, and when it ends its turns are read back from the CLI's own
//! session file (the same reader `wisp adopt` uses). Only a task you start by hand on a harness that can be resumed:
//! crew jobs, schedules, goals, teams and held tasks stay wisp's runs.

use std::sync::Arc;

use serde_json::{Value, json};
use wisp_kernel::{BoxFuture, Result as KResult, Setup, WireError};
use wisp_runtime_api::commands as c;
use wisp_runtime_api::harness::ResumeOptions;
use wisp_runtime_api::model::Session;

use crate::error::{Result, RuntimeError};
use crate::runtime::Runtime;

/// Told to the agent on top of its own system prompt, where the CLI takes one.
pub const TUI_NOTE: &str = "You are running inside wisp, in a terminal the user is watching: they read your replies here and answer you directly. Work as in any interactive session; answer in plain text.";
/// `/terminal <prompt>`: that one task starts in its terminal.
pub const SLASH: &str = "/terminal";
/// A CLI that takes no first prompt has it pasted once its screen settles.
const SETTLE_MS: u64 = 1_500;

/// The task's terminal record: `{prompt, opened}`.
pub fn term_of(s: &Session) -> Option<&Value> {
    s.ext.get("wisp.runtime").and_then(|v| v.get("terminal"))
}

/// `/terminal …` → the prompt without it.
pub fn slash(prompt: &str) -> Option<String> {
    let rest = prompt.trim_start().strip_prefix(SLASH)?;
    (rest.is_empty() || rest.starts_with(char::is_whitespace)).then(|| rest.trim().to_owned())
}

/// Whether a create starts as a terminal task: asked for (the flag, or `/terminal`), or the setting, for one you
/// start by hand (no parent, not held, nothing on behalf of another plugin, no steps).
pub fn starts_in_terminal(a: &c::StartArgs, setting: bool) -> bool {
    a.terminal || (setting && a.parent_id.is_none() && !a.hold && a.by.is_none() && a.ext.is_empty() && a.steps.is_empty())
}

/// What opens: `(resume_id, session_id, prompt)`. The first time, a new conversation on the first prompt, named by
/// wisp where the CLI lets it; after, the same conversation resumed, on the follow-up if there is one.
pub fn plan(opened: bool, resume: Option<&str>, names_sessions: bool, first: &str, follow: Option<&str>, new_id: &dyn Fn() -> String) -> (Option<String>, Option<String>, Option<String>) {
    let follow = follow.map(str::trim).filter(|f| !f.is_empty()).map(str::to_owned);
    if let Some(r) = resume.filter(|_| opened) {
        return (Some(r.to_owned()), None, follow);
    }
    let prompt = [Some(first.to_owned()).filter(|f| !f.trim().is_empty()), follow].into_iter().flatten().collect::<Vec<_>>().join("\n\n");
    (None, names_sessions.then(new_id), Some(prompt).filter(|p| !p.is_empty()))
}

/// A new conversation's id, as a CLI takes it (`8-4-4-4-12`).
fn uuid() -> String {
    let h = wisp_kernel::ids::uuid7();
    if h.len() != 32 {
        return h;
    }
    format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..])
}

/// Typed into a CLI: bracketed, so a newline in it doesn't send it early.
pub fn pasted(text: &str) -> String {
    format!("\x1b[200~{text}\x1b[201~\r")
}

#[derive(Debug)]
pub struct Opened {
    pub argv: Vec<String>,
    pub cwd: String,
    /// what's typed in once it settles (a CLI that takes no first prompt)
    pub typed: Option<String>,
}

impl Runtime {
    /// The CLI's argv for terminal task `id`, opened on its prompt (or `follow`), and the task marked opened with
    /// the conversation it names.
    pub async fn terminal_argv(self: &Arc<Self>, id: &str, follow: Option<&str>) -> Result<Opened> {
        let _guard = self.task_lock(id).await;
        let mut s = self.repo.session(id).await?;
        let t = term_of(&s).cloned().ok_or_else(|| RuntimeError::Invalid(format!("{id} isn't a terminal task")))?;
        let h = self.harness(&s.agent)?;
        let info = h.info();
        let opened = t["opened"] == true;
        let first = t["prompt"].as_str().unwrap_or_default();
        let (resume_id, session_id, prompt) = plan(opened, s.resume_id.as_deref(), info.session_ids, first, follow, &uuid);
        let trusted = s.ext.get("wisp.worktrees").and_then(|w| w.get("cwd")).is_some();
        let o = ResumeOptions { resume_id: resume_id.clone(), model: s.model.clone(), effort: s.effort.clone(), cwd: s.cwd.clone(), trusted, prompt: None, session_id: session_id.clone(), mode: Some(s.mode), system_prompt: Some(TUI_NOTE.into()), dirs: s.dirs.clone() };
        let probe = h.resume_command(&o).ok_or_else(|| RuntimeError::Invalid(format!("{} can't run in a terminal", s.agent)))?;
        let cmd = if probe.types_prompt { probe } else { h.resume_command(&ResumeOptions { prompt: prompt.clone(), ..o }).unwrap_or(probe) };
        let typed = if cmd.types_prompt { prompt } else { None };
        if let Some(sid) = session_id {
            s.resume_id = Some(sid);
        }
        if let Some(own) = s.ext.get_mut("wisp.runtime").and_then(Value::as_object_mut) {
            own.insert("terminal".into(), json!({ "prompt": first, "opened": true, "live": true }));
        }
        s.updated_at = self.now();
        self.persist(&mut s, Vec::new()).await?;
        Ok(Opened { argv: cmd.argv, cwd: s.cwd.clone(), typed })
    }

    /// The terminal ended: the turns the CLI kept come back as the task's, and it's for review.
    pub async fn terminal_ended(self: &Arc<Self>, id: &str, read: Option<wisp_runtime_api::spec::AdoptArgs>) -> Result<()> {
        let mut s = self.repo.session(id).await?;
        if term_of(&s).is_none() {
            return Ok(());
        }
        if let (Some(a), Some(r)) = (read, s.resume_id.clone()) {
            self.readopt(&r, &a).await?;
            s = self.repo.session(id).await?;
        }
        s.state = wisp_runtime_api::model::SessionState::Review;
        if let Some(t) = s.ext.get_mut("wisp.runtime").and_then(|v| v.get_mut("terminal")).and_then(Value::as_object_mut) {
            t.insert("live".into(), json!(false));
        }
        s.updated_at = self.now();
        self.persist(&mut s, Vec::new()).await?;
        Ok(())
    }
}

type Slot = crate::plugin::Slot;

/// Opens task `id`'s terminal (and pastes its prompt once it settles, for a CLI that takes none).
pub async fn open(ctx: &wisp_kernel::Ctx, call: &wisp_kernel::Call, rt: &Arc<Runtime>, id: &str, follow: Option<&str>, size: (Option<f64>, Option<f64>)) -> KResult<Value> {
    let o = rt.terminal_argv(id, follow).await.map_err(WireError::from)?;
    let mut args = json!({ "kind": "takeover", "id": id, "argv": o.argv, "cwd": o.cwd, "tui": true });
    if let (Some(c), Some(r)) = size {
        args["cols"] = json!(c);
        args["rows"] = json!(r);
    }
    let out = ctx.run_json(call, "terminal.open", args).await?;
    if let Some(text) = o.typed {
        let (ctx2, call2, id) = (ctx.clone(), call.clone(), id.to_owned());
        let fut: BoxFuture<'static, ()> = Box::pin(async move {
            tokio::time::sleep(std::time::Duration::from_millis(SETTLE_MS)).await;
            let _ = ctx2.run_json(&call2, "terminal.input", json!({ "kind": "takeover", "id": id, "data": pasted(&text) })).await;
        });
        ctx.spawn(fut);
    }
    Ok(out)
}

/// A follow-up on a terminal task: typed into its terminal while it runs, else it opens again on it.
pub async fn follow_up(ctx: &wisp_kernel::Ctx, call: &wisp_kernel::Call, rt: &Arc<Runtime>, id: &str, text: &str) -> KResult<c::FollowedUp> {
    let live = ctx.run_json(call, "terminal.get", json!({ "kind": "takeover", "id": id })).await.ok().filter(|t| t.is_object() && !matches!(t["state"].as_str(), Some("ended" | "failed")));
    if live.is_some() {
        ctx.run_json(call, "terminal.input", json!({ "kind": "takeover", "id": id, "data": pasted(text) })).await?;
    } else {
        open(ctx, call, rt, id, Some(text), (None, None)).await?;
    }
    Ok(c::FollowedUp { turn_id: None, queued: None })
}

/// The list row's `tui` (a terminal task) and `term` (its terminal is open): "In terminal".
struct Row;

impl wisp_runtime_api::points::SummaryField for Row {
    #[allow(clippy::unnecessary_literal_bound)] // the trait's signature
    fn plugin(&self) -> &str {
        "wisp.runtime"
    }
    fn fields(&self, session: &Session, _last: Option<&wisp_runtime_api::model::Turn>, out: &mut std::collections::BTreeMap<String, Value>) {
        if let Some(t) = term_of(session) {
            out.insert("tui".into(), json!(true));
            out.insert("term".into(), json!(t["live"] == true));
        }
    }
}

/// `runtime.terminal`, and a take over's end read back.
pub fn setup(s: &mut Setup, slot: &Slot) {
    let row: Arc<dyn wisp_runtime_api::points::SummaryField> = Arc::new(Row);
    s.contribute(&wisp_runtime_api::points::SUMMARY, row);
    let opening = slot.clone();
    s.command::<c::Terminal, _, _>(move |ctx, call, a| {
        let slot = opening.clone();
        async move {
            let rt = crate::plugin::rt(&slot)?;
            open(&ctx, &call, &rt, a.id.as_str(), a.prompt.as_deref(), (a.cols, a.rows)).await
        }
    });
    let ending = slot.clone();
    s.on::<wisp_terminal_api::Changed, _, _>(move |ctx, e| {
        let slot = ending.clone();
        async move {
            if e.kind != wisp_terminal_api::TermKind::Takeover || !matches!(e.state, wisp_terminal_api::TermState::Ended | wisp_terminal_api::TermState::Failed) {
                return;
            }
            let Ok(rt) = crate::plugin::rt(&slot) else { return };
            let Ok(sess) = rt.repo.session(&e.id).await else { return };
            if term_of(&sess).is_none() {
                return;
            }
            let mut read = None;
            if let Some(r) = sess.resume_id.as_deref() {
                for h in ctx.contributions(&wisp_runtime_api::harness::sessions::SESSIONS).into_iter().filter(|h| h.harness() == sess.agent) {
                    if let Some((outside, turns)) = h.read(r).await {
                        read = Some(crate::specs::adopted(&outside, &turns));
                        break;
                    }
                }
            }
            let _ = rt.terminal_ended(&e.id, read).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_terminal_task_opens_on_its_prompt_named_by_wisp_then_resumes_on_a_follow_up() {
        let id = || "u-1".to_owned();
        assert_eq!(plan(false, None, true, "fix it", None, &id), (None, Some("u-1".into()), Some("fix it".into())));
        assert_eq!(plan(false, None, false, "fix it", None, &id), (None, None, Some("fix it".into())), "a CLI that names none");
        assert_eq!(plan(true, Some("u-1"), true, "fix it", Some(" and test "), &id), (Some("u-1".into()), None, Some("and test".into())));
        assert_eq!(plan(true, Some("u-1"), true, "fix it", None, &id), (Some("u-1".into()), None, None), "opened again: resumed as it was");
        // it never kept a conversation (it ended at a question at start-up): a new one, on both prompts
        assert_eq!(plan(true, None, true, "fix it", Some("go"), &id).2.as_deref(), Some("fix it\n\ngo"));
        assert_eq!(pasted("a\nb"), "\x1b[200~a\nb\x1b[201~\r");
    }

    #[test]
    fn only_a_task_started_by_hand_starts_in_a_terminal_by_the_setting() {
        let by_hand = c::StartArgs { prompt: "x".into(), ..c::StartArgs::default() };
        assert!(starts_in_terminal(&by_hand, true) && !starts_in_terminal(&by_hand, false));
        let job = c::StartArgs { by: Some("crew".into()), ..by_hand.clone() };
        let held = c::StartArgs { hold: true, ..by_hand.clone() };
        let child = c::StartArgs { parent_id: Some(wisp_runtime_api::SessionId::from("p")), ..by_hand.clone() };
        assert!(!starts_in_terminal(&job, true) && !starts_in_terminal(&held, true) && !starts_in_terminal(&child, true));
        assert!(starts_in_terminal(&c::StartArgs { terminal: true, ..job }, false), "asked for, it does");
        assert_eq!(slash("/terminal fix the build").as_deref(), Some("fix the build"));
        assert_eq!(slash("/terminals x"), None);
    }
}
