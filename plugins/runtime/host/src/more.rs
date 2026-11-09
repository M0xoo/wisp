//! The rest of v1 runner.js's surface, over the same session, turn and queue primitives: an agent's
//! questions (`ask`, `answer`, `pollAnswer`) and live approvals, blocked actions allowed for one
//! follow-up, /btw side questions, compacting, subagents (`delegate`, `results`), forking, `quick`
//! side runs, a signed-out turn's sign-in and rerun, a turn billed past its plan, and the harnesses
//! as Settings → Agents shows them.
//!
//! size-ok: one impl block per v1 surface, each method short

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use wisp_runtime_api::commands::{
    AgentStatus, AgentsArgs, AskArgs, BtwArgs, BtwEntry, DelegateArgs, Delegation, FollowUpArgs, FollowedUp, ForkArgs, PollAnswer, QuickArgs, QuickResult, Report, Reports, RerunArgs, ResultsArgs, RunPick, StartArgs,
};
use wisp_runtime_api::harness::{HarnessRun, PermissionAsk};
use wisp_runtime_api::model::{Activity, Mode, Session, SessionState, ToolKind, Turn, TurnStatus};
use wisp_runtime_api::{SessionId, TurnId};

use crate::error::{Result, RuntimeError};
use crate::runtime::Runtime;
use crate::sys::ProcSys;

/// What v1 gave a question before it gave up waiting (adapters/common.js `ASK_TIMEOUT_MS`).
pub const ASK_TIMEOUT_MS: i64 = 30 * 60_000;
/// How often a wait on an answer or on subagents looks again.
const POLL_MS: u64 = 250;
/// The answers a live approval offers (v1 `APPROVAL`). Typed text instead is a "no, do this instead".
pub const APPROVAL_ALLOW: &str = "Allow";
pub const APPROVAL_ALWAYS: &str = "Always allow in this task";
pub const APPROVAL_DENY: &str = "Deny";
const SIDE_DENIED: &str = "Refused: a side discussion only reads. Ask the main task to do it.";
/// How long an armed sign-in waits for its login (v1 `SIGN_IN_MS`).
pub const SIGN_IN_MS: i64 = 15 * 60_000;
const QUICK_TIMEOUT_MS: u64 = 120_000;
const BTW_TIMEOUT: Duration = Duration::from_secs(300);
/// A member's copies (`codex#1`, `codex#2`) when it runs more than one at once (v1 subagents.js `copies`).
fn copies(name: &str, count: u64) -> Vec<String> {
    if count > 1 { (1..=count).map(|i| format!("{name}#{i}")).collect() } else { vec![name.to_owned()] }
}
const SLOT: &str = "wisp.runtime";

/// A turn that failed signed out, waiting for this login to land (v1 `armSignIn`).
#[derive(Debug, Clone)]
pub(crate) struct SignIn {
    pub session: String,
    pub agent: String,
    pub account: String,
    pub until: i64,
}

/// The open question's id, from the task itself (the truth across a restart).
pub(crate) fn ask_id(s: &Session) -> Option<String> {
    slot(s)?.get("ask")?.get("id")?.as_str().map(str::to_owned)
}

fn slot(s: &Session) -> Option<&serde_json::Map<String, Value>> {
    s.ext.get(SLOT)?.as_object()
}

fn str_at(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or_default().to_owned()
}

/// Appends to a list in the slot (made if missing).
fn push(m: &mut serde_json::Map<String, Value>, k: &str, v: Value) {
    match m.get_mut(k) {
        Some(Value::Array(a)) => a.push(v),
        _ => {
            m.insert(k.into(), Value::Array(vec![v]));
        }
    }
}

