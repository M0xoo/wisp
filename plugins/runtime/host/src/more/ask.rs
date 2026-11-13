//! An agent's questions and live approvals (v1 runner.js `ask`, `requestApproval`, `answer`, `pollAnswer`).

use std::sync::Arc;

use serde_json::{Value, json};
use wisp_runtime_api::SessionId;
use wisp_runtime_api::commands::{AskArgs, PollAnswer};
use wisp_runtime_api::harness::PermissionAsk;
use wisp_runtime_api::model::{Session, SessionState, ToolKind};

use super::{POLL_MS, push, slot, str_at, tool_row, with_slot};
use crate::error::{Result, RuntimeError};
use crate::runtime::Runtime;

/// What v1 gave a question before it gave up waiting (adapters/common.js `ASK_TIMEOUT_MS`).
pub(crate) const ASK_TIMEOUT_MS: i64 = 30 * 60_000;
/// The answers a live approval offers (v1 `APPROVAL`). Typed text instead is a "no, do this instead".
pub(crate) const APPROVAL_ALLOW: &str = "Allow";
pub(crate) const APPROVAL_ALWAYS: &str = "Always allow in this task";
pub(crate) const APPROVAL_DENY: &str = "Deny";
const SIDE_DENIED: &str = "Refused: a side discussion only reads. Ask the main task to do it.";

/// The open question's id, from the task itself (the truth across a restart).
pub(crate) fn ask_id(s: &Session) -> Option<String> {
    slot(s)?.get("ask")?.get("id")?.as_str().map(str::to_owned)
}

/// A live approval's answer (v1 `approvalDecision`): a button, a yes/no typed out, or anything
/// else, which denies the call and hands the agent the user's words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Decision {
    pub allow: bool,
    pub always: bool,
    pub message: Option<String>,
}

pub(crate) fn approval_decision(text: &str) -> Decision {
    let t = text.trim();
    let l = t.to_lowercase();
    let yes = |allow, always| Decision { allow, always, message: None };
    if t == APPROVAL_ALWAYS || l.starts_with("always") || l == "2" {
        return yes(true, true);
    }
    if t == APPROVAL_ALLOW || matches!(l.as_str(), "y" | "yes" | "ok" | "allow" | "approve" | "go ahead" | "1") {
        return yes(true, false);
    }
    if t == APPROVAL_DENY || matches!(l.as_str(), "n" | "no" | "deny" | "reject" | "3") {
        return yes(false, false);
    }
    Decision { allow: false, always: false, message: Some(t.to_owned()) }
}

impl Runtime {
    /// `runtime.ask`: the agent's question goes on its task, which waits on the user (v1 `ask`).
    pub async fn ask(self: &Arc<Self>, a: AskArgs) -> Result<String> {
        let context = a.details.as_ref().and_then(|d| d.get("context")).and_then(Value::as_str).unwrap_or_default().to_owned();
        self.ask_in(&a.id, &a.question, &context, &a.options, None).await
    }

    /// Puts a question on task `id`: `state: waiting`, unread, back from the archive, and an
    /// "Asked you: …" (or "Needs your OK to …") row on its turn. A question already open is replaced.
    async fn ask_in(self: &Arc<Self>, id: &SessionId, question: &str, context: &str, options: &[String], permission: Option<Value>) -> Result<String> {
        let (tid, label, ask_id) = {
            let _g = self.task_lock(id.as_str()).await;
            let mut s = self.repo.session(id.as_str()).await?;
            if let Some(old) = ask_id(&s) {
                self.asks().remove(&old);
            }
            let ask_id = wisp_kernel::ids::uuid7();
            let question = if question.trim().is_empty() { "The agent has a question.".to_owned() } else { question.trim().to_owned() };
            let options: Vec<String> = options.iter().take(6).cloned().collect();
            let label = match permission.as_ref().and_then(|p| p.get("action")).and_then(Value::as_str) {
                Some(action) => format!("Needs your OK to {action}"),
                None => format!("Asked you: {question}"),
            };
            let mut ask = json!({ "id": ask_id, "question": question, "context": context, "options": options, "askedAt": self.now() });
            if let (Some(p), Some(o)) = (permission, ask.as_object_mut()) {
                o.insert("permission".into(), p);
            }
            with_slot(&mut s.ext, |m| m.insert("ask".into(), ask));
            s.state = SessionState::Waiting;
            s.unread = true;
            s.archived = false; // a question needs the user: it comes back to the feed
            self.asks().insert(ask_id.clone(), s.id.0.clone());
            self.persist(&mut s, Vec::new()).await?;
            self.host.emit(crate::host::Emitted::Task("task.asked", crate::host::fact(&s, None, "asked", &question, None)));
            (self.last_turn(id.as_str()).await?.map(|t| t.id), label, ask_id)
        };
        if let Some(t) = tid {
            self.add_row(id.as_str(), t.as_str(), tool_row(ToolKind::Ask, label)).await?;
        }
        Ok(ask_id)
    }

    /// `runtime.answer`: the user's answer to the open question.
    pub async fn answer(self: &Arc<Self>, id: &SessionId, text: &str) -> Result<Value> {
        let _g = self.task_lock(id.as_str()).await;
        self.answer_locked(id, text).await
    }

