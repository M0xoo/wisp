//! Subagents (v1 `delegate`, `results`): the lead hands tasks to members of its team and reads their reports.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde_json::{Value, json};
use wisp_runtime_api::commands::{DelegateArgs, Delegation, FollowUpArgs, Report, Reports, ResultsArgs, StartArgs};
use wisp_runtime_api::model::{Session, SessionState, ToolKind, TurnStatus};
use wisp_runtime_api::{SessionId, TurnId};

use super::{POLL_MS, SLOT, push, slot, str_at, tool_row, with_slot};
use crate::error::{Result, RuntimeError};
use crate::runtime::Runtime;

/// A member's copies (`codex#1`, `codex#2`) when it runs more than one at once (v1 subagents.js `copies`).
fn copies(name: &str, count: u64) -> Vec<String> {
    if count > 1 { (1..=count).map(|i| format!("{name}#{i}")).collect() } else { vec![name.to_owned()] }
}

/// The lead's crew jobs (`ext["wisp.runtime"].crewJobs`): job key → the team name it went to.
const CREW_JOBS: &str = "crewJobs";

/// A delegation that didn't go, and why.
fn failed(subagent: &str, why: String) -> Delegation {
    Delegation {
        id: SessionId(String::new()),
        subagent: subagent.to_owned(),
        agent: String::new(),
        model: String::new(),
        effort: String::new(),
        turn_id: TurnId(String::new()),
        place: None,
        error: Some(why),
    }
}

/// The member a task names, and the slot (it, or a free copy) that takes it, and whether its place is a sandbox;
/// or why it can't go.
fn member_slot<'a>(
    rt: &Runtime,
    team: &'a [Value],
    names: &[String],
    children: &serde_json::Map<String, Value>,
    claimed: &[String],
    want: &str,
    prompt: &str,
) -> std::result::Result<(&'a Value, String, bool), String> {
    let Some(m) = team.iter().find(|m| {
        str_at(m, "name") == want
            || copies(&str_at(m, "name"), m.get("count").and_then(Value::as_u64).unwrap_or(1)).iter().any(|c| c == want)
    }) else {
        return Err(format!("No subagent named \"{want}\". The team: {}.", names.join(", ")));
    };
    if prompt.is_empty() {
        return Err("The task prompt is empty.".into());
    }
    let (name, count) = (str_at(m, "name"), m.get("count").and_then(Value::as_u64).unwrap_or(1));
    if !str_at(m, "crew").is_empty() {
        // a crew member is one job at a time per name, up to their own limit (not copies)
        return Err(format!("Delegate to {name}, not {want}."));
    }
    let in_sandbox = str_at(m, "machine") == "sandbox";
    if m.get("machine").is_some_and(|x| !x.is_null()) && !in_sandbox {
        return Err(format!(
            "{want} runs on another machine, which can't take delegated work yet. Add a crew member on that machine and delegate to them, or use a sandbox."
        ));
    }
    let busy = |n: &String| {
        claimed.contains(n)
            || children.get(n).and_then(Value::as_str).is_some_and(|c| rt.run_state(c) != wisp_runtime_core::queue::Run::Idle)
    };
    let pool = if want == name { copies(&name, count) } else { vec![want.to_owned()] };
    let Some(slot_name) = pool.into_iter().find(|n| !busy(n)) else {
        let all = if count > 1 && want == name { format!(" (all {count} copies)") } else { String::new() };
        return Err(format!("{want} is still working{all} on earlier tasks. Wait with subagent_results, then delegate again."));
    };
    Ok((m, slot_name, in_sandbox))
}

