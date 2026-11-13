//! Two of a task's agent tools runtime owns (v1 routes/control.js): `wisp_available` (`GET /internal/available/:id`)
//! and `wisp_task` (`POST /internal/task/:id`; its `wait` is wisp.mcp's own). Each answers `{ text }`, or `{ error }`:
//! the refusal the agent reads. The guards and the words are in `wisp_runtime_core::{agent_task, available}`; the
//! pieces come from runtime's own commands and, through their api crates, wisp.machines, wisp.sandbox and wisp.crew.

use std::sync::Arc;

use serde_json::{Value, json};
use wisp_kernel::{Setup, WireError};
use wisp_resources_api::StoredKind;
use wisp_runtime_api::SessionId;
use wisp_runtime_api::commands as c;
use wisp_runtime_api::model::{Mode, Session, SessionState, TurnStatus};
use wisp_runtime_core::agent_task::{self as words, Asking, Other, Refusal, Replied};
use wisp_runtime_core::available::{self, Available, Harness, Machine, This};

use super::{Slot, rt, track};
use crate::calls::run;
use crate::kinds::{TeamSpec, project_for};
use crate::runtime::Runtime;

type Said = std::result::Result<String, String>;

fn answer(r: Said) -> c::AgentText {
    match r {
        Ok(text) => c::AgentText { text: Some(text), error: None },
        Err(e) => c::AgentText { text: None, error: Some(e) },
    }
}

fn msg(e: WireError) -> String {
    e.message
}

fn slot_of(s: &Session) -> Option<&serde_json::Map<String, Value>> {
    s.ext.get("wisp.runtime")?.as_object()
}

pub(super) fn setup(s: &mut Setup, slot: &Slot, projects: Arc<StoredKind>, teams: Arc<StoredKind>) {
    let sl = slot.clone();
    s.command::<c::AgentAvailable, _, _>(move |ctx, call, a| {
        let (slot, projects, teams) = (sl.clone(), projects.clone(), teams.clone());
        async move {
            let r = rt(&slot)?;
            let cap = words::cap_of(&call.caller().set);
            let me = r.get(&a.session).await.map_err(WireError::from)?;
            track(&ctx, "wisp_available", json!({ "agent": me.agent })).await;
            Ok(answer(Ok(r.agent_available(&me, cap, &projects, &teams).await)))
        }
    });
    let sl = slot.clone();
    s.command::<c::AgentTask, _, _>(move |ctx, call, a| {
        let slot = sl.clone();
        async move {
            let r = rt(&slot)?;
            let cap = words::cap_of(&call.caller().set);
            let me = r.get(&a.session).await.map_err(WireError::from)?;
            let out = r.agent_task(&me, cap, &a).await;
            if out.as_ref().is_ok_and(|(acted, _)| *acted) {
                track(&ctx, "agent_task", json!({ "agent": me.agent, "action": a.action })).await;
            }
            Ok(answer(out.map(|(_, t)| t)))
        }
    });
}

impl Runtime {
    /// `wisp_available`: a capped task picks from its own project, on this computer: nothing else of the user's is named.
    async fn agent_available(&self, me: &Session, cap: Option<Mode>, projects: &StoredKind, teams: &StoredKind) -> String {
        let open = cap.is_none();
        let host = &*self.host;
        let harnesses = run::<c::Agents>(host, c::AgentsArgs::default()).await.unwrap_or_default();
        let project_list = projects.specs().await.unwrap_or_default();
        let mine = project_for(&project_list, &me.cwd).map(|(n, _)| n);
        let in_mine = |cwd: &str| match &mine {
            Some(n) => project_for(&project_list, cwd).is_some_and(|(p, _)| &p == n),
            None => cwd == me.cwd,
        };
        let crew = run::<wisp_crew_api::commands::List>(host, wisp_crew_api::commands::NoArgs {}).await.unwrap_or_default();
        let a = Available {
            harnesses: harnesses
                .into_iter()
                .map(|h| Harness {
                    models: h.models.into_iter().map(|m| m.id).collect(),
                    id: h.id,
                    name: h.name,
                    available: h.available,
                    signed_in: h.signed_in,
                    version: h.version,
                    efforts: h.efforts,
                })
                .collect(),
            machines: if open { self.machines_view().await } else { Vec::new() },
            sandbox: open && run::<wisp_sandbox_api::InfoCmd>(host, wisp_sandbox_api::Empty {}).await.is_ok_and(|i| i.enabled),
            projects: project_list
                .iter()
                .filter(|(n, _)| open || mine.as_ref() == Some(n))
                .map(|(n, v)| (n.clone(), v.get("path").and_then(Value::as_str).unwrap_or_default().to_owned()))
                .collect(),
            presets: if open { presets(&teams.specs().await.unwrap_or_default()) } else { Vec::new() },
            crew: crew.into_iter().map(|m| m.member).filter(|m| open || (!m.cwd.is_empty() && in_mine(&m.cwd))).map(|m| m.name).collect(),
            this: This {
                id: me.id.0.clone(),
                agent: me.agent.clone(),
                model: me.model.clone(),
                mode: words::mode_id(me.mode).into(),
                cwd: me.cwd.clone(),
                subagents: subagents(me),
                cap: cap.map(|m| words::mode_id(m).to_owned()),
            },
        };
        available::available_text(&a)
    }

