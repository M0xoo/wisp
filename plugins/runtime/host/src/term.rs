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
use wisp_terminal_api::commands as term;
use wisp_terminal_api::{TermKind, TermState};

use crate::error::{Result, RuntimeError};
use crate::runtime::Runtime;

/// Told to the agent on top of its own system prompt, where the CLI takes one.
pub const TUI_NOTE: &str = "You are running inside wisp, in a terminal the user is watching: they read your replies here and answer you directly. Work as in any interactive session; answer in plain text.";
/// A take over: the run's instructions asked for a `wisp` block only wisp's page reads (v1 services/tui.js).
pub const TAKEOVER_NOTE: &str = "The user took this session over from wisp and reads your replies in a terminal now. From here on, answer them directly in plain text, with no `wisp` block, whatever earlier instructions said.";
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
    a.terminal
        || (setting
            && a.parent_id.is_none()
            && !a.hold
            && a.by.is_none()
            && a.ext.is_empty()
            && a.steps.is_empty()
            // a variant is wisp's to apply: the CLI in a terminal wouldn't run it (v1 launch.js)
            && a.subagent_model.is_none()
            && a.skills.is_none())
}

/// What opens: `(resume_id, session_id, prompt)`. The first time, a new conversation on the first prompt, named by
/// wisp where the CLI lets it; after, the same conversation resumed, on the follow-up if there is one.
pub fn plan(
    opened: bool,
    resume: Option<&str>,
    names_sessions: bool,
    first: &str,
    follow: Option<&str>,
    new_id: &dyn Fn() -> String,
) -> (Option<String>, Option<String>, Option<String>) {
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

/// The conversation a CLI kept for a terminal task that it doesn't let wisp name: the newest in its folder that
/// was still going after the terminal opened (a minute's slack for clocks), else none.
pub fn conversation_since(list: &[wisp_runtime_api::harness::sessions::OutsideSession], cwd: &str, opened_at: i64) -> Option<String> {
    let norm = |p: &str| p.trim_end_matches('/').trim_start_matches("/private").to_owned();
    list.iter()
        .filter(|s| norm(&s.cwd) == norm(cwd) && s.updated_at >= opened_at - 60_000)
        .max_by_key(|s| s.updated_at)
        .map(|s| s.id.clone())
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
        let Some(t) = term_of(&s).cloned() else { return self.take_over(&s) };
        let h = self.harness(&s.agent)?;
        let info = h.info();
        let opened = t["opened"] == true;
        let first = t["prompt"].as_str().unwrap_or_default();
        let (resume_id, session_id, prompt) = plan(opened, s.resume_id.as_deref(), info.session_ids, first, follow, &uuid);
        let trusted = s.ext.get("wisp.worktrees").and_then(|w| w.get("cwd")).is_some();
        let o = ResumeOptions {
            resume_id: resume_id.clone(),
            model: s.model.clone(),
            effort: s.effort.clone(),
            cwd: s.cwd.clone(),
            trusted,
            prompt: None,
            session_id: session_id.clone(),
            mode: Some(s.mode),
            system_prompt: Some(TUI_NOTE.into()),
            dirs: s.dirs.clone(),
        };
        let probe = h.resume_command(&o).ok_or_else(|| RuntimeError::Invalid(format!("{} can't run in a terminal", s.agent)))?;
        let cmd =
            if probe.types_prompt { probe } else { h.resume_command(&ResumeOptions { prompt: prompt.clone(), ..o }).unwrap_or(probe) };
        let typed = if cmd.types_prompt { prompt } else { None };
        if let Some(sid) = session_id {
            s.resume_id = Some(sid);
        }
        if let Some(own) = s.ext.get_mut("wisp.runtime").and_then(Value::as_object_mut) {
            // when it opened: a CLI that names no conversation by wisp's id is found by it when it ends
            let at = if opened { t["openedAt"].as_i64().unwrap_or(0) } else { self.now() };
            own.insert("terminal".into(), json!({ "prompt": first, "opened": true, "live": true, "openedAt": at }));
        }
        s.updated_at = self.now();
        self.persist(&mut s, Vec::new()).await?;
        Ok(Opened { argv: cmd.argv, cwd: s.cwd.clone(), typed })
    }

    /// Take over (v1 proxy.js, *Open in <harness>*, T): a task wisp ran, its conversation resumed in the harness's
    /// own CLI in a terminal in wisp, told to answer in plain text from here on. A task that never kept one has none.
    fn take_over(&self, s: &Session) -> Result<Opened> {
        let resume = s
            .resume_id
            .clone()
            .filter(|r| !r.is_empty())
            .ok_or_else(|| RuntimeError::Conflict(format!("{} has no conversation to take over yet", s.title)))?;
        let h = self.harness(&s.agent)?;
        let trusted = s.ext.get("wisp.worktrees").and_then(|w| w.get("cwd")).is_some();
        let o = ResumeOptions {
            resume_id: Some(resume),
            model: s.model.clone(),
            effort: s.effort.clone(),
            cwd: s.cwd.clone(),
            trusted,
            prompt: None,
            session_id: None,
            mode: Some(s.mode),
            system_prompt: Some(TAKEOVER_NOTE.into()),
            dirs: s.dirs.clone(),
        };
        let cmd = h.resume_command(&o).ok_or_else(|| RuntimeError::Invalid(format!("{} can't be taken over in a terminal", s.agent)))?;
        // a task with no folder of its own (a crew job's answer): its CLI resumes from your home folder
        let cwd = if s.cwd.is_empty() { std::env::var("HOME").unwrap_or_else(|_| "/".into()) } else { s.cwd.clone() };
        Ok(Opened { argv: cmd.argv, cwd, typed: None })
    }

    /// Copy resume command (v1 More): `cd <its folder> && <the harness's resume argv>`, quoted for a POSIX shell. The
    /// same conversation Take over opens, without the note that tells the CLI it's inside wisp.
    pub async fn resume_line(&self, id: &str) -> Result<String> {
        let s = self.repo.session(id).await?;
        let resume = s
            .resume_id
            .clone()
            .filter(|r| !r.is_empty())
            .ok_or_else(|| RuntimeError::Conflict(format!("{} has no conversation to resume yet", s.title)))?;
        let h = self.harness(&s.agent)?;
        let trusted = s.ext.get("wisp.worktrees").and_then(|w| w.get("cwd")).is_some();
        let o = ResumeOptions {
            resume_id: Some(resume),
            model: s.model.clone(),
            effort: s.effort.clone(),
            cwd: s.cwd.clone(),
            trusted,
            prompt: None,
            session_id: None,
            mode: Some(s.mode),
            system_prompt: None,
            dirs: s.dirs.clone(),
        };
        let cmd = h.resume_command(&o).ok_or_else(|| RuntimeError::Invalid(format!("{} can't resume in a terminal", s.agent)))?;
        let line = cmd.argv.iter().map(|a| sh_quote(a)).collect::<Vec<_>>().join(" ");
        Ok(if s.cwd.is_empty() { line } else { format!("cd {} && {line}", sh_quote(&s.cwd)) })
    }

    /// The terminal ended: the turns the CLI kept come back as the task's, and it's for review.
    /// `found`: the conversation the CLI kept, found by its folder and time (one that names none by wisp's id).
    pub async fn terminal_ended(
        self: &Arc<Self>,
        id: &str,
        found: Option<String>,
        read: Option<wisp_runtime_api::spec::AdoptArgs>,
    ) -> Result<()> {
        let mut s = self.repo.session(id).await?;
        if term_of(&s).is_none() {
            return Ok(());
        }
        if s.resume_id.is_none()
            && let Some(f) = found
        {
            s.resume_id = Some(f);
            self.persist(&mut s, Vec::new()).await?;
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
pub async fn open(
    ctx: &wisp_kernel::Ctx,
    call: &wisp_kernel::Call,
    rt: &Arc<Runtime>,
    id: &str,
    follow: Option<&str>,
    size: (Option<f64>, Option<f64>),
) -> KResult<Value> {
    let o = rt.terminal_argv(id, follow).await.map_err(WireError::from)?;
    let tui = rt.repo.session(id).await.is_ok_and(|s| term_of(&s).is_some());
    let (cols, rows) = match size {
        (Some(c), Some(r)) => (Some(c), Some(r)),
        _ => (None, None),
    };
    let args = term::OpenArgs { kind: TermKind::Takeover, id: id.to_owned(), argv: o.argv, cwd: o.cwd, cols, rows, tui };
    let out = ctx.run::<term::Open>(call, args).await?;
    if let Some(text) = o.typed {
        let (ctx2, call2, id) = (ctx.clone(), call.clone(), id.to_owned());
        let fut: BoxFuture<'static, ()> = Box::pin(async move {
            tokio::time::sleep(std::time::Duration::from_millis(SETTLE_MS)).await;
            if let Err(err) = ctx2.run::<term::Input>(&call2, typed(&id, &text)).await {
                tracing::warn!(error = %err.message, task = id, "runtime: the prompt typed into its terminal");
            }
        });
        ctx.spawn(fut);
    }
    serde_json::to_value(out).map_err(|e| WireError::invalid(format!("terminal.open: {e}")))
}

/// `text` pasted into task `id`'s take over terminal.
fn typed(id: &str, text: &str) -> term::InputArgs {
    term::InputArgs { kind: TermKind::Takeover, id: id.to_owned(), data: Some(pasted(text)), ..term::InputArgs::default() }
}

/// A follow-up on a terminal task: typed into its terminal while it runs, else it opens again on it.
pub async fn follow_up(
    ctx: &wisp_kernel::Ctx,
    call: &wisp_kernel::Call,
    rt: &Arc<Runtime>,
    id: &str,
    text: &str,
) -> KResult<c::FollowedUp> {
    let live = match ctx.run::<term::Get>(call, term::KindId { kind: TermKind::Takeover, id: id.to_owned() }).await {
        Ok(t) => t.is_some_and(|t| !matches!(t.state, TermState::Ended | TermState::Failed)),
        Err(err) => {
            tracing::warn!(error = %err.message, task = id, "runtime: terminal.get (it opens again)");
            false
        }
    };
    if live {
        ctx.run::<term::Input>(call, typed(id, text)).await?;
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
    fn fields(
        &self,
        session: &Session,
        _last: Option<&wisp_runtime_api::model::Turn>,
        out: &mut std::collections::BTreeMap<String, Value>,
    ) {
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
            if e.kind != wisp_terminal_api::TermKind::Takeover
                || !matches!(e.state, wisp_terminal_api::TermState::Ended | wisp_terminal_api::TermState::Failed)
            {
                return;
            }
            let Ok(rt) = crate::plugin::rt(&slot) else { return };
            let Ok(sess) = rt.repo.session(&e.id).await else { return };
            if term_of(&sess).is_none() {
                return;
            }
            let (mut read, mut found) = (None, None);
            let opened_at = term_of(&sess).and_then(|t| t["openedAt"].as_i64()).unwrap_or(0);
            for h in ctx.contributions(&wisp_runtime_api::harness::sessions::SESSIONS).into_iter().filter(|h| h.harness() == sess.agent) {
                // a CLI that names no conversation by wisp's id (Codex, opencode, Cursor, …): the one it kept here since
                let id = match sess.resume_id.clone() {
                    Some(r) => Some(r),
                    None => conversation_since(&h.list(&sess.cwd).await, &sess.cwd, opened_at),
                };
                let Some(id) = id else { continue };
                if let Some((outside, turns)) = h.read(&id).await {
                    read = Some(crate::specs::adopted(&outside, &turns));
                }
                found = Some(id);
                break;
            }
            let _ = rt.terminal_ended(&e.id, found, read).await;
        }
    });
}