impl Runtime {
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
            return Err(RuntimeError::Invalid(
                "This session has no subagents yet. Name a harness (agent, and machine to run it elsewhere) in each task to create one."
                    .into(),
            ));
        }
        let children: serde_json::Map<String, Value> =
            slot(&lead).and_then(|m| m.get("children")).and_then(Value::as_object).cloned().unwrap_or_default();
        let capped = slot(&lead).and_then(|m| m.get("capped")).cloned();
        let names: Vec<String> = team.iter().map(|m| str_at(m, "name")).collect();
        let mut claimed: Vec<String> = Vec::new();
        let mut made = serde_json::Map::new();
        let mut out = Vec::new();
        for task in a.tasks {
            let want = task.subagent.trim().to_owned();
            let prompt = task.prompt.trim().to_owned();
            // a member of the crew: a job of its own, run as them (crew.assign), not a hidden child
            if let Some(m) = team.iter().find(|m| str_at(m, "name") == want && !str_at(m, "crew").is_empty()) {
                out.push(if prompt.is_empty() {
                    failed(&want, "The task prompt is empty.".into())
                } else {
                    self.crew_member(&lead, m, &want, &prompt, capped.as_ref()).await
                });
                continue;
            }
            let (m, slot_name, in_sandbox) = match member_slot(self, &team, &names, &children, &claimed, &want, &prompt) {
                Ok(x) => x,
                Err(why) => {
                    out.push(failed(&want, why));
                    continue;
                }
            };
            claimed.push(slot_name.clone());
            let existing = children.get(&slot_name).and_then(Value::as_str).map(str::to_owned);
            // its place is a sandbox (ADR-0047): the lead's work goes in, the task runs there, its changes come back
            if in_sandbox {
                match self.sandbox_member(&lead, m, &slot_name, existing, &prompt).await {
                    Ok(key) => {
                        made.insert(slot_name.clone(), json!(key));
                        out.push(Delegation {
                            id: SessionId(key),
                            subagent: slot_name,
                            agent: str_at(m, "agent"),
                            model: str_at(m, "model"),
                            effort: str_at(m, "effort"),
                            turn_id: TurnId(String::new()),
                            place: Some("sandbox".into()),
                            error: None,
                        });
                    }
                    Err(e) => out.push(failed(&want, e.to_string())),
                }
                continue;
            }
            // one that didn't start is that task's error: the others (a crew job may have gone) are still kept
            let (child, child_turn) = match self.run_member(&lead, m, &slot_name, existing, &prompt, capped.as_ref(), &mut made).await {
                Ok(x) => x,
                Err(e) => {
                    out.push(failed(&want, e.to_string()));
                    continue;
                }
            };
            let c = self.repo.session(&child).await?;
            out.push(Delegation {
                id: c.id.clone(),
                subagent: slot_name,
                agent: c.agent,
                model: c.model,
                effort: c.effort,
                turn_id: child_turn.unwrap_or_else(|| TurnId(String::new())),
                place: None,
                error: None,
            });
        }
        self.note_delegations(&a.id, &turn.id, made, &out).await?;
        Ok(out)
    }

    /// The delegations that went, on the lead: its children by slot, a record each on its turn, a "Delegated to …" row.
    async fn note_delegations(
        self: &Arc<Self>,
        id: &SessionId,
        turn: &TurnId,
        made: serde_json::Map<String, Value>,
        out: &[Delegation],
    ) -> Result<()> {
        let sent: Vec<&Delegation> = out.iter().filter(|d| d.error.is_none()).collect();
        if sent.is_empty() {
            return Ok(());
        }
        let _g = self.task_lock(id.as_str()).await;
        let mut l = self.repo.session(id.as_str()).await?;
        let mut t = self.repo.turn(turn.as_str()).await?;
        let now = self.now();
        with_slot(&mut l.ext, |x| {
            let kids = x.entry("children").or_insert_with(|| json!({}));
            if let Some(k) = kids.as_object_mut() {
                k.extend(made);
            }
            // the crew jobs it handed out, by key (`<machine>|<id>` when the member works elsewhere): their reports
            let jobs = x.entry(CREW_JOBS).or_insert_with(|| json!({}));
            if let Some(j) = jobs.as_object_mut() {
                for d in sent.iter().filter(|d| d.place.as_deref() == Some("crew")) {
                    j.insert(d.id.0.clone(), json!(d.subagent));
                }
            }
        });
        with_slot(&mut t.ext, |x| {
            for d in &sent {
                push(
                    x,
                    "delegations",
                    json!({ "name": d.subagent, "sessionId": d.id, "turnId": d.turn_id, "agent": d.agent, "model": d.model, "startedAt": now, "owed": true }),
                );
            }
        });
        self.persist(&mut l, vec![t]).await?;
        let mut who: Vec<&str> = sent.iter().map(|d| d.subagent.as_str()).collect();
        who.dedup();
        self.add_row(id.as_str(), turn.as_str(), tool_row(ToolKind::Agent, format!("Delegated to {}", who.join(", ")))).await
    }

    /// One member's task: its child resumed (following the lead's folder, mode and cap), or made.
    #[allow(clippy::too_many_arguments)]
    async fn run_member(
        self: &Arc<Self>,
        lead: &Session,
        m: &Value,
        slot_name: &str,
        existing: Option<String>,
        prompt: &str,
        capped: Option<&Value>,
        made: &mut serde_json::Map<String, Value>,
    ) -> Result<(String, Option<TurnId>)> {
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
                let f = self
                    .follow_up(FollowUpArgs {
                        id: SessionId(cid.clone()),
                        text: prompt.clone(),
                        queue: Some(false),
                        by: Some("lead".into()),
                        ..FollowUpArgs::default()
                    })
                    .await?;
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
            t.as_ref()
                .and_then(|t| t.ext.get(SLOT))
                .and_then(|x| x.get("delegations"))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|d| str_at(d, "sessionId"))
                .collect()
        } else {
            a.ids.iter().map(|i| i.0.clone()).collect()
        };
        loop {
            let mut reports = Vec::new();
            let mut all_done = true;
            let lead = self.repo.session(a.id.as_str()).await?;
            let crew_jobs = slot(&lead).and_then(|m| m.get(CREW_JOBS)).and_then(Value::as_object).cloned().unwrap_or_default();
            for id in &ids {
                // a crew member's job: its own task, here or on the member's machine
                if let Some(name) = crew_jobs.get(id).and_then(Value::as_str) {
                    if let Some(r) = self.crew_report(&lead, id, name).await {
                        all_done &= r.done;
                        reports.push(r);
                    }
                    continue;
                }
                // a member in a sandbox: read there
                if id.contains('|') {
                    if let Some(r) = self.sandbox_report(&lead, id).await {
                        all_done &= r.done;
                        reports.push(r);
                    }
                    continue;
                }
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

    /// A crew member's task (v1 crew.js `#delegate`): `crew.assign` with `from` = the lead, so it runs as the
    /// member (their folder, harness, model, kit; on their machine when it's there) and the lead's Team tab lists it.
    async fn crew_member(&self, lead: &Session, m: &Value, name: &str, prompt: &str, capped: Option<&Value>) -> Delegation {
        use wisp_crew_api::commands as crew;
        let args = crew::AssignArgs {
            id: str_at(m, "crew"),
            prompt: prompt.to_owned(),
            from: Some(wisp_crew_api::TaskRef { id: lead.id.0.clone(), title: lead.title.clone() }),
            capped: capped.cloned(),
            ..crew::AssignArgs::default()
        };
        let label = Some(str_at(m, "label")).filter(|l| !l.is_empty()).unwrap_or_else(|| name.to_owned());
        let job = match crate::calls::run::<crew::Assign>(&*self.host, args).await {
            Ok(crew::Started { session: Some(job), .. }) => job,
            // a delegated job is never queued; say so rather than report a job that isn't there
            Ok(_) => return failed(name, format!("{label} couldn't start it now. Wait with subagent_results, or do it yourself.")),
            Err(e) if e.code == wisp_kernel::Code::NotFound => {
                return failed(name, format!("{label} is no longer on the user's crew."));
            }
            Err(e) => return failed(name, e.message),
        };
        Delegation {
            id: SessionId(str_at(&job, "id")),
            subagent: name.to_owned(),
            agent: str_at(&job, "agent"),
            model: str_at(&job, "model"),
            effort: str_at(&job, "effort"),
            turn_id: TurnId(String::new()),
            place: Some("crew".into()),
            error: None,
        }
    }

    /// A crew job's report: read here, or on the member's machine (`<machine>|<id>`, nothing brought back: the
    /// job worked in the member's folder there). `None`: it's gone, or not this lead's.
    async fn crew_report(self: &Arc<Self>, lead: &Session, key: &str, name: &str) -> Option<Report> {
        if key.contains('|') {
            return self.remote_report(lead, key, false).await.map(|r| Report { subagent: name.to_owned(), ..r });
        }
        let s = self.repo.session(key).await.ok()?;
        let from = s.ext.get(wisp_crew_api::PLUGIN_ID).and_then(|c| c.pointer("/from/id")).and_then(Value::as_str);
        if from != Some(lead.id.as_str()) {
            return None;
        }
        let last = self.last_turn(key).await.ok()?;
        Some(Report {
            id: s.id.clone(),
            subagent: name.to_owned(),
            state: s.state,
            done: s.state != SessionState::Running,
            text: last.as_ref().and_then(|t| t.text.clone()).unwrap_or_default(),
            cost_usd: last.as_ref().and_then(|t| t.stats.as_ref()).and_then(|x| x.cost_usd),
        })
    }
}
