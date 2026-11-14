//! What budget knows of each account (v1 ~/.wisp/budget.json, budget.js:9-14), field for field, so
//! the v1 importer maps it 1:1. One [`Acc`] per agent@account; `default` is the CLI's own login.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use wisp_budget_api::{Banked, NoticeKind, OverageKind, Period};

/// A window as last reported.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Win {
    pub used: f64,
    pub resets_at: Option<i64>,
    pub ms: Option<i64>,
}

/// What wisp last saw of a window (window changes), so a restart doesn't announce anything again.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Seen {
    pub ms: Option<i64>,
    pub resets_at: Option<i64>,
    pub slot: Option<String>,
    pub at: i64,
    pub miss: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Shape {
    pub since: i64,
    /// reports seen, capped at 2: it only ever says whether this is the first
    pub n: u32,
    pub windows: BTreeMap<String, Seen>,
}

/// A window change, as stored (the view adds its labels).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoticeRow {
    pub window: String,
    pub kind: NoticeKind,
    pub at: i64,
    pub ms: Option<i64>,
    pub resets_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub was_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub was_window: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub was_resets_at: Option<i64>,
}

/// One run's sample for Drain watch.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrainSample {
    pub at: i64,
    pub du: f64,
    pub units: f64,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub failed: bool,
}

/// A run billed past the plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Over {
    pub at: i64,
    pub kind: OverageKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tid: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct Learn {
    pub du: f64,
    pub units: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ack {
    pub resets_at: Option<i64>,
    pub line: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Early {
    pub at: i64,
    pub resets_at: Option<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Acc {
    #[serde(default)]
    pub windows: BTreeMap<String, Win>,
    /// the latest reading
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<i64>,
    /// Ask near the limit: how far each window moved while wisp's runs worked, against their units
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub learn: BTreeMap<String, Learn>,
    /// what moved during the run going on now, until `spend`
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub run: BTreeMap<String, f64>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub acks: BTreeMap<String, Ack>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub periods: BTreeMap<String, Vec<Period>>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub drain: BTreeMap<String, Vec<DrainSample>>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub drain_seen: BTreeMap<String, i64>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub early: BTreeMap<String, Early>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shape: Option<Shape>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub notices: BTreeMap<String, NoticeRow>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub over: Vec<Over>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub banked: Option<Banked>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub banked_sent: BTreeMap<String, i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credits: Option<f64>,
    /// each window's traced shares by task this period (where it went)
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub traced: BTreeMap<String, crate::traced::Traced>,
    /// the last 7 days of finished turns' tokens (tokens per turn by account)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub turns: Vec<crate::traced::TurnSample>,
}

/// `agent@account`, the ledger's and the store's key.
pub fn acc_key(agent: &str, account: &str) -> String {
    format!("{agent}@{}", account_or_default(account))
}

/// v1 `account || 'default'`.
pub fn account_or_default(account: &str) -> &str {
    if account.is_empty() { "default" } else { account }
}
