//! wisp.budget's events (besides [`crate::PlanFree`], in the shared contract).

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use wisp_kernel::Event;

use crate::model::{Drain, Share};

/// `budget.reset`: windows of `agent@account` reset before their time (a banked reset), once per
/// period. `free`: no window holds the account now (no stop line crossed, none full).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "budget/")]
pub struct Reset {
    pub agent: String,
    pub account: String,
    pub ids: Vec<String>,
    pub free: bool,
}

impl Event for Reset {
    const TYPE: &'static str = "budget.reset";
}

/// `budget.drain`: Drain watch on, a run ended while the account drains. At most once per window per
/// two hours; `title` and `text` are the phone's words.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "budget/")]
pub struct DrainNoted {
    pub agent: String,
    pub account: String,
    pub drain: Drain,
    pub title: String,
    pub text: String,
}

impl Event for DrainNoted {
    const TYPE: &'static str = "budget.drain";
}

/// `budget.share`: a turn's part of a window's move (v1 `onShare`, kept on the turn as `turn.plan`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "budget/")]
pub struct ShareAdded {
    pub session_id: String,
    pub turn_id: String,
    pub share: Share,
}

impl Event for ShareAdded {
    const TYPE: &'static str = "budget.share";
}

/// `budget.changed`: a number the page shows moved for `agent` (v1 broadcast `agents`, coalesced).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "budget/")]
pub struct Changed {
    pub agent: String,
}

impl Event for Changed {
    const TYPE: &'static str = "budget.changed";
}