fn tool_row(tool: ToolKind, label: String) -> Activity {
    Activity::Tool { tool, label, file: None, detail: None, call_id: None, output: None }
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

/// Runs `f` on runtime's own ext slot (made an object if it wasn't one), then puts it back.
fn with_slot<R>(ext: &mut BTreeMap<String, Value>, f: impl FnOnce(&mut serde_json::Map<String, Value>) -> R) -> R {
    let mut m = match ext.remove(SLOT) {
        Some(Value::Object(m)) => m,
        _ => serde_json::Map::new(),
    };
    let out = f(&mut m);
    ext.insert(SLOT.into(), Value::Object(m));
    out
}

fn retry_prompt(items: &[Value], scoped: bool) -> String {
    let list: Vec<String> = items
        .iter()
        .map(|b| {
            let tool = b.get("tool").and_then(Value::as_str).unwrap_or("?");
            match b.get("detail").and_then(Value::as_str).filter(|d| !d.is_empty()) {
                Some(d) => format!("- {tool}: `{d}`"),
                None => format!("- {tool}"),
            }
        })
        .collect();
    let how = if scoped { "I allowed exactly these for this follow-up" } else { "This follow-up runs in Full auto, so nothing is blocked" };
    format!("These actions were blocked by your permissions last turn:\n{}\n\n{how}. Run them now and finish the task.", list.join("\n"))
}

fn account_of(a: Option<&str>) -> String {
    a.filter(|a| !a.is_empty() && *a != "default").unwrap_or_default().to_owned()
}

fn first_json(text: &str) -> Option<Value> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    (end > start).then(|| serde_json::from_str::<Value>(&text[start..=end]).ok()).flatten().filter(Value::is_object)
}

impl Runtime {
    async fn last_turn(&self, id: &str) -> Result<Option<Turn>> {
        Ok(self.repo.turns(id, None, Some(1)).await?.pop())
    }

    async fn turn_of(&self, id: &str, turn: Option<&TurnId>) -> Result<Turn> {
        match turn {
            Some(t) => self.repo.turn(t.as_str()).await,
            None => self.last_turn(id).await?.ok_or_else(|| RuntimeError::NoTurn(id.to_owned())),
        }
    }

    // ---------- questions and approvals (v1 runner.js `ask`, `requestApproval`, `answer`, `pollAnswer`) ----------

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

    /// `runtime.approveBlocked` (v1 `approveBlocked`): what the last turn's permissions blocked, run in
    /// a follow-up with exactly those rules allowed (or in Full auto when a rule is unknown).
    pub async fn approve_blocked(self: &Arc<Self>, id: &SessionId, turn: Option<&TurnId>, allow: bool) -> Result<Value> {
        let blocked = {
            let _g = self.task_lock(id.as_str()).await;
            let s = self.repo.session(id.as_str()).await?;
            let mut t = self.turn_of(id.as_str(), turn).await?;
            let blocked: Vec<Value> = t.ext.get(SLOT).and_then(|x| x.get("blocked")).and_then(Value::as_array).cloned().unwrap_or_default();
            if blocked.is_empty() {
                return Err(RuntimeError::NoTurn("Nothing on that turn is waiting for approval.".into()));
            }
            if allow && slot(&s).and_then(|m| m.get("sideOf")).is_some() {
                return Err(RuntimeError::Conflict("A side discussion can’t allow this: ask the main task to do it.".into()));
            }
            if let Some(done) = t.ext.get(SLOT).and_then(|x| x.get("approval")).and_then(Value::as_str) {
                return Err(RuntimeError::Conflict(format!("Already {done}.")));
            }
            let last = self.last_turn(id.as_str()).await?;
            if last.as_ref().is_none_or(|l| l.id != t.id) || (t.status == TurnStatus::Running && self.run_state(id.as_str()) != wisp_runtime_core::queue::Run::Idle) {
                return Err(RuntimeError::Conflict("The task has moved on since; send a follow-up instead.".into()));
            }
            with_slot(&mut t.ext, |m| m.insert("approval".into(), json!(if allow { "allowed" } else { "denied" })));
            let mut s2 = s;
            self.persist(&mut s2, vec![t]).await?;
            blocked
        };
        if !allow {
            return Ok(json!({ "denied": true }));
        }
        let rules: Vec<String> = blocked.iter().filter_map(|b| b.get("rule").and_then(Value::as_str).map(str::to_owned)).collect();
        let scoped = rules.len() == blocked.len();
        let text = retry_prompt(&blocked, scoped);
        let out = self.follow_up_with(id, text, if scoped { json!({ "grants": rules }) } else { json!({ "once": "auto" }) }).await?;
        Ok(json!({ "turnId": out.turn_id, "queued": out.queued, "scoped": scoped }))
    }

