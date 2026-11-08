//! What a turn reports (v1 server/services/telemetry.js `trackTurns`): fixed values about how it ran and
//! ended, never the prompt or the result. The names are `PostHog`'s dashboards: keep them. The facts come in
//! as plain data, so this needs no runtime types.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::events::{Props, set_opt};

/// How the session is set up (v1 `runProps`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunFacts {
    pub agent: String,
    #[serde(default)]
    pub model: Option<String>,
    pub mode: String,
    #[serde(default)]
    pub effort: Option<String>,
    /// the turn's index in its session (0: the first)
    #[serde(default)]
    pub turn_index: usize,
    /// Auto's choice (wisp.router's `route`), when it routed the session
    #[serde(default)]
    pub route: Option<Value>,
}

/// How a turn went.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnFacts {
    /// done | error | stopped
    pub status: String,
    pub started_at: i64,
    #[serde(default)]
    pub ended_at: Option<i64>,
    #[serde(default)]
    pub attachments: usize,
    /// each block's type, and the hero's status
    #[serde(default)]
    pub blocks: Vec<BlockFact>,
    /// the agent ignored or broke the wisp protocol
    #[serde(default)]
    pub presentation_fallback: bool,
    #[serde(default)]
    pub changed_files: usize,
    #[serde(default)]
    pub input_tokens: Option<f64>,
    #[serde(default)]
    pub output_tokens: Option<f64>,
    #[serde(default)]
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlockFact {
    #[serde(rename = "type")]
    pub ty: String,
    #[serde(default)]
    pub status: Option<String>,
}

fn non_empty(s: Option<&str>) -> &str {
    s.filter(|s| !s.is_empty()).unwrap_or("default")
}

pub fn run_props(r: &RunFacts) -> Props {
    let mut p = Props::new();
    p.insert("agent".into(), json!(r.agent));
    p.insert("model".into(), json!(non_empty(r.model.as_deref())));
    p.insert("mode".into(), json!(r.mode));
    p.insert("effort".into(), json!(non_empty(r.effort.as_deref())));
    p.insert("followUp".into(), json!(r.turn_index > 0));
    p
}

/// Auto's choice, as fixed values only (never the prompt).
pub fn route_props(route: Option<&Value>) -> Props {
    let mut p = Props::new();
    let Some(r) = route.filter(|r| r.is_object()) else {
        return p;
    };
    let str_or_num = |k: &str| r.get(k).filter(|v| v.is_string() || v.is_number()).cloned();
    let truthy = |k: &str| {
        r.get(k).is_some_and(|v| {
            !matches!(v, Value::Null | Value::Bool(false)) && v != &json!(0) && v != &json!("")
        })
    };
    p.insert("routed".into(), json!(true));
    set_opt(&mut p, "routeGoal", r.get("goal").and_then(Value::as_str));
    set_opt(&mut p, "routeType", r.get("type").and_then(Value::as_str));
    set_opt(&mut p, "routeSize", str_or_num("size"));
    p.insert("routeExplored".into(), json!(truthy("explored")));
    p.insert("routeTrying".into(), json!(truthy("trying")));
    set_opt(
        &mut p,
        "routePropensity",
        r.get("propensity").filter(|v| v.is_number()).cloned(),
    );
    set_opt(&mut p, "routeTier", str_or_num("tier"));
    set_opt(&mut p, "routeTaste", str_or_num("taste"));
    p.insert("routePinned".into(), json!(truthy("pinned")));
    p.insert("routeSuggested".into(), json!(truthy("suggest")));
    p.insert(
        "routeEffort".into(),
        json!(non_empty(r.get("effort").and_then(Value::as_str))),
    );
    p
}

pub fn hero_status(t: &TurnFacts) -> Option<&str> {
    t.blocks
        .iter()
        .find(|b| b.ty == "hero")
        .and_then(|b| b.status.as_deref())
}

/// Each block type once, in first-seen order.
pub fn block_types(t: &TurnFacts) -> Vec<&str> {
    let mut out: Vec<&str> = Vec::new();
    for b in &t.blocks {
        if !out.contains(&b.ty.as_str()) {
            out.push(&b.ty);
        }
    }
    out
}

pub fn started_props(r: &RunFacts, t: &TurnFacts) -> Props {
    let mut p = run_props(r);
    p.insert("attachments".into(), json!(t.attachments));
    p
}

pub fn ended_props(r: &RunFacts, t: &TurnFacts, interrupted: bool) -> Props {
    let mut p = run_props(r);
    p.extend(route_props(r.route.as_ref()));
    p.insert(
        "status".into(),
        json!(if interrupted {
            "interrupted"
        } else {
            t.status.as_str()
        }),
    );
    set_opt(&mut p, "heroStatus", hero_status(t));
    set_opt(&mut p, "durationMs", t.ended_at.map(|e| e - t.started_at));
    p.insert("blockCount".into(), json!(t.blocks.len()));
    p.insert("blockTypes".into(), json!(block_types(t)));
    p.insert(
        "presentationFallback".into(),
        json!(t.presentation_fallback),
    );
    p.insert("changedFiles".into(), json!(t.changed_files));
    set_opt(&mut p, "inputTokens", t.input_tokens);
    set_opt(&mut p, "outputTokens", t.output_tokens);
    set_opt(&mut p, "costUsd", t.cost_usd);
    p
}

/// An agent's error reported as an exception: `type: AgentError` with the run's props.
pub fn agent_error_props(r: &RunFacts) -> Props {
    let mut p = Props::new();
    p.insert("type".into(), json!("AgentError"));
    p.extend(run_props(r));
    p
}

/// `app_started`: which harnesses are installed, and their versions (`<id>Version`).
pub fn app_started_props(agents: &[(String, Option<String>)]) -> Props {
    let mut p = Props::new();
    p.insert(
        "agentsInstalled".into(),
        json!(agents.iter().map(|(id, _)| id).collect::<Vec<_>>()),
    );
    for (id, v) in agents {
        set_opt(&mut p, &format!("{id}Version"), v.as_deref());
    }
    p
}
