//! What Settings → Usage → Plan budget shows past the windows (v1 budget.js `where`, `compareAccounts`): where an
//! account's longest window went this period, and each account's median turn per model.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// One task's part of a window this period (a subagent's on its lead).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "budget/")]
pub struct TaskUse {
    pub id: String,
    pub title: String,
    /// 0–1 of the window
    pub used: f64,
}

/// Where an account's longest window went this period: its top tasks, how many more, and how much wisp traced to a
/// task at all (the rest of `used` ran outside wisp, or before it measured).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "budget/")]
pub struct WhereView {
    pub window: String,
    pub label: String,
    /// how much of the window is gone now
    pub used: f64,
    pub traced: f64,
    pub tasks: Vec<TaskUse>,
    #[ts(type = "number")]
    pub more: u32,
}

/// One account's median finished turn on a model over the last [`COMPARE_DAYS`] days.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "budget/")]
pub struct AccountTurns {
    pub account: String,
    #[ts(type = "number")]
    pub turns: u32,
    /// median output tokens per turn
    #[ts(type = "number")]
    pub output: u64,
    /// median input tokens per turn, cache reads included
    #[ts(type = "number")]
    pub input: u64,
    /// share of input from the cache; None when the CLI didn't say
    pub cache: Option<f64>,
}

/// Tokens per turn by account on one model: only models two or more accounts ran [`COMPARE_MIN`] turns on.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "budget/")]
pub struct ModelCompare {
    /// '' : the harness's default model
    pub model: String,
    /// most output per turn first
    pub accounts: Vec<AccountTurns>,
}

/// v1 receipt.js: an account needs this many finished turns on a model to be compared.
pub const COMPARE_MIN: usize = 5;
/// v1 receipt.js: over this many days.
pub const COMPARE_DAYS: i64 = 7;

/// One plan window this period and each task's traced part of it, for *what ate my limits* (crew's Track record, v1
/// usage.js `crewStats` windows). Additive (2026-11-14).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "budget/")]
pub struct PlanWindow {
    pub agent: String,
    pub account: String,
    pub window: String,
    pub label: String,
    /// how much of the window is gone now, 0..=1
    pub used: f64,
    #[ts(type = "number")]
    pub resets_at: i64,
    /// when this period started (`resets_at` minus the window's length), when its length is known
    #[ts(type = "number | null")]
    pub since: Option<i64>,
    /// at this pace, when it runs out (before the reset)
    #[ts(type = "number | null")]
    pub hit_at: Option<i64>,
    /// the part of the window wisp traced to any task this period (0..=1 of the window)
    pub traced: f64,
    /// the asked-for tasks' parts of the window (0..=1 each): only the ones with a share
    pub tasks: std::collections::BTreeMap<String, f64>,
}