    /// A follow-up with run extras in its queue item (`grants`, `once`, `fork`): read by `start_turn`.
    async fn follow_up_with(self: &Arc<Self>, id: &SessionId, text: String, extras: Value) -> Result<FollowedUp> {
        {
            let _g = self.task_lock(id.as_str()).await;
            let mut s = self.repo.session(id.as_str()).await?;
            with_slot(&mut s.ext, |m| m.insert("next".into(), extras));
            self.persist(&mut s, Vec::new()).await?;
        }
        self.follow_up(FollowUpArgs { id: id.clone(), text, queue: Some(true), ..FollowUpArgs::default() }).await
    }

    // ---------- /btw ----------

    /// `runtime.btw`: a side question answered on a copy of the conversation, kept on the task.
    #[allow(clippy::many_single_char_names)]
    pub async fn btw(self: &Arc<Self>, a: BtwArgs) -> Result<BtwEntry> {
        if a.question.trim().is_empty() {
            return Err(RuntimeError::Invalid("Ask something first.".into()));
        }
        let s = self.repo.session(a.id.as_str()).await?;
        let h = self.harness(&s.agent)?;
        let entry = BtwEntry { id: wisp_kernel::ids::uuid7(), question: a.question.clone(), answer: String::new(), at: self.now(), pending: true, error: None };
        self.put_btw(a.id.as_str(), &entry).await?;
        let fork = h.info().fork && s.resume_id.is_some();
        let run = HarnessRun {
            session_id: s.id.0.clone(),
            prompt: a.question,
            attachments: a.attachments,
            cwd: s.cwd.clone(),
            dirs: s.dirs.clone(),
            resume_id: if fork { s.resume_id.clone() } else { None },
            fork,
            mode: Mode::Plan,
            model: s.model.clone(),
            effort: s.effort.clone(),
            gate: h.info().side_gate,
            ..HarnessRun::default()
        };
        let (rt, mut e) = (self.clone(), entry.clone());
        // owned by the plugin's scope: switching the runtime off ends the side run with it
        self.host.spawn(Box::pin(async move {
            match rt.side_run(h.as_ref(), &run, BTW_TIMEOUT).await {
                Ok(o) if !o.is_error => e.answer = o.text,
                Ok(o) => e.error = Some(o.text),
                Err(err) => e.error = Some(err.to_string()),
            }
            e.pending = false;
            let _ = rt.put_btw(&s.id.0, &e).await;
        }));
        Ok(entry)
    }

    async fn put_btw(&self, id: &str, e: &BtwEntry) -> Result<()> {
        let _g = self.task_lock(id).await;
        let mut s = self.repo.session(id).await?;
        let v = serde_json::to_value(e).map_err(|x| RuntimeError::Invalid(x.to_string()))?;
        with_slot(&mut s.ext, |m| {
            if let Some(arr) = m.entry("btw").or_insert_with(|| json!([])).as_array_mut() {
                match arr.iter_mut().find(|x| x.get("id").and_then(Value::as_str) == Some(e.id.as_str())) {
                    Some(x) => *x = v,
                    None => arr.push(v),
                }
            }
        });
        self.persist(&mut s, Vec::new()).await.map(|_| ())
    }

    /// `runtime.btw.drop`
    pub async fn btw_drop(self: &Arc<Self>, id: &str, btw: &str) -> Result<()> {
        let _g = self.task_lock(id).await;
        let mut s = self.repo.session(id).await?;
        with_slot(&mut s.ext, |m| {
            if let Some(arr) = m.get_mut("btw").and_then(Value::as_array_mut) {
                arr.retain(|x| x.get("id").and_then(Value::as_str) != Some(btw));
            }
        });
        self.persist(&mut s, Vec::new()).await.map(|_| ())
    }

    // ---------- compacting, rerunning, forking ----------

    /// `runtime.compact`: `/compact` as the next turn, by wisp (it doesn't count as your follow-up).
    pub async fn compact(self: &Arc<Self>, id: &SessionId) -> Result<FollowedUp> {
        self.follow_up(FollowUpArgs { id: id.clone(), text: "/compact".into(), queue: Some(true), by: Some("compact".into()), ..FollowUpArgs::default() }).await
    }

