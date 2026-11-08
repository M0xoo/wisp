//! wisp.budget's commands. Reads are `budget:read` and read-only (allowed inside an interceptor);
//! writes are `budget:write`. Shapes are v1's request bodies (routes/meta.js).

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use wisp_kernel::Command;

use crate::model::{AccountView, BankedCredit, LimitsReport, OverageKind, Past, Share};
use crate::{PERM_READ, PERM_WRITE, PlanHold};

macro_rules! command {
    ($name:ident = $id:literal, $perm:expr, $ro:expr, $args:ty => $out:ty) => {
        #[derive(Debug)]
        pub struct $name;
        impl Command for $name {
            const ID: &'static str = $id;
            const PERMISSION: Option<&'static str> = Some($perm);
            const READ_ONLY: bool = $ro;
            type Args = $args;
            fn args_ts() -> Option<String> {
                Some(format!("{}{}", <$args as ::ts_rs::TS>::docs().unwrap_or_default(), <$args as ::ts_rs::TS>::inline(&::ts_rs::Config::default())))
            }
            type Out = $out;
        }
    };
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "budget/")]
pub struct AgentArgs {
    pub agent: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "budget/")]
pub struct AccountArgs {
    pub agent: String,
    /// empty or missing: `default` (the harness's own login)
    #[serde(default)]
    pub account: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "budget/")]
pub struct WindowArgs {
    pub agent: String,
    #[serde(default)]
    pub account: String,
    pub window: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "budget/")]
pub struct RecordArgs {
    pub agent: String,
    #[serde(default)]
    pub account: String,
    pub report: LimitsReport,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "budget/")]
pub struct RecordOut {
    pub past: Option<Past>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "budget/")]
pub struct OverageArgs {
    pub agent: String,
    #[serde(default)]
    pub account: String,
    pub kind: OverageKind,
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub turn_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "budget/")]
pub struct AckArgs {
    pub agent: String,
    #[serde(default)]
    pub account: String,
    pub window: String,
    #[serde(default)]
    #[ts(type = "number | null")]
    pub resets_at: Option<i64>,
    pub line: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "budget/")]
pub struct BankedSentArgs {
    pub agent: String,
    #[serde(default)]
    pub account: String,
    pub credit: BankedCredit,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "budget/")]
pub struct SessionArgs {
    pub session_id: String,
}

/// v1's `{ ok: true }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "budget/")]
pub struct Done {
    pub ok: bool,
}

/// One turn's shares of the windows it moved (v1 `turn.plan`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "budget/")]
pub struct TurnPlan {
    pub turn_id: String,
    pub plan: Vec<Share>,
}

command!(View = "budget.view", PERM_READ, true, AgentArgs => Vec<AccountView>);
command!(Hold = "budget.hold", PERM_READ, true, AccountArgs => Option<PlanHold>);
command!(Shares = "budget.shares", PERM_READ, true, SessionArgs => Vec<TurnPlan>);
command!(Record = "budget.record", PERM_WRITE, false, RecordArgs => RecordOut);
command!(Overage = "budget.overage", PERM_WRITE, false, OverageArgs => Done);
command!(Ack = "budget.ack", PERM_WRITE, false, AckArgs => Done);
command!(DismissDrain = "budget.dismissDrain", PERM_WRITE, false, WindowArgs => Done);
command!(DismissNotice = "budget.dismissNotice", PERM_WRITE, false, WindowArgs => Done);
command!(BankedSent = "budget.bankedSent", PERM_WRITE, false, BankedSentArgs => Done);

/// Settings → Usage → Automations stop at (v1 `defaults.autoStop`, `autoStopClaude`, `autoStopCodex`:
/// 'off' | '50' | '75' | '90', and 'same' for a harness's own), until wisp.settings owns them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "budget/")]
pub struct StopArgs {
    pub key: String,
    pub value: String,
}

command!(SetStop = "budget.setStop", PERM_WRITE, false, StopArgs => Done);
