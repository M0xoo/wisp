//! The shapes of wisp.router's contract, v1's names kept (server/router.js, services/auto.js).

use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};
use ts_rs::TS;

/// `Option<Option<T>>` from JSON: absent is `None`, `null` is `Some(None)` (it clears or overrides).
pub mod nullable {
    use super::{Deserialize, Deserializer};
    pub fn deserialize<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
        d: D,
    ) -> Result<Option<Option<T>>, D::Error> {
        Option::<T>::deserialize(d).map(Some)
    }
}

/// A harness as Auto sees it (v1 listAgents()): this computer's, or a machine's.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "router/")]
pub struct AgentInfo {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub available: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(optional)]
    pub models: Vec<ModelInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub efforts: Option<Vec<String>>,
    /// can lead a team of subagents (it takes wisp's MCP server); absent means it can
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub delegates: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub signed_in: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub version: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "router/")]
pub struct ModelInfo {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub label: Option<String>,
    /// `Some([])`: the level is in the id (gemini-4-argon-high); `None`: the harness's levels
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub efforts: Option<Vec<String>>,
}

/// Another arm a pick weighed.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "router/")]
pub struct RouteAlt {
    pub key: String,
    pub agent: String,
    pub model: String,
    pub effort: String,
    pub label: String,
    pub chance: f64,
    pub usd: f64,
}

/// A better arm on the record than your habit: offered, not run.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "router/")]
pub struct Suggest {
    #[serde(flatten)]
    pub alt: RouteAlt,
    pub trying: bool,
    pub why: String,
}

/// How Auto picked a run: what the task's card shows and what the router learns from.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(export, export_to = "router/")]
pub struct Route {
    pub goal: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub size: String,
    pub key: String,
    pub effort: String,
    pub label: String,
    pub chance: f64,
    pub n: u32,
    pub usd: f64,
    pub minutes: f64,
    pub explored: bool,
    pub trying: bool,
    pub tier: u8,
    pub taste: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub pinned: Option<bool>,
    pub why: String,
    /// how likely this pick was (the router's own choices can be corrected for later)
    pub propensity: f64,
    pub alternatives: Vec<RouteAlt>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub suggest: Option<Suggest>,
    #[ts(type = "number")]
    pub at: i64,
    /// the user moved the task to another harness or model in a follow-up
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub switched: Option<bool>,
    /// the pipeline handed it over
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub escalated: Option<bool>,
    /// the pipeline moved it on at a limit
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub moved: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "router/")]
pub struct Pick {
    pub agent: String,
    pub model: String,
    pub effort: String,
    pub key: String,
    pub label: String,
    pub route: Route,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "router/")]
pub enum Hero {
    Done,
    Partial,
    Blocked,
    Info,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "router/")]
pub enum Feedback {
    Up,
    Down,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "router/")]
pub enum Check {
    Pass,
    Fail,
    Error,
}

/// What happened to a routed task. A patch merges into what is stored; a later, stronger signal then
/// replaces an earlier one in the reward. `null` (feedback, rolledBack) clears a signal.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(export, export_to = "router/")]
pub struct Signals {
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub hero: Option<Hero>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<bool>,
    /// follow-ups after the first turn: corrections
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub followups: Option<u32>,
    #[serde(
        deserialize_with = "nullable::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional, type = "Feedback | null")]
    pub feedback: Option<Option<Feedback>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub merged: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub closed: Option<bool>,
    /// null: a rollback restored
    #[serde(
        deserialize_with = "nullable::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional, type = "boolean | null")]
    pub rolled_back: Option<Option<bool>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub switched: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub switched_to: Option<String>,
    /// wisp's own test run
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub check: Option<Check>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub repaired: Option<bool>,
    /// best-of-2: whether the judge picked this run
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub picked: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cost_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub ms: Option<f64>,
}

impl Signals {
    /// v1 `Object.assign(route.signals, patch)` without the undefined fields.
    pub fn merge(&mut self, p: &Signals) {
        macro_rules! take {
            ($($f:ident),*) => { $(if p.$f.is_some() { self.$f.clone_from(&p.$f); })* };
        }
        take!(
            hero,
            error,
            followups,
            feedback,
            merged,
            closed,
            rolled_back,
            switched,
            switched_to,
            check,
            repaired,
            picked,
            cost_usd,
            ms
        );
    }
}