/// One word for a POSIX shell: as it is when it's plain, else in single quotes.
pub(crate) fn sh_quote(w: &str) -> String {
    if !w.is_empty() && w.chars().all(|c| c.is_ascii_alphanumeric() || "_./:=@%+,-".contains(c)) {
        return w.to_owned();
    }
    format!("'{}'", w.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {

    #[test]
    fn a_resume_line_quotes_only_what_a_shell_would_split() {
        assert_eq!(super::sh_quote("claude"), "claude");
        assert_eq!(super::sh_quote("--resume"), "--resume");
        assert_eq!(super::sh_quote("/Users/me/my app"), "'/Users/me/my app'");
        assert_eq!(super::sh_quote("it's"), "'it'\\''s'");
        assert_eq!(super::sh_quote(""), "''");
        assert_eq!(super::sh_quote("model_reasoning_effort=\"high\""), "'model_reasoning_effort=\"high\"'");
    }
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
    fn a_cli_that_names_no_conversation_is_found_by_its_folder_and_time() {
        use wisp_runtime_api::harness::sessions::OutsideSession;
        let s = |id: &str, cwd: &str, at: i64| OutsideSession {
            harness: "codex".into(),
            id: id.into(),
            cwd: cwd.into(),
            updated_at: at,
            ..OutsideSession::default()
        };
        let list = [s("old", "/w", 1_000), s("other", "/x", 900_000), s("mine", "/private/w/", 800_000), s("earlier", "/w", 500_000)];
        assert_eq!(conversation_since(&list, "/w", 700_000).as_deref(), Some("mine"));
        assert_eq!(conversation_since(&list, "/w", 2_000_000), None, "nothing since it opened");
        assert_eq!(conversation_since(&[], "/w", 0), None);
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