    /// `runtime.rerun` (v1 `rerunSignedOut`): a signed-out turn's request again, once, in the same
    /// conversation, on another account if one is given.
    pub async fn rerun(self: &Arc<Self>, a: RerunArgs) -> Result<FollowedUp> {
        let none = FollowedUp { turn_id: None, queued: None };
        let t = {
            let _g = self.task_lock(a.id.as_str()).await;
            let mut s = self.repo.session(a.id.as_str()).await?;
            let Some(mut t) = self.last_turn(a.id.as_str()).await?.filter(|t| t.id == a.turn_id) else { return Ok(none) };
            let signed_out = t.ext.get(SLOT).and_then(|x| x.get("authFailed")).and_then(Value::as_bool).unwrap_or(false);
            let again = t.ext.get(SLOT).and_then(|x| x.get("rerun")).is_some();
            if !signed_out || again || t.status != TurnStatus::Error || s.state == SessionState::Running || !s.queue.is_empty() {
                return Ok(none);
            }
            // once only: the mark is saved before anything is sent (two tabs, a phone, a restart)
            with_slot(&mut t.ext, |m| m.insert("rerun".into(), json!(self.now())));
            if let Some(acc) = a.account.filter(|x| !x.is_empty()) {
                s.account = Some(acc);
            }
            self.persist(&mut s, vec![t.clone()]).await?;
            t
        };
        // the run goes through `before:run` like any turn: the guard may hold it (v1's `guard.check`)
        let sent = self.follow_up(FollowUpArgs { id: a.id.clone(), text: t.prompt.clone(), attachments: t.attachments.clone(), queue: Some(false), by: t.by.clone(), ..FollowUpArgs::default() }).await;
        if sent.is_err() {
            // it never went: the card offers it again (v1 runner.js:2036)
            let _g = self.task_lock(a.id.as_str()).await;
            let mut s = self.repo.session(a.id.as_str()).await?;
            let mut t = self.repo.turn(t.id.as_str()).await?;
            with_slot(&mut t.ext, |m| m.remove("rerun"));
            self.persist(&mut s, vec![t]).await?;
        }
        sent
    }

    /// `runtime.adopt`: a read-only task holding someone else's turns (a `full` share); fork it to go on.
    pub async fn adopt(self: &Arc<Self>, a: wisp_runtime_api::spec::AdoptArgs) -> Result<wisp_runtime_api::commands::Created> {
        let now = self.now();
        let mut s = Session { id: SessionId::new(), title: a.title, agent: a.agent, cwd: a.cwd, state: SessionState::Done, created_at: now, updated_at: now, ..Session::default() };
        for (k, v) in a.ext {
            s.ext.insert(k, v);
        }
        let spec = serde_json::to_value(&a.spec).unwrap_or_default();
        // an outside session stays live: its follow-ups continue it in its CLI (ADR-0035)
        if a.resume_id.is_some() {
            s.resume_id.clone_from(&a.resume_id);
        } else {
            with_slot(&mut s.ext, |m| m.insert("readOnly".into(), json!(true)));
        }
        with_slot(&mut s.ext, |m| m.insert("spec".into(), spec));
        let copies: Vec<Turn> = a.turns.into_iter().filter_map(|t| serde_json::from_value::<Turn>(t).ok()).map(|t| Turn { id: TurnId::new(), session_id: s.id.clone(), ..t }).collect();
        if copies.is_empty() {
            return Err(RuntimeError::Invalid("a shared task to import has its turns (a full share)".into()));
        }
        let summary = self.persist(&mut s, copies).await?;
        self.host.emit(crate::host::Emitted::Created(wisp_runtime_api::events::SessionCreated { session: (*summary).clone() }));
        Ok(wisp_runtime_api::commands::Created { id: s.id, turn_id: None })
    }

