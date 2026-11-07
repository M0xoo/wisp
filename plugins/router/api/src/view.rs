//! What Settings → Auto and the launcher read: the report, the settings, the preview (v1
//! Router.report, services/auto.js view/preview, routes/auto.js).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::types::{PriorInfo, RouteAlt, Signals, Suggest};

/// One kind of task an arm has a record on.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "router/")]
pub struct TypeRecord {
    pub n: u32,
    pub chance: f64,
}

/// One harness · model (· level) on Settings → Auto.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "router/")]
pub struct ArmReport {
    pub key: String,
    pub agent: String,
    pub model: String,
    pub effort: String,
    pub canon: String,
    pub label: String,
    pub tier: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub cooling_until: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cooling_why: Option<String>,
    /// ready | new | gone | cooling | untried
    pub state: String,
    pub chance: f64,
    pub n: u32,
    pub usd: f64,
    pub minutes: f64,
    pub prior: bool,
    pub inherited: bool,
    pub from: Vec<String>,
    pub picks: u32,
    pub blocked: bool,
    pub preferred: bool,
    pub by_type: BTreeMap<String, TypeRecord>,
}

/// A recent route Auto picked.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "router/")]
pub struct RecentRoute {
    pub id: String,
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub label: Option<String>,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub goal: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub chance: Option<f64>,
    pub r: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub explored: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub trying: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub why: Option<String>,
    #[ts(type = "number")]
    pub at: i64,
    pub signals: Signals,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "router/")]
pub struct RouterReport {
    pub priors: PriorInfo,
    /// outcomes the router has learned from
    pub learned: u32,
    /// launches Auto picked (not yours)
    pub routed: u32,
    /// your own picks, decayed
    pub picks: u32,
    /// previews you changed before sending
    pub corrections: u32,
    pub arms: Vec<ArmReport>,
    pub recent: Vec<RecentRoute>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "router/")]
pub struct GoalInfo {
    pub label: String,
    pub value: f64,
    pub hint: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "router/")]
pub enum Scout {
    Off,
    /// the cheap-model look runs for bigger tasks
    #[default]
    Big,
    All,
}

/// Settings → Auto (v1 `config.defaults.router`, and `models.auto` as `goal`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(export, export_to = "router/")]
pub struct Settings {
    /// Auto's goal; absent: balanced
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub goal: Option<String>,
    /// trying new models
    pub explore: bool,
    /// harnesses Auto may use; null or empty: every one
    pub allowed: Option<Vec<String>>,
    /// Never pick: 'claude', 'claude:sonnet', 'claude:sonnet:high', optionally '…@ui'
    pub blocked: Vec<String>,
    pub prefer: Vec<String>,
    /// start from what you pick yourself
    pub habits: bool,
    /// hand a failed run to a stronger pick
    pub escalate: bool,
    /// best of two for the Best goal
    pub best2: bool,
    pub scout: Scout,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            goal: None,
            explore: true,
            allowed: None,
            blocked: Vec::new(),
            prefer: Vec::new(),
            habits: true,
            escalate: true,
            best2: false,
            scout: Scout::Big,
        }
    }
}

/// The settings as GET /router shows them (allowed: null when it narrows nothing).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "router/")]
pub struct SettingsView {
    pub explore: bool,
    pub allowed: Option<Vec<String>>,
    pub blocked: Vec<String>,
    pub prefer: Vec<String>,
    pub habits: bool,
    pub escalate: bool,
    pub best2: bool,
    pub scout: Scout,
}

/// GET /router (v1 auto.view()).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "router/")]
pub struct RouterView {
    pub goals: BTreeMap<String, GoalInfo>,
    pub goal: String,
    pub settings: SettingsView,
    /// each project's test command (owned by the projects side; empty until it contributes them)
    #[ts(type = "Array<unknown>")]
    pub projects: Vec<Value>,
    #[serde(flatten)]
    pub report: RouterReport,
}

/// PATCH /router (v1 shape). Lists are checked by the router, with v1's messages.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(default)]
#[ts(export, export_to = "router/")]
pub struct RouterPatch {
    #[ts(optional)]
    pub goal: Option<String>,
    #[ts(optional)]
    pub explore: Option<bool>,
    /// a list of harness ids, or null for every one
    #[ts(optional, type = "Array<string> | null")]
    pub allowed: Option<Value>,
    #[ts(optional)]
    pub escalate: Option<bool>,
    #[ts(optional)]
    pub best2: Option<bool>,
    #[ts(optional)]
    pub habits: Option<bool>,
    #[ts(optional, type = "Array<string>")]
    pub blocked: Option<Value>,
    #[ts(optional, type = "Array<string>")]
    pub prefer: Option<Value>,
    #[ts(optional, type = "\"off\" | \"big\" | \"all\"")]
    pub scout: Option<Value>,
}

/// POST /router/preview: `{prompt, attachments (a count), goal, team, machine}`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(default)]
#[ts(export, export_to = "router/")]
pub struct PreviewArgs {
    #[ts(optional)]
    pub prompt: Option<String>,
    #[ts(optional)]
    pub attachments: Option<f64>,
    #[ts(optional)]
    pub goal: Option<String>,
    #[ts(optional)]
    pub team: Option<bool>,
    /// '' or absent: this computer
    #[ts(optional)]
    pub machine: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "router/")]
pub struct PickBrief {
    pub agent: String,
    pub model: String,
    pub effort: String,
    pub key: String,
    pub label: String,
}

/// What Auto would run for a prompt, before you send it: the same pick every time.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "router/")]
pub struct Preview {
    pub pick: PickBrief,
    pub goal: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub size: String,
    pub chance: f64,
    pub usd: f64,
    pub minutes: f64,
    pub tier: u8,
    pub why: String,
    pub alternatives: Vec<RouteAlt>,
    pub suggest: Option<Suggest>,
}

/// Nothing Auto may use can run: `{pick: null, why}`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "router/")]
pub struct NoPreview {
    #[ts(type = "null")]
    pub pick: Option<PickBrief>,
    pub why: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(untagged)]
#[ts(export, export_to = "router/")]
pub enum PreviewResult {
    Pick(Box<Preview>),
    Nothing(NoPreview),
}
