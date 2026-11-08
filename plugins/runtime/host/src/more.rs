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
use wisp_runtime_api::harness::HarnessRun;
use wisp_runtime_api::model::{Mode, Session, SessionState, Turn, TurnStatus};
use wisp_runtime_api::{SessionId, TurnId};

use crate::error::{Result, RuntimeError};
use crate::runtime::Runtime;
use crate::sys::ProcSys;

/// What v1 gave a question before it gave up waiting (adapters/common.js `ASK_TIMEOUT_MS`).
pub const ASK_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// How long an armed sign-in waits for its login (v1 `SIGN_IN_MS`).
pub const SIGN_IN_MS: i64 = 15 * 60_000;
const QUICK_TIMEOUT_MS: u64 = 120_000;
const BTW_TIMEOUT: Duration = Duration::from_secs(300);
const SLOT: &str = "wisp.runtime";

/// An open question an agent asked, until it is answered or its task stops.
#[derive(Debug, Clone, Default)]
pub(crate) struct AskSlot {
    pub session: String,
    pub answer: Option<String>,
    pub cancelled: bool,
}

/// A turn that failed signed out, waiting for this login to land (v1 `armSignIn`).
#[derive(Debug, Clone)]
pub(crate) struct SignIn {
    pub session: String,
    pub agent: String,
    pub account: String,
    pub until: i64,
}