    /// The user's machines, sandboxes left out (a /sandbox task's own box isn't a place to send work).
    async fn machines_view(&self) -> Vec<Machine> {
        let list = match run::<wisp_machines_api::List>(&*self.host, wisp_machines_api::NoArgs {}).await {
            Ok(l) => l,
            Err(e) => {
                tracing::warn!(error = %e.message, "runtime: machines.list for wisp_available");
                return Vec::new();
            }
        };
        list.into_iter()
            .filter(|p| p.data.get("sandbox").is_none_or(Value::is_null))
            .map(|p| Machine {
                state: serde_json::to_value(p.state).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default(),
                cloud: p.kind == "grid" || p.transport.contains("grid"),
                harnesses: p.remote.and_then(|r| r.agents).unwrap_or_default().into_iter().filter(|a| a.available).map(|a| a.id).collect(),
                id: p.id,
                name: p.name,
            })
            .collect()
    }

    /// `wisp_task`: (whether it acted, the answer), or the refusal.
    async fn agent_task(&self, me: &Session, cap: Option<Mode>, a: &c::AgentTaskArgs) -> std::result::Result<(bool, String), String> {
        let asking = Asking { id: me.id.as_str(), parent: me.parent_id.as_ref().map(SessionId::as_str), cap };
        if let Some(r) = words::lead_refusal(&asking) {
            return Err(refused(r));
        }
        let id = words::task_id(&a.task);
        let x = self.get(id).await.map_err(|_| words::no_task(id))?;
        let mode = a.mode.as_deref().map(|m| words::mode_of(m).ok_or_else(|| words::BAD_MODE.to_owned())).transpose();
        let other = Other {
            id: x.id.as_str(),
            parent: x.parent_id.as_ref().map(SessionId::as_str),
            agent: &x.agent,
            mode: x.mode,
            capped: slot_of(&x).is_some_and(|m| m.get("capped").is_some_and(|v| !v.is_null())),
            // v2 records no "started by" on a task (v1 `origin`): a capped agent acts on no other task
            started_by_asking: false,
        };
        if let Some(r) = words::refusal(&asking, &other, mode.clone().ok().flatten()) {
            return Err(refused(r));
        }
        let name = words::name(&x.title, x.id.as_str());
        let busy = matches!(x.state, SessionState::Running | SessionState::Waiting);
        let host = &*self.host;
        let sid = x.id.clone();
        let text = match a.action.as_str() {
            "reply" => self.agent_reply(&x, a, mode?, &name).await?,
            "stop" => {
                if x.state != SessionState::Running && self.run_state(x.id.as_str()) == wisp_runtime_core::queue::Run::Idle {
                    return Ok((true, format!("{name} isn't running.")));
                }
                run::<c::Stop>(host, c::StopArgs { id: sid, clear_queue: false }).await.map_err(msg)?;
                format!("Stopped {name}. Its queued follow-ups stay.")
            }
            "done" => {
                if busy {
                    return Err(words::still_working(&name));
                }
                run::<c::SetState>(host, c::SetStateArgs { id: sid, state: SessionState::Done })
                    .await
                    .map_err(|e| if e.code == wisp_kernel::Code::Conflict { words::still_working(&name) } else { e.message })?;
                format!("Marked {name} done.")
            }
            "archive" | "unarchive" => {
                let archive = a.action == "archive";
                if archive && busy {
                    return Err(words::still_working(&name));
                }
                run::<c::Archive>(host, c::ArchiveArgs { id: sid.clone(), archived: archive }).await.map_err(msg)?;
                if archive {
                    run::<c::MarkRead>(host, c::MarkReadArgs { id: sid.clone(), unread: false }).await.map_err(msg)?;
                }
                run::<c::ForLater>(host, c::ForLaterArgs { id: sid, for_later: false, at: None }).await.map_err(msg)?;
                format!("{} {name}.", if archive { "Archived" } else { "Unarchived" })
            }
            "rename" => {
                let title = words::title(a.title.as_deref().unwrap_or_default());
                if title.is_empty() {
                    return Err(words::NEEDS_TITLE.into());
                }
                run::<c::Rename>(host, c::RenameArgs { id: sid, title: title.clone() }).await.map_err(msg)?;
                format!("Renamed it “{title}”.")
            }
            _ => return Err(words::BAD_ACTION.into()),
        };
        Ok((true, text))
    }