    /// `runtime.fork`: a new task with this one's turns up to `turn_id`, resuming a copy of its conversation.
    pub async fn fork(self: &Arc<Self>, a: ForkArgs) -> Result<wisp_runtime_api::commands::Created> {
        let src = self.repo.session(a.id.as_str()).await?;
        let upto = self.turn_of(a.id.as_str(), a.turn_id.as_ref()).await?;
        let turns: Vec<Turn> = self.repo.turns(a.id.as_str(), None, None).await?.into_iter().filter(|t| t.idx <= upto.idx).collect();
        let now = self.now();
        let mut s = Session {
            id: SessionId::new(),
            title: a.title.filter(|t| !t.trim().is_empty()).unwrap_or_else(|| format!("{} (fork)", src.title)),
            agent: src.agent.clone(),
            model: src.model.clone(),
            effort: src.effort.clone(),
            account: src.account.clone(),
            mode: src.mode,
            cwd: src.cwd.clone(),
            dirs: src.dirs.clone(),
            state: SessionState::Review,
            resume_id: upto.resume_id.clone().or_else(|| src.resume_id.clone()),
            created_at: now,
            updated_at: now,
            ..Session::default()
        };
        with_slot(&mut s.ext, |m| m.insert("forkOf".into(), json!({ "id": src.id, "turnId": upto.id })));
        with_slot(&mut s.ext, |m| m.insert("next".into(), json!({ "fork": true })));
        let copies: Vec<Turn> = turns.into_iter().map(|t| Turn { id: TurnId::new(), session_id: s.id.clone(), ..t }).collect();
        let summary = self.persist(&mut s, copies).await?;
        self.host.emit(crate::host::Emitted::Created(wisp_runtime_api::events::SessionCreated { session: (*summary).clone() }));
        Ok(wisp_runtime_api::commands::Created { id: s.id, turn_id: None })
    }

    // ---------- subagents ----------

