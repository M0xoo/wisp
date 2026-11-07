//! The normalised events a parser reports (v1 server/adapters/index.js `onEvent`).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;
use wisp_kernel::Result;

use crate::model::{ChangeOp, Edit, ToolKind};

// ---------- events a parser reports ----------

/// v1's file ops (`create` | `write` | `edit`) next to v2's; the runtime maps them to `ChangeOp`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HarnessChangeOp {
    Add,
    Modify,
    Delete,
    Rename,
    Create,
    Write,
    Edit,
}

impl HarnessChangeOp {
    pub fn normalised(self) -> ChangeOp {
        match self {
            Self::Add | Self::Create => ChangeOp::Add,
            Self::Modify | Self::Write | Self::Edit => ChangeOp::Modify,
            Self::Delete => ChangeOp::Delete,
            Self::Rename => ChangeOp::Rename,
        }
    }
}

/// v1's result stats, by v1's names; a harness adds its own in `extra`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessStats {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turns: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write_tokens: Option<u64>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitWindow {
    pub id: String,
    /// 0..=1 of the window used
    pub used: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ms: Option<f64>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BillingKind {
    Api,
    Profile,
}

/// Normalised events every harness emits (v1 server/adapters/index.js), field for field (camelCase on
/// the wire, `type` tag), so recorded v1 transcripts replay as goldens.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum HarnessEvent {
    /// the agent-side conversation id (resumes follow-ups)
    Session {
        id: String,
    },
    Tool {
        kind: ToolKind,
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        file: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
        /// the harness's call id, for a later `ToolOutput`
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        /// what it returned, if it reports calls once run
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output: Option<String>,
    },
    ToolOutput {
        id: String,
        text: String,
    },
    ToolError {
        #[serde(default)]
        name: String,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    /// assistant prose, the final answer included
    Text {
        text: String,
    },
    Thinking {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<String>,
    },
    Change {
        file: String,
        op: HarnessChangeOp,
        edits: Vec<Edit>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        early: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        before_file: Option<Option<String>>,
    },
    /// a call its permissions refused; `rule`: what allows exactly that on a retry
    Blocked {
        tool: String,
        detail: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        rule: Option<String>,
    },
    /// how much of the account's usage windows is gone; before `Result`
    Limits {
        windows: Vec<LimitWindow>,
        /// every window the plan has (a window change), not just the one this event names
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        complete: bool,
        /// true, or the window id that refused
        #[serde(default, skip_serializing_if = "Option::is_none")]
        rejected: Option<Value>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        overage: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        credits: Option<f64>,
        #[serde(flatten)]
        extra: BTreeMap<String, Value>,
    },
    /// billed to an API key or a Console profile, not the plan
    Billing {
        kind: BillingKind,
    },
    /// the tools this run had (built-ins and MCP)
    Tools {
        list: Vec<Value>,
    },
    /// what the CLI was this turn
    Cli {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        catalog: Option<String>,
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        models: BTreeMap<String, Value>,
    },
    /// background tasks still running: the CLI starts another turn when they finish
    Background {
        tasks: Vec<String>,
    },
    /// a live approval the harness is waiting on (`approve_tool`); answered with `ParserInput::Reply`
    Approval {
        id: String,
        tool: String,
        input: Value,
    },
    /// exactly once, at the end
    Result {
        text: String,
        is_error: bool,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        stopped: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stats: Option<HarnessStats>,
        /// the CLI said it is signed out: the turn shows a sign-in card
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        auth_failed: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stop_reason: Option<String>,
        /// background tasks left running (> 0: another result follows)
        #[serde(default, skip_serializing_if = "Option::is_none")]
        background: Option<u64>,
    },
}

impl HarnessEvent {
    pub fn is_result(&self) -> bool {
        matches!(self, Self::Result { .. })
    }

    /// From v1's event JSON (what wisp-harness-kit's `HarnessEvent::to_json` and v1's goldens hold).
    pub fn from_v1(v: Value) -> Result<Self> {
        serde_json::from_value(v)
            .map_err(|e| wisp_kernel::WireError::invalid(format!("harness event: {e}")))
    }
}