    /// `wisp_task` reply: a follow-up through `runtime.followUp` (its hooks: budget, limits, a terminal task's CLI).
    async fn agent_reply(&self, x: &Session, a: &c::AgentTaskArgs, mode: Option<Mode>, name: &str) -> Said {
        let text = a.text.as_deref().unwrap_or_default().trim().to_owned();
        if text.is_empty() {
            return Err(words::NEEDS_TEXT.into());
        }
        if let Some(agent) = a.agent.as_deref().filter(|g| *g != x.agent) {
            let known: Vec<(String, String, bool, Option<bool>)> = run::<c::Agents>(&*self.host, c::AgentsArgs::default())
                .await
                .unwrap_or_default()
                .into_iter()
                .map(|h| (h.id, h.name, h.available, h.signed_in))
                .collect();
            if let Some(why) = words::harness_refusal(agent, &known) {
                return Err(why);
            }
        }
        let switch = a.agent.is_some() || a.model.is_some() || a.effort.is_some();
        let pick = switch.then(|| c::RunPick {
            agent: Some(a.agent.clone().filter(|g| !g.is_empty()).unwrap_or_else(|| x.agent.clone())),
            model: a.model.clone(),
            effort: a.effort.clone(),
        });
        let queue = a.queue == Some(Value::Bool(true)) || self.text_setting("runtime.followUp") == "queue";
        let asking = crate::more::ask_id(x).is_some();
        let running = self.run_state(x.id.as_str()) != wisp_runtime_core::queue::Run::Idle;
        let f = c::FollowUpArgs {
            id: x.id.clone(),
            text,
            queue: Some(queue),
            mode,
            run: pick,
            by: Some("agent".into()),
            ..c::FollowUpArgs::default()
        };
        let out = run::<c::FollowUp>(&*self.host, f).await.map_err(msg)?;
        let how = if asking {
            Replied::Answered
        } else if out.turn_id.is_some() {
            let held =
                self.repo.turns(x.id.as_str(), None, Some(1)).await.ok().and_then(|t| t.last().map(|t| t.status == TurnStatus::Held));
            if held == Some(true) { Replied::Held } else { Replied::Sent }
        } else if out.queued.is_some() {
            if running && !queue { Replied::Interrupted } else { Replied::Queued }
        } else {
            Replied::Sent
        };
        Ok(words::replied(how, name))
    }
}

fn refused(r: Refusal) -> String {
    match r {
        Refusal::Says(s) => s,
        Refusal::Capped(what) => wisp_kernel::caps::capped_refusal(what),
    }
}

/// The task's own subagents, by name (delegate's team).
fn subagents(s: &Session) -> Vec<String> {
    slot_of(s)
        .and_then(|m| m.get("subagents"))
        .and_then(Value::as_array)
        .map(|team| team.iter().filter_map(|m| m.get("name").and_then(Value::as_str)).map(str::to_owned).collect())
        .unwrap_or_default()
}

/// The saved teams (the `team` kind, v1 `teams`): (name, its seats in words).
fn presets(teams: &[(String, Value)]) -> Vec<(String, String)> {
    teams
        .iter()
        .filter_map(|(n, v)| Some((n, serde_json::from_value::<TeamSpec>(v.clone()).ok()?)))
        .map(|(n, t)| {
            let mut seats: Vec<String> = t
                .members
                .iter()
                .map(|(m, s)| match s.count.filter(|c| *c > 1) {
                    Some(k) => format!("{m} ({} ×{k})", s.agent),
                    None => format!("{m} ({})", s.agent),
                })
                .collect();
            if !t.lead.is_empty() {
                seats.insert(0, format!("lead {}", t.lead));
            }
            (n.clone(), seats.join(", "))
        })
        .collect()
}