    /// `runtime.delegate` (v1 `delegate`): the lead hands tasks to members of its team
    /// (`ext["wisp.runtime"].subagents`: `{name, agent, model?, effort?, count?}`). Each member (or copy,
    /// `codex#2`) is one child task, made on first use and resumed after; it follows the lead's folder,
    /// mode and cap. One record (or an error) per task; the delegations go on the lead's turn.
    pub async fn delegate(self: &Arc<Self>, a: DelegateArgs) -> Result<Vec<Delegation>> {
        let lead = self.repo.session(a.id.as_str()).await?;
        let Some(turn) = self.last_turn(a.id.as_str()).await?.filter(|t| t.status == TurnStatus::Running) else {
            return Err(RuntimeError::Conflict("The lead agent is not running.".into()));
        };
        let team: Vec<Value> = slot(&lead).and_then(|m| m.get("subagents")).and_then(Value::as_array).cloned().unwrap_or_default();
        if team.is_empty() {
            return Err(RuntimeError::Invalid("This session has no subagents yet. Name a harness (agent, and machine to run it elsewhere) in each task to create one.".into()));
        }
        let children: serde_json::Map<String, Value> = slot(&lead).and_then(|m| m.get("children")).and_then(Value::as_object).cloned().unwrap_or_default();
        let capped = slot(&lead).and_then(|m| m.get("capped")).cloned();
        let names: Vec<String> = team.iter().map(|m| str_at(m, "name")).collect();
        let mut claimed: Vec<String> = Vec::new();
        let mut made = serde_json::Map::new();
        let mut out = Vec::new();
        let err = |subagent: &str, why: String| Delegation { id: SessionId(String::new()), subagent: subagent.to_owned(), agent: String::new(), model: String::new(), effort: String::new(), turn_id: TurnId(String::new()), place: None, error: Some(why) };
        for task in a.tasks {
            let want = task.subagent.trim().to_owned();
            let prompt = task.prompt.trim().to_owned();
            let Some(m) = team.iter().find(|m| str_at(m, "name") == want || copies(&str_at(m, "name"), m.get("count").and_then(Value::as_u64).unwrap_or(1)).contains(&want)) else {
                out.push(err(&want, format!("No subagent named \"{want}\". The team: {}.", names.join(", "))));
                continue;
            };
            if prompt.is_empty() {
                out.push(err(&want, "The task prompt is empty.".into()));
                continue;
            }
            let (name, count) = (str_at(m, "name"), m.get("count").and_then(Value::as_u64).unwrap_or(1));
            if m.get("machine").is_some_and(|x| !x.is_null()) || m.get("crew").is_some_and(|x| !x.is_null()) {
                out.push(err(&want, "Members on another machine or from the crew can't take work here yet.".into()));
                continue;
            }
            let busy = |n: &String| claimed.contains(n) || children.get(n).and_then(Value::as_str).is_some_and(|c| self.run_state(c) != wisp_runtime_core::queue::Run::Idle);
            let pool = if want == name { copies(&name, count) } else { vec![want.clone()] };
            let Some(slot_name) = pool.into_iter().find(|n| !busy(n)) else {
                let all = if count > 1 && want == name { format!(" (all {count} copies)") } else { String::new() };
                out.push(err(&want, format!("{want} is still working{all} on earlier tasks. Wait with subagent_results, then delegate again.")));
                continue;
            };
            claimed.push(slot_name.clone());
            let existing = children.get(&slot_name).and_then(Value::as_str).map(str::to_owned);
            let (child, child_turn) = self.run_member(&lead, m, &slot_name, existing, &prompt, capped.as_ref(), &mut made).await?;
            let c = self.repo.session(&child).await?;
            out.push(Delegation { id: c.id.clone(), subagent: slot_name, agent: c.agent, model: c.model, effort: c.effort, turn_id: child_turn.unwrap_or_else(|| TurnId(String::new())), place: None, error: None });
        }
        let sent: Vec<&Delegation> = out.iter().filter(|d| d.error.is_none()).collect();
        if !sent.is_empty() {
            let _g = self.task_lock(a.id.as_str()).await;
            let mut l = self.repo.session(a.id.as_str()).await?;
            let mut t = self.repo.turn(turn.id.as_str()).await?;
            let now = self.now();
            with_slot(&mut l.ext, |x| {
                let kids = x.entry("children").or_insert_with(|| json!({}));
                if let Some(k) = kids.as_object_mut() {
                    k.extend(made);
                }
            });
            with_slot(&mut t.ext, |x| {
                for d in &sent {
                    push(x, "delegations", json!({ "name": d.subagent, "sessionId": d.id, "turnId": d.turn_id, "agent": d.agent, "model": d.model, "startedAt": now, "owed": true }));
                }
            });
            self.persist(&mut l, vec![t]).await?;
            let mut who: Vec<&str> = sent.iter().map(|d| d.subagent.as_str()).collect();
            who.dedup();
            self.add_row(a.id.as_str(), turn.id.as_str(), tool_row(ToolKind::Agent, format!("Delegated to {}", who.join(", ")))).await?;
        }
        Ok(out)
    }

    /// One member's task: its child resumed (following the lead's folder, mode and cap), or made.
    #[allow(clippy::too_many_arguments)]
    async fn run_member(self: &Arc<Self>, lead: &Session, m: &Value, slot_name: &str, existing: Option<String>, prompt: &str, capped: Option<&Value>, made: &mut serde_json::Map<String, Value>) -> Result<(String, Option<TurnId>)> {
        let (prompt, capped) = (prompt.to_owned(), capped.cloned());
        let slot_name = slot_name.to_owned();
    Ok(match existing {
            Some(cid) if self.repo.session(&cid).await.is_ok() => {
                {
                    let _g = self.task_lock(&cid).await;
                    let mut c = self.repo.session(&cid).await?;
                    c.cwd.clone_from(&lead.cwd); // follows the lead if its folder moved
                    c.mode = lead.mode; // and its mode
                    with_slot(&mut c.ext, |x| match &capped {
                        Some(cap) => x.insert("capped".into(), cap.clone()),
                        None => x.remove("capped"),
                    });
                    self.persist(&mut c, Vec::new()).await?;
                }
                let f = self.follow_up(FollowUpArgs { id: SessionId(cid.clone()), text: prompt.clone(), queue: Some(false), by: Some("lead".into()), ..FollowUpArgs::default() }).await?;
                (cid, f.turn_id)
            }
            _ => {
                let mut ext = BTreeMap::new();
                let mut own = serde_json::Map::new();
                own.insert("member".into(), json!(slot_name));
                if let Some(cap) = &capped {
                    own.insert("capped".into(), cap.clone());
                }
                ext.insert(SLOT.to_owned(), Value::Object(own));
                let c = self
                    .create(StartArgs {
                        prompt: prompt.clone(),
                        agent: Some(str_at(m, "agent")).filter(|x| !x.is_empty() && x != "auto"),
                        model: Some(str_at(m, "model")).filter(|x| !x.is_empty()),
                        effort: Some(str_at(m, "effort")).filter(|x| !x.is_empty()),
                        mode: Some(lead.mode),
                        cwd: Some(lead.cwd.clone()),
                        dirs: lead.dirs.clone(),
                        parent_id: Some(lead.id.clone()),
                        by: Some("lead".into()),
                        ext,
                        ..StartArgs::default()
                    })
                    .await?;
                made.insert(slot_name.clone(), json!(c.id));
                (c.id.0, c.turn_id)
            }
        })
    }