fn slot_mut(ext: &mut BTreeMap<String, Value>) -> &mut serde_json::Map<String, Value> {
    let v = ext.entry(SLOT.into()).or_insert_with(|| json!({}));
    if !v.is_object() {
        *v = json!({});
    }
    v.as_object_mut().unwrap_or_else(|| unreachable!("made an object above"))
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

    fn open_ask(&self, session: &str) -> Option<String> {
        self.asks().iter().find(|(_, a)| a.session == session && a.answer.is_none() && !a.cancelled).map(|(k, _)| k.clone())
    }

    /// Whether the task's agent is waiting on a question (a follow-up answers it).
    pub(crate) fn asking(&self, session: &str) -> bool {
        self.open_ask(session).is_some()
    }

    // ---------- questions and approvals ----------

    /// `runtime.ask`: the agent's question goes on its task; `pollAnswer` waits for the answer.
    pub async fn ask(self: &Arc<Self>, a: AskArgs) -> Result<String> {
        let _g = self.task_lock(a.id.as_str()).await;
        let mut s = self.repo.session(a.id.as_str()).await?;
        if let Some(old) = self.open_ask(a.id.as_str())
            && let Some(x) = self.asks().get_mut(&old)
        {
            x.cancelled = true;
        }
        let ask_id = wisp_kernel::ids::uuid7();
        self.asks().insert(ask_id.clone(), AskSlot { session: a.id.0.clone(), ..AskSlot::default() });
        slot_mut(&mut s.ext).insert("ask".into(), json!({ "id": ask_id, "question": a.question, "options": a.options, "details": a.details, "at": self.now() }));
        s.unread = true;
        self.persist(&mut s, Vec::new()).await?;
        Ok(ask_id)
    }

    /// `runtime.answer`: the user's answer to the open question.
    pub async fn answer(self: &Arc<Self>, id: &SessionId, text: &str) -> Result<Value> {
        let _g = self.task_lock(id.as_str()).await;
        self.answer_locked(id, text).await
    }

    pub(crate) async fn answer_locked(self: &Arc<Self>, id: &SessionId, text: &str) -> Result<Value> {
        let ask = self.open_ask(id.as_str()).ok_or_else(|| RuntimeError::Conflict("Nothing is being asked on this task.".into()))?;
        if let Some(x) = self.asks().get_mut(&ask) {
            x.answer = Some(text.to_owned());
        }
        let mut s = self.repo.session(id.as_str()).await?;
        slot_mut(&mut s.ext).remove("ask");
        self.persist(&mut s, Vec::new()).await?;
        Ok(json!({ "answered": true, "askId": ask }))
    }

    /// `runtime.pollAnswer`: the answer, once there is one.
    pub fn poll_answer(&self, ask_id: &str) -> PollAnswer {
        match self.asks().get(ask_id) {
            Some(AskSlot { answer: Some(a), .. }) => PollAnswer::Answered { answer: a.clone() },
            Some(AskSlot { cancelled: false, .. }) => PollAnswer::Pending,
            _ => PollAnswer::Cancelled,
        }
    }

    /// The task stopped: what its agent asked goes unanswered.
    pub(crate) fn cancel_asks(&self, session: &str) {
        for a in self.asks().values_mut().filter(|a| a.session == session && a.answer.is_none()) {
            a.cancelled = true;
        }
    }

    /// `runtime.approval`: a live permission prompt (Edits mode) as a question; Claude Code's
    /// permission-prompt-tool answer when the user decides.
    pub async fn approval(self: &Arc<Self>, a: wisp_runtime_api::commands::ApprovalArgs) -> Result<Value> {
        let detail = a.input.get("command").or_else(|| a.input.get("file_path")).and_then(Value::as_str).unwrap_or_default().to_owned();
        let question = if detail.is_empty() { format!("Allow {}?", a.tool) } else { format!("Allow {}: {detail}?", a.tool) };
        let ask_id = self
            .ask(AskArgs { id: a.id.clone(), question, options: vec!["Allow".into(), "Deny".into()], details: Some(json!({ "kind": "approval", "tool": a.tool, "input": a.input, "toolUseId": a.tool_use_id })) })
            .await?;
        let until = tokio::time::Instant::now() + ASK_TIMEOUT;
        loop {
            match self.poll_answer(&ask_id) {
                PollAnswer::Answered { answer } if answer.trim().eq_ignore_ascii_case("allow") => return Ok(json!({ "behavior": "allow", "updatedInput": a.input })),
                PollAnswer::Answered { answer } => return Ok(json!({ "behavior": "deny", "message": format!("The user didn’t allow it: {answer}") })),
                PollAnswer::Cancelled => return Ok(json!({ "behavior": "deny", "message": "The task was stopped." })),
                PollAnswer::Pending if tokio::time::Instant::now() >= until => return Ok(json!({ "behavior": "deny", "message": "No answer in time." })),
                PollAnswer::Pending => tokio::time::sleep(Duration::from_millis(250)).await,
            }
        }
    }

    /// `runtime.approveBlocked` (v1 `approveBlocked`): what the last turn's permissions blocked, run in
    /// a follow-up with exactly those rules allowed (or in Full auto when a rule is unknown).
    pub async fn approve_blocked(self: &Arc<Self>, id: &SessionId, turn: Option<&TurnId>, allow: bool) -> Result<Value> {
        let s = self.repo.session(id.as_str()).await?;
        let mut t = self.turn_of(id.as_str(), turn).await?;
        let blocked: Vec<Value> = t.ext.get(SLOT).and_then(|x| x.get("blocked")).and_then(Value::as_array).cloned().unwrap_or_default();
        if blocked.is_empty() {
            return Err(RuntimeError::NoTurn("Nothing on that turn is waiting for approval.".into()));
        }
        if let Some(done) = t.ext.get(SLOT).and_then(|x| x.get("approval")).and_then(Value::as_str) {
            return Err(RuntimeError::Conflict(format!("Already {done}.")));
        }
        let last = self.last_turn(id.as_str()).await?;
        if last.as_ref().is_none_or(|l| l.id != t.id) || t.status == TurnStatus::Running {
            return Err(RuntimeError::Conflict("The task has moved on since; send a follow-up instead.".into()));
        }
        slot_mut(&mut t.ext).insert("approval".into(), json!(if allow { "allowed" } else { "denied" }));
        let mut s2 = s.clone();
        self.persist(&mut s2, vec![t]).await?;
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
            slot_mut(&mut s.ext).insert("next".into(), extras);
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
        tokio::spawn(async move {
            match rt.side_run(h.as_ref(), &run, BTW_TIMEOUT).await {
                Ok(o) if !o.is_error => e.answer = o.text,
                Ok(o) => e.error = Some(o.text),
                Err(err) => e.error = Some(err.to_string()),
            }
            e.pending = false;
            let _ = rt.put_btw(&s.id.0, &e).await;
        });
        Ok(entry)
    }

    async fn put_btw(&self, id: &str, e: &BtwEntry) -> Result<()> {
        let _g = self.task_lock(id).await;
        let mut s = self.repo.session(id).await?;
        let list = slot_mut(&mut s.ext).entry("btw").or_insert_with(|| json!([]));
        let v = serde_json::to_value(e).map_err(|x| RuntimeError::Invalid(x.to_string()))?;
        if let Some(arr) = list.as_array_mut() {
            match arr.iter_mut().find(|x| x.get("id").and_then(Value::as_str) == Some(e.id.as_str())) {
                Some(x) => *x = v,
                None => arr.push(v),
            }
        }
        self.persist(&mut s, Vec::new()).await.map(|_| ())
    }

    /// `runtime.btw.drop`
    pub async fn btw_drop(self: &Arc<Self>, id: &str, btw: &str) -> Result<()> {
        let _g = self.task_lock(id).await;
        let mut s = self.repo.session(id).await?;
        if let Some(arr) = slot_mut(&mut s.ext).get_mut("btw").and_then(Value::as_array_mut) {
            arr.retain(|x| x.get("id").and_then(Value::as_str) != Some(btw));
        }
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
        let mut s = self.repo.session(a.id.as_str()).await?;
        let Some(mut t) = self.last_turn(a.id.as_str()).await?.filter(|t| t.id == a.turn_id) else { return Ok(none) };
        let signed_out = t.ext.get(SLOT).and_then(|x| x.get("authFailed")).and_then(Value::as_bool).unwrap_or(false);
        let again = t.ext.get(SLOT).and_then(|x| x.get("rerun")).is_some();
        if !signed_out || again || t.status != TurnStatus::Error || s.state == SessionState::Running || !s.queue.is_empty() {
            return Ok(none);
        }
        slot_mut(&mut t.ext).insert("rerun".into(), json!(self.now()));
        if let Some(acc) = a.account.filter(|x| !x.is_empty()) {
            s.account = Some(acc);
        }
        self.persist(&mut s, vec![t.clone()]).await?;
        self.follow_up(FollowUpArgs { id: a.id, text: t.prompt, attachments: t.attachments, queue: Some(true), by: t.by, ..FollowUpArgs::default() }).await
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
        slot_mut(&mut s.ext).insert("forkOf".into(), json!({ "id": src.id, "turnId": upto.id }));
        slot_mut(&mut s.ext).insert("next".into(), json!({ "fork": true }));
        let copies: Vec<Turn> = turns.into_iter().map(|t| Turn { id: TurnId::new(), session_id: s.id.clone(), ..t }).collect();
        let summary = self.persist(&mut s, copies).await?;
        self.host.emit(crate::host::Emitted::Created(wisp_runtime_api::events::SessionCreated { session: (*summary).clone() }));
        Ok(wisp_runtime_api::commands::Created { id: s.id, turn_id: None })
    }

    // ---------- subagents ----------

    /// `runtime.delegate`: each task starts as a subagent of the lead (`agent` or `agent:model`).
    pub async fn delegate(self: &Arc<Self>, a: DelegateArgs) -> Result<Vec<Delegation>> {
        let lead = self.repo.session(a.id.as_str()).await?;
        let mut out = Vec::new();
        for t in a.tasks {
            let (agent, model) = t.subagent.split_once(':').map_or((t.subagent.as_str(), ""), |(a, m)| (a, m));
            let agent = if agent.is_empty() || agent == "self" { lead.agent.clone() } else { agent.to_owned() };
            if self.harness(&agent).is_err() {
                out.push(Delegation { id: SessionId(String::new()), subagent: t.subagent.clone(), agent, model: model.to_owned(), effort: String::new(), turn_id: TurnId(String::new()), place: None, error: Some("That harness isn’t on this computer.".into()) });
                continue;
            }
            let c = self
                .create(StartArgs {
                    prompt: t.prompt,
                    agent: Some(agent.clone()),
                    model: (!model.is_empty()).then(|| model.to_owned()),
                    mode: Some(lead.mode),
                    cwd: Some(lead.cwd.clone()),
                    dirs: lead.dirs.clone(),
                    parent_id: Some(lead.id.clone()),
                    by: Some("lead".into()),
                    ..StartArgs::default()
                })
                .await?;
            let s = self.repo.session(c.id.as_str()).await?;
            out.push(Delegation { id: c.id, subagent: t.subagent, agent, model: s.model, effort: s.effort, turn_id: c.turn_id.unwrap_or_else(|| TurnId(String::new())), place: None, error: None });
        }
        Ok(out)
    }

    /// `runtime.results`: the subagents' reports, waiting up to `wait` seconds for them to finish.
    pub async fn results(self: &Arc<Self>, a: ResultsArgs) -> Result<Reports> {
        let until = tokio::time::Instant::now() + Duration::from_secs(u64::from(a.wait.unwrap_or(0).min(600)));
        loop {
            let mut reports = Vec::new();
            let mut all_done = true;
            for id in &a.ids {
                let s = self.repo.session(id.as_str()).await?;
                if s.parent_id.as_ref() != Some(&a.id) {
                    continue;
                }
                let last = self.last_turn(id.as_str()).await?;
                let done = s.state != SessionState::Running;
                all_done &= done;
                let text = last.as_ref().and_then(|t| t.text.clone()).unwrap_or_default();
                let cost = last.as_ref().and_then(|t| t.stats.as_ref()).and_then(|x| x.cost_usd);
                reports.push(Report { id: s.id.clone(), subagent: s.agent.clone(), state: s.state, done, text, cost_usd: cost });
            }
            if all_done || tokio::time::Instant::now() >= until {
                return Ok(Reports { reports });
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
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
        slot_mut(&mut t.ext).insert("overage".into(), json!({ "kind": kind, "at": self.now() }));
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
