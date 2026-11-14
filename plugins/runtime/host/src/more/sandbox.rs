//! Subagents whose place is a sandbox (ADR-0047): their task there, routed through `machines.route`,
//! and their report read back, with their changes brought into the lead's folder once.

use std::sync::Arc;

use serde_json::{Value, json};
use wisp_runtime_api::SessionId;
use wisp_runtime_api::commands::Report;
use wisp_runtime_api::model::{Session, SessionState};

use super::{push, slot, str_at, with_slot};
use crate::error::{Result, RuntimeError};
use crate::runtime::Runtime;

impl Runtime {
    /// A member whose place is a sandbox: its sandbox (made once, the lead's work in it), and its task there, new or
    /// followed up. → `<machine>|<task>`.
    pub(super) async fn sandbox_member(
        self: &Arc<Self>,
        lead: &Session,
        m: &Value,
        slot_name: &str,
        existing: Option<String>,
        prompt: &str,
    ) -> Result<String> {
        let wire = |e: wisp_kernel::WireError| RuntimeError::Invalid(e.message);
        // a capped lead's work stays on this computer, under its cap (crew refuses a member elsewhere the same way)
        if crate::capped::cap_of(lead).is_some() {
            return Err(RuntimeError::Wire(wisp_kernel::WireError::forbidden(wisp_kernel::caps::capped_refusal("start a sandbox"))));
        }
        if let Some((machine, id)) = existing.as_deref().and_then(|k| k.split_once('|')) {
            self.route(machine, "runtime.followUp", json!({ "id": id, "text": prompt, "queue": true })).await.map_err(wire)?;
            return Ok(format!("{machine}|{id}"));
        }
        let place = wisp_sandbox_api::PlaceArgs { owner: json!({ "lead": lead.id.0, "member": slot_name }), cwd: Some(lead.cwd.clone()) };
        let placed = crate::calls::run::<wisp_sandbox_api::Place>(&*self.host, place).await.map_err(wire)?;
        let machine = placed.machine;
        let mut args = json!({ "prompt": prompt, "cwd": placed.cwd, "mode": lead.mode, "title": format!("{slot_name} · {}", lead.title) });
        for k in ["agent", "model", "effort"] {
            let v = str_at(m, k);
            if !v.is_empty() {
                args[k] = json!(v);
            }
        }
        let made = self.route(&machine, "runtime.create", args).await.map_err(wire)?;
        Ok(format!("{machine}|{}", str_at(&made, "id")))
    }

    /// Runtime command `cmd` on sandbox `machine` (`machines.route`, typed; the routed command stays by name: it is
    /// this plugin's own, run by the wisp over there).
    async fn route(&self, machine: &str, cmd: &str, args: Value) -> wisp_kernel::Result<Value> {
        let a = wisp_machines_api::RouteArgs {
            id: Some(machine.to_owned()),
            cmd: cmd.to_owned(),
            args,
            mid: format!("dlg-{}", wisp_kernel::ids::uuid7()),
        };
        crate::calls::run::<wisp_machines_api::Route>(&*self.host, a).await
    }

    /// A sandbox member's report, read there; once it's done, its changes come into the lead's folder (once).
    pub(super) async fn sandbox_report(self: &Arc<Self>, lead: &Session, key: &str) -> Option<Report> {
        self.remote_report(lead, key, true).await
    }

    /// A task's report on another machine (`<machine>|<id>`); `bring`: once it's done, its changes come into the
    /// lead's folder (once), as a sandbox member's do.
    pub(super) async fn remote_report(self: &Arc<Self>, lead: &Session, key: &str, bring: bool) -> Option<Report> {
        let (machine, id) = key.split_once('|')?;
        let route = |cmd: &'static str, args: Value| self.route(machine, cmd, args);
        let s = route("runtime.get", json!({ "id": id })).await.ok()?;
        let state: SessionState = serde_json::from_value(s.get("state").cloned().unwrap_or_default()).unwrap_or(SessionState::Running);
        let done = state != SessionState::Running;
        let turns = route("runtime.turns", json!({ "id": id })).await.ok().unwrap_or_default();
        let last = turns.as_array().and_then(|t| t.last()).cloned().unwrap_or_default();
        let mut text = str_at(&last, "text");
        let brought =
            slot(lead).and_then(|m| m.get("brought")).and_then(Value::as_array).is_some_and(|b| b.iter().any(|x| x.as_str() == Some(key)));
        if bring && done && !brought {
            let bring = wisp_sandbox_api::BringArgs { machine: machine.to_owned(), from: str_at(&s, "cwd"), into: lead.cwd.clone() };
            let note = match crate::calls::run::<wisp_sandbox_api::Bring>(&*self.host, bring).await {
                Ok(wisp_sandbox_api::Brought { error: Some(e), .. }) => format!("\n\n(Its changes didn't come back: {e})"),
                Ok(b) if b.files > 0 => format!("\n\n(Its changes to {} file(s) are in your folder now.)", b.files),
                Ok(_) => String::new(),
                Err(e) => format!("\n\n(Its changes didn't come back: {})", e.message),
            };
            text.push_str(&note);
            let _g = self.task_lock(lead.id.as_str()).await;
            if let Ok(mut l) = self.repo.session(lead.id.as_str()).await {
                with_slot(&mut l.ext, |x| push(x, "brought", json!(key)));
                if let Err(err) = self.persist(&mut l, Vec::new()).await {
                    tracing::warn!(error = %err, task = lead.id.as_str(), "runtime: a sandbox member's changes, marked brought");
                }
            }
        }
        let cost = last.pointer("/stats/costUsd").and_then(Value::as_f64);
        Some(Report {
            id: SessionId(key.to_owned()),
            subagent: str_at(&s, "title").split(" · ").next().unwrap_or_default().to_owned(),
            state,
            done,
            text,
            cost_usd: cost,
        })
    }
}