    /// `runtime.results`: the subagents' reports, waiting up to `wait` seconds (kernel clock) for them
    /// to finish. No ids: every task delegated on the lead's last turn.
    pub async fn results(self: &Arc<Self>, a: ResultsArgs) -> Result<Reports> {
        let until = self.now() + i64::from(a.wait.unwrap_or(0).min(600)) * 1000;
        let ids: Vec<String> = if a.ids.is_empty() {
            let t = self.last_turn(a.id.as_str()).await?;
            t.as_ref().and_then(|t| t.ext.get(SLOT)).and_then(|x| x.get("delegations")).and_then(Value::as_array).into_iter().flatten().map(|d| str_at(d, "sessionId")).collect()
        } else {
            a.ids.iter().map(|i| i.0.clone()).collect()
        };
        loop {
            let mut reports = Vec::new();
            let mut all_done = true;
            for id in &ids {
                let s = self.repo.session(id).await?;
                if s.parent_id.as_ref() != Some(&a.id) {
                    continue;
                }
                let last = self.last_turn(id).await?;
                let done = s.state != SessionState::Running;
                all_done &= done;
                let text = last.as_ref().and_then(|t| t.text.clone()).unwrap_or_default();
                let cost = last.as_ref().and_then(|t| t.stats.as_ref()).and_then(|x| x.cost_usd);
                let name = slot(&s).and_then(|m| m.get("member")).and_then(Value::as_str).map_or_else(|| s.agent.clone(), str::to_owned);
                reports.push(Report { id: s.id.clone(), subagent: name, state: s.state, done, text, cost_usd: cost });
            }
            if all_done || self.now() >= until {
                return Ok(Reports { reports });
            }
            self.clock.sleep(POLL_MS).await;
        }
    }

    // ---------- quick, sign-in, overage, agents ----------

    /// `runtime.quick` (v1 quick.js): one answer from a harness, outside any task.
    pub async fn quick(self: &Arc<Self>, a: QuickArgs) -> Result<QuickResult> {
        let pick = a.pick.unwrap_or(RunPick { agent: None, model: None, effort: None });
        let h = match pick.agent.as_deref().filter(|x| !x.is_empty()) {
            Some(id) => self.harness(id)?,
            None => self.host.harnesses().into_iter().next().ok_or_else(|| RuntimeError::NoHarness("any".into()))?,
        };
        let model = pick.model.clone().unwrap_or_default();
        let run = HarnessRun { prompt: a.prompt, cwd: a.cwd, mode: Mode::Plan, model: model.clone(), effort: pick.effort.unwrap_or_default(), lean: true, quiet: true, ..HarnessRun::default() };
        let o = self.side_run(h.as_ref(), &run, Duration::from_millis(a.timeout_ms.unwrap_or(QUICK_TIMEOUT_MS))).await?;
        if o.is_error {
            return Err(RuntimeError::Conflict(o.text));
        }
        let json = a.json.then(|| first_json(&o.text)).flatten();
        Ok(QuickResult { text: o.text, json, agent: h.info().id.clone(), model, cost_usd: o.cost_usd, activity: Vec::new() })
    }