/// A route as the router keeps it per session: the pick, what happened since, and its reward.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "router/")]
pub struct StoredRoute {
    pub key: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub goal: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub chance: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub explored: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub trying: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub why: Option<String>,
    /// a run you picked yourself: it teaches the record at half weight
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(optional)]
    pub manual: bool,
    #[serde(default)]
    #[ts(type = "number")]
    pub at: i64,
    #[serde(default)]
    pub signals: Signals,
    /// the reward counted so far; null while nothing says how it went
    #[serde(default)]
    pub r: Option<f64>,
    /// the run never got to work (the harness was at its limit)
    #[serde(default, rename = "void", skip_serializing_if = "std::ops::Not::not")]
    #[ts(optional)]
    pub voided: bool,
    /// the rest of the route as the caller recorded it (size, tier, alternatives, …)
    #[serde(flatten)]
    #[ts(skip)]
    pub rest: Map<String, Value>,
}

impl StoredRoute {
    /// A full route as recorded at launch: its signals and reward start empty.
    pub fn from_route(route: &Route) -> Self {
        let mut s = serde_json::to_value(route)
            .ok()
            .and_then(|v| serde_json::from_value::<StoredRoute>(v).ok())
            .unwrap_or_default();
        s.signals = Signals::default();
        s.r = None;
        s
    }
}

/// `scope`: the whole harness (a usage window) or one model at every level (a rate limit).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "router/")]
pub enum LimitScope {
    Agent,
    Arm,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "router/")]
pub enum LimitKind {
    /// too many devices or sessions signed in: nothing to wait for
    Device,
    /// the provider has no room for that model right now
    Capacity,
}

/// An error that says the harness can't run right now, not that the model got the task wrong.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "router/")]
pub struct Limit {
    pub scope: LimitScope,
    /// how long it cools
    #[ts(type = "number")]
    pub ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub kind: Option<LimitKind>,
    /// a Codex 429 while its plan has room: a short pause
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub blip: Option<bool>,
}

/// A usage window of the account a run used, as the budget last read it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "router/")]
pub struct Window {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub id: Option<String>,
    /// share used, 0..=1; absent: unknown
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub used: Option<f64>,
}

/// The scout's verdict on a task, which beats the keyword guess.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "router/")]
pub struct Scouted {
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub size: Option<String>,
}

/// v1 Router.choose's options, by the same names; anything left out comes from Settings → Auto.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(export, export_to = "router/")]
pub struct ChooseArgs {
    pub prompt: String,
    pub attachments: u32,
    /// the harnesses of the place it runs; absent: this computer's
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub agents: Option<Vec<AgentInfo>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub goal: Option<String>,
    /// no exploring: the best on the record
    pub important: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub explore: Option<bool>,
    /// arm keys already taken (compare, hand-overs): every level of that harness · model is out
    pub exclude: Vec<String>,
    /// the lead of a team must be a harness that can delegate
    pub need_delegate: bool,
    /// absent: Settings; null: any harness
    #[serde(
        deserialize_with = "nullable::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional, type = "Array<string> | null")]
    pub allowed: Option<Option<Vec<String>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub blocked: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub prefer: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub habits: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub scouted: Option<Scouted>,
    /// only arms at least this strong (a hand-over steps up)
    pub min_tier: u8,
    /// the pick to show before sending: no dice
    pub preview: bool,
    /// the preview you saw, kept if it can still run
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub pin: Option<String>,
    /// a seed for the draw (tests, benches); absent: the host's
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub seed: Option<u64>,
}

/// The fields of a task's list row the router reads (v2 Summary, or a peer's mirrored row).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(export, export_to = "router/")]
pub struct SummaryLike {
    pub id: String,
    #[ts(optional)]
    pub status: Option<String>,
    #[ts(optional)]
    pub state: Option<String>,
    #[ts(optional)]
    pub turn_count: Option<u32>,
    #[ts(optional)]
    pub followups: Option<u32>,
    #[ts(optional)]
    pub agent: Option<String>,
    #[ts(optional)]
    pub model: Option<String>,
    #[ts(optional)]
    pub effort: Option<String>,
    /// `{state: "MERGED" | "CLOSED" | …}`
    #[ts(optional, type = "{ state?: string } | null")]
    pub pr: Option<Value>,
    /// `{switched: true}` once the user moved the task to another harness or model
    #[ts(optional, type = "{ switched?: boolean } | null")]
    pub route: Option<Value>,
}

/// An arm that showed up since the last look (on probation unless the benchmarks know it).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "router/")]
pub struct Added {
    pub key: String,
    pub label: String,
    pub state: String,
}

/// Benchmark sources the priors came from.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "router/")]
pub struct PriorSource {
    pub name: String,
    pub url: String,
    pub date: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "router/")]
pub struct PriorInfo {
    pub version: String,
    pub source: String,
    pub sources: BTreeMap<String, PriorSource>,
}