    /// The answer, under the task's lock: kept for `pollAnswer`, the question taken off the task, a
    /// "You answered: …" row. For a live approval, Always adds a grant for this task and a denial is
    /// recorded on the turn (v1 `answer`).
    pub(crate) async fn answer_locked(self: &Arc<Self>, id: &SessionId, text: &str) -> Result<Value> {
        let mut s = self.repo.session(id.as_str()).await?;
        let Some(ask) = with_slot(&mut s.ext, |m| m.remove("ask")) else {
            return Err(RuntimeError::Conflict("Nothing is being asked on this task.".into()));
        };
        let ask_id = ask.get("id").and_then(Value::as_str).unwrap_or_default().to_owned();
        let mut turns = Vec::new();
        let last = self.last_turn(id.as_str()).await?;
        let label = match ask.get("permission") {
            Some(p) => {
                let d = approval_decision(text);
                let (tool, detail, action) = (str_at(p, "tool"), str_at(p, "detail"), str_at(p, "action"));
                if d.always {
                    with_slot(&mut s.ext, |m| push(m, "grants", json!({ "tool": tool, "detail": detail })));
                }
                if !d.allow && let Some(mut t) = last.clone() {
                    with_slot(&mut t.ext, |m| push(m, "denied", json!({ "tool": tool, "detail": detail })));
                    turns.push(t);
                }
                if d.allow { format!("You allowed{}: {action}", if d.always { " (always in this task)" } else { "" }) } else { format!("You denied: {action}{}", d.message.map(|m| format!(" (“{m}”)")).unwrap_or_default()) }
            }
            None => format!("You answered: {text}"),
        };
        self.asks().remove(&ask_id);
        self.answers().insert(ask_id.clone(), text.to_owned());
        s.state = if self.run_state(id.as_str()) == wisp_runtime_core::queue::Run::Idle { SessionState::Review } else { SessionState::Running };
        self.persist(&mut s, turns).await?;
        if let Some(t) = last {
            self.add_row(id.as_str(), t.id.as_str(), tool_row(ToolKind::Answer, label)).await?;
        }
        Ok(json!({ "answered": true, "askId": ask_id }))
    }

    /// `runtime.pollAnswer`: the answer once (then it's gone), pending while the question is on its
    /// task (also after a restart), else cancelled.
    pub fn poll_answer(&self, ask_id: &str) -> PollAnswer {
        if let Some(answer) = self.answers().remove(ask_id) {
            return PollAnswer::Answered { answer };
        }
        if self.asks().contains_key(ask_id) { PollAnswer::Pending } else { PollAnswer::Cancelled }
    }

    /// The task stopped: what its agent asked goes unanswered, and the task stops waiting.
    pub(crate) fn cancel_asks(&self, s: &mut Session) {
        if let Some(ask) = with_slot(&mut s.ext, |m| m.remove("ask")) {
            self.asks().remove(ask.get("id").and_then(Value::as_str).unwrap_or_default());
            if s.state == SessionState::Waiting {
                s.state = SessionState::Review;
            }
        }
    }

    /// Waits for the answer on the kernel's clock, at most `ms`.
    async fn wait_answer(&self, ask_id: &str, ms: i64) -> Option<String> {
        let until = self.now() + ms;
        loop {
            match self.poll_answer(ask_id) {
                PollAnswer::Answered { answer } => return Some(answer),
                PollAnswer::Pending if self.now() < until => self.clock.sleep(POLL_MS).await,
                _ => return None,
            }
        }
    }

    /// `runtime.approval` (v1 `requestApproval`): a live permission prompt. What the user allowed
    /// always in this task goes through at once; else Allow / Always allow in this task / Deny.
    /// Answers Claude Code's permission-prompt-tool shape.
    #[allow(clippy::many_single_char_names)] // s, h, p, a, d: v1 requestApproval's own names
    pub async fn approval(self: &Arc<Self>, a: wisp_runtime_api::commands::ApprovalArgs) -> Result<Value> {
        let s = self.repo.session(a.id.as_str()).await?;
        let h = self.harness(&s.agent)?;
        // a harness that can't say what the call does: the grant covers only this exact input
        let p = h.permission(&a.tool, &a.input, &s.cwd).unwrap_or_else(|| PermissionAsk { tool: a.tool.clone(), action: format!("use {}", a.tool), detail: a.input.to_string(), why: None });
        let last = self.last_turn(a.id.as_str()).await?;
        if slot(&s).and_then(|m| m.get("sideOf")).is_some() {
            if let Some(t) = &last {
                self.add_row(a.id.as_str(), t.id.as_str(), tool_row(ToolKind::Answer, format!("Refused (a side discussion only reads): {}", p.action))).await?;
            }
            return Ok(json!({ "behavior": "deny", "message": SIDE_DENIED }));
        }
        let granted = slot(&s).and_then(|m| m.get("grants")).and_then(Value::as_array).is_some_and(|g| g.iter().any(|x| str_at(x, "tool") == p.tool && str_at(x, "detail") == p.detail));
        if granted {
            if let Some(t) = &last {
                self.add_row(a.id.as_str(), t.id.as_str(), tool_row(ToolKind::Answer, format!("Allowed (always in this task): {}", p.action))).await?;
            }
            return Ok(json!({ "behavior": "allow", "updatedInput": a.input }));
        }
        let options = [APPROVAL_ALLOW, APPROVAL_ALWAYS, APPROVAL_DENY].map(str::to_owned);
        let question = format!("Allow {} to {}?", h.info().name, p.action);
        let permission = json!({ "tool": p.tool, "action": p.action, "detail": p.detail, "toolUseId": a.tool_use_id });
        let ask_id = self.ask_in(&a.id, &question, p.why.as_deref().unwrap_or_default(), &options, Some(permission)).await?;
        let Some(answer) = self.wait_answer(&ask_id, ASK_TIMEOUT_MS).await else {
            return Ok(json!({ "behavior": "deny", "message": "No answer from the user in time, or the task was stopped." }));
        };
        let d = approval_decision(&answer);
        Ok(if d.allow { json!({ "behavior": "allow", "updatedInput": a.input }) } else { json!({ "behavior": "deny", "message": d.message.unwrap_or_else(|| "The user denied this.".into()) }) })
    }
}