    /// `runtime.signIn` (v1 `armSignIn`): this signed-out turn reruns when its login lands.
    pub async fn sign_in(&self, id: &str, turn: &TurnId) -> Result<bool> {
        let Some(t) = self.last_turn(id).await?.filter(|t| &t.id == turn) else { return Ok(false) };
        let signed_out = t.ext.get(SLOT).and_then(|x| x.get("authFailed")).and_then(Value::as_bool).unwrap_or(false);
        if !signed_out || t.ext.get(SLOT).and_then(|x| x.get("rerun")).is_some() {
            return Ok(false);
        }
        let s = self.repo.session(id).await?;
        self.sign_ins().insert(t.id.0.clone(), SignIn { session: id.to_owned(), agent: t.agent.clone(), account: account_of(s.account.as_deref()), until: self.now() + SIGN_IN_MS });
        Ok(true)
    }

    /// `runtime.signInDone` (v1 `signInDone`): a login finished here; the turns armed for it run again.
    pub async fn sign_in_done(self: &Arc<Self>, agent: &str, account: &str) -> Result<()> {
        let acc = account_of(Some(account));
        let now = self.now();
        let due: Vec<(String, SignIn)> = {
            let mut m = self.sign_ins();
            m.retain(|_, x| x.until >= now);
            let keys: Vec<String> = m.iter().filter(|(_, x)| x.agent == agent && x.account == acc).map(|(k, _)| k.clone()).collect();
            keys.into_iter().filter_map(|k| m.remove(&k).map(|x| (k, x))).collect()
        };
        for (turn, x) in due {
            let s = self.repo.session(&x.session).await?;
            if s.archived || s.state == SessionState::Done {
                continue;
            }
            if let Err(e) = self.rerun(RerunArgs { id: s.id, turn_id: TurnId(turn), account: None }).await {
                tracing::warn!(error = %e, "rerun after sign-in");
            }
        }
        Ok(())
    }

    /// `runtime.overage` (v1 `#pastPlan`): the turn was billed past its plan; once per turn.
    pub async fn overage(self: &Arc<Self>, id: &str, turn: &TurnId, kind: &str) -> Result<()> {
        let _g = self.task_lock(id).await;
        let mut t = self.repo.turn(turn.as_str()).await?;
        if t.ext.get(SLOT).and_then(|x| x.get("overage")).is_some() {
            return Ok(());
        }
        with_slot(&mut t.ext, |m| m.insert("overage".into(), json!({ "kind": kind, "at": self.now() })));
        let mut s = self.repo.session(id).await?;
        self.persist(&mut s, vec![t]).await.map(|_| ())
    }

    /// `runtime.agents` (v1 adapters/index.js `list`): every harness, detected now.
    pub async fn agents(&self, _a: &AgentsArgs) -> Vec<AgentStatus> {
        let sys = ProcSys { proc: self.proc.clone() };
        let platform = match std::env::consts::OS {
            "macos" => "darwin",
            "windows" => "win32",
            other => other,
        };
        let mut out = Vec::new();
        for h in self.host.harnesses() {
            let info = h.info().clone();
            let found = h.detect(&sys).await;
            out.push(AgentStatus {
                id: info.id.clone(),
                name: info.name.clone(),
                available: found.available,
                version: found.version.clone(),
                error: found.error.clone(),
                models: found.models.clone().unwrap_or(info.models),
                efforts: found.efforts.clone().unwrap_or(info.efforts),
                delegates: info.ask_tool.is_some(),
                signed_in: found.signed_in,
                setup: if found.available { None } else { h.setup(platform) },
            });
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_prompt_is_v1s() {
        let b = vec![json!({"tool": "Bash", "detail": "npm publish", "rule": "Bash(npm publish)"}), json!({"tool": "Write"})];
        assert_eq!(retry_prompt(&b, true), "These actions were blocked by your permissions last turn:\n- Bash: `npm publish`\n- Write\n\nI allowed exactly these for this follow-up. Run them now and finish the task.");
        assert!(retry_prompt(&b, false).contains("runs in Full auto"));
    }

    #[test]
    fn a_quick_answer_reads_its_json() {
        assert_eq!(first_json("Sure:\n{\"a\": 1}\nDone"), Some(json!({"a": 1})));
        assert_eq!(first_json("no json"), None);
        assert_eq!(account_of(Some("default")), "");
    }
}
