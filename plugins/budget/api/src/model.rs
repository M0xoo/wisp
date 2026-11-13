//! Row types: what a run reports of an account's usage windows, and what budget says back (v1
//! server/budget.js shapes, camelCase on the wire so v1 clients keep reading them).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// One window as a CLI reported it (v1 `claudeLimits`/`codexLimits` windows).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "budget/")]
pub struct LimitWindow {
    pub id: String,
    /// 0..=1
    pub used: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub resets_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub ms: Option<i64>,
    /// Codex: the slot it came in (`primary`, `secondary`): the same slot under a new id is a length change
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub slot: Option<String>,
}

/// One report: what a run (or a read) said of an account's windows.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "budget/")]
pub struct LimitsReport {
    #[serde(default)]
    pub windows: Vec<LimitWindow>,
    /// it lists every window the plan has (a window it leaves out may be gone)
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub complete: bool,
    /// the window that refused the run
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub rejected: Option<String>,
    /// this run is billed as extra usage, past the plan
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub overage: bool,
    /// Codex credits balance (billed past the plan's windows)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub credits: Option<f64>,
    /// a read (Check Codex, the read before held-back work), not a run's report
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub read: bool,
    /// banked resets, as `codex_banked` read them
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub banked: Option<Banked>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "budget/")]
pub struct BankedCredit {
    pub id: String,
    /// ms; None: it never expires
    #[ts(type = "number | null")]
    pub expires_at: Option<i64>,
}

/// Banked (early) resets of a Codex account. `credits` None: only the count is known.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "budget/")]
pub struct Banked {
    #[ts(type = "number")]
    pub count: u64,
    pub credits: Option<Vec<BankedCredit>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number | null")]
    pub at: Option<i64>,
}

/// An account's window as it stands now: a window whose reset has passed reads as fresh (0%, no time).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "budget/")]
pub struct WindowNow {
    pub id: String,
    pub label: String,
    pub used: f64,
    #[ts(type = "number | null")]
    pub resets_at: Option<i64>,
    #[ts(type = "number | null")]
    pub ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "budget/")]
pub struct WindowView {
    pub id: String,
    pub label: String,
    pub used: f64,
    #[ts(type = "number | null")]
    pub resets_at: Option<i64>,
    /// when it runs out at this pace, if before the reset
    #[ts(type = "number | null")]
    pub hit_at: Option<i64>,
    #[ts(type = "number | null")]
    pub ms: Option<i64>,
    /// it reset early (a banked reset) at this time, this period
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub early_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "budget/")]
pub struct DrainFailed {
    #[ts(type = "number")]
    pub runs: u32,
    pub du: f64,
}

/// Drain watch: a window whose last two hours of runs took twice its usual share per unit of work.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "budget/")]
pub struct Drain {
    pub id: String,
    pub label: String,
    pub ratio: f64,
    #[ts(type = "number")]
    pub since: i64,
    #[ts(type = "number")]
    pub runs: u32,
    pub units: f64,
    pub du: f64,
    pub usual: f64,
    pub failed: DrainFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "budget/")]
pub enum NoticeKind {
    New,
    Gone,
    Length,
    Reset,
}

/// Window changes: a window that appeared, went, changed length or moved its reset.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "budget/")]
pub struct WindowNotice {
    pub window: String,
    pub kind: NoticeKind,
    #[ts(type = "number")]
    pub at: i64,
    #[ts(type = "number | null")]
    pub ms: Option<i64>,
    #[ts(type = "number | null")]
    pub resets_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number | null")]
    pub was_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub was_window: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub was_resets_at: Option<i64>,
    /// filled in by the view (never stored)
    #[serde(default, skip_serializing_if = "String::is_empty")]
    #[ts(as = "Option<String>", optional)]
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub was_label: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "budget/")]
pub enum OverageKind {
    /// Claude's extra usage
    Extra,
    /// Codex credits
    Credits,
    /// an API key, not the plan
    Api,
    /// a Console sign-in
    Profile,
}

/// Past your plan: runs on this account billed beyond the plan in the last 7 days.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "budget/")]
pub struct OverageView {
    #[ts(type = "number")]
    pub runs: u32,
    #[ts(type = "number")]
    pub at: i64,
    pub kind: OverageKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sid: Option<String>,
}

/// What a report says of how the run is billed: past the plan.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "budget/")]
pub enum Past {
    Extra,
    Credits,
}

/// One account of a harness, for Settings → Usage and the harness list (v1 `Budget.view`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "budget/")]
pub struct AccountView {
    pub account: String,
    #[ts(type = "number | null")]
    pub at: Option<i64>,
    pub windows: Vec<WindowView>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub drain: Option<Drain>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<WindowNotice>>", optional)]
    pub notices: Vec<WindowNotice>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub overage: Option<OverageView>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub banked: Option<Banked>,
    /// where its longest window went this period (v1 `where`). Additive (2026-11-13).
    #[serde(default, rename = "where", skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub where_went: Option<crate::usage::WhereView>,
}

/// A window's closed period (v1 `Budget.periods`). `cut`: it ended before its reset.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "budget/")]
pub struct Period {
    #[ts(type = "number")]
    pub resets_at: i64,
    #[ts(type = "number | null")]
    pub ms: Option<i64>,
    pub used: f64,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub cut: bool,
}

/// A turn's part of a window's move (v1 `turn.plan` entries).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "budget/")]
pub struct Share {
    #[serde(default)]
    pub agent: String,
    #[serde(default)]
    pub account: String,
    pub window: String,
    pub used: f64,
    #[serde(default)]
    #[ts(type = "number | null")]
    pub resets_at: Option<i64>,
}

/// A banked credit whose one phone note is due (the day before it expires).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "budget/")]
pub struct BankedDue {
    pub account: String,
    pub credit: BankedCredit,
    #[ts(type = "number")]
    pub count: u64,
}

/// Who a `before:run` would start, as the budget guard reads it. `attended`: someone started it by
/// hand (the user's own run or follow-up), which the guard never holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "budget/")]
pub struct RunSubject {
    pub agent: String,
    /// empty: the harness's current account
    #[serde(default)]
    pub account: String,
    pub attended: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub by: Option<String>,
}
