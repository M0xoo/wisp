//! The normalised events every harness parser emits: v1 `server/adapters/index.js`, field for field and
//! name for name, so the G6 goldens (v1's own output) compare like with like. `wisp-runtime-api`'s
//! `HarnessEvent` is the contract the runtime reads; the host crates map this one onto it.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// A coarse kind for the trail summary (v1 `{ type: 'tool', kind }`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolKind {
    Read,
    Edit,
    Run,
    Search,
    Web,
    Agent,
    Plan,
    Tool,
    Wait,
    Ask,
    Answer,
    Background,
}

/// A tool call, in words: the live ticker's sentence (`label`) and what it touches.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Tool {
    pub kind: ToolKind,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// the harness's call id, for a later `tool_output`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// what it returned, for harnesses that report calls once run
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
}

impl Tool {
    pub fn new(kind: ToolKind, label: impl Into<String>) -> Self {
        Self {
            kind,
            label: label.into(),
            file: None,
            detail: None,
            id: None,
            output: None,
        }
    }
    #[must_use]
    pub fn file(mut self, f: impl Into<String>) -> Self {
        self.file = Some(f.into());
        self
    }
    #[must_use]
    pub fn detail(mut self, d: impl Into<String>) -> Self {
        self.detail = Some(d.into());
        self
    }
    #[must_use]
    pub fn id(mut self, id: impl Into<String>) -> Self {
        self.id = Some(id.into());
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Edit {
    pub before: String,
    pub after: String,
}

/// A file the agent changed. `op`: v1's `create | write | edit` (and `delete`, `rename` from harnesses
/// that report them). `before_file`: `Some(None)` is v1's `beforeFile: null` (a new file).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Change {
    pub file: String,
    pub op: String,
    pub edits: Vec<Edit>,
    /// streamed before the call ran (from its input), not observed after it
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub early: Option<bool>,
    #[serde(
        rename = "beforeFile",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub before_file: Option<Option<String>>,
}

/// One usage window (v1 budget.js): how much is gone, when it resets (ms), how long it is (ms).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LimitWindow {
    pub id: String,
    pub used: f64,
    #[serde(rename = "resetsAt")]
    pub resets_at: Option<f64>,
    pub ms: Option<f64>,
    /// a harness's own keys (Codex: `credits`, `plan`)
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Limits {
    pub windows: Vec<LimitWindow>,
    /// every window the plan has (a window change), not just the one this event names
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub complete: Option<bool>,
    /// v1: `true` or the window's id
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rejected: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overage: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credits: Option<f64>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BillingKind {
    Api,
    Profile,
}

/// v1's result stats, by v1's names. Harness-specific keys (`totals`, `models`, `subagents`, `compact`,
/// `contextTokens`, `cacheTtlMs`, `baseline`) live in `extra`, as v1 put them on the same object.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turns: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_tokens: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write_tokens: Option<Value>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// The turn's end: exactly once per turn (a process that keeps background tasks reports several).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnResult {
    pub text: String,
    pub is_error: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stopped: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stats: Option<Box<Stats>>,
    /// the CLI said it is signed out: the turn shows a sign-in card
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_failed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    /// background tasks left running (> 0: another result follows)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<u64>,
}

impl TurnResult {
    /// v1's `{ type: 'result', isError: true, text }`
    pub fn error(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            is_error: true,
            ..Self::default()
        }
    }
}

/// What a harness reports, in order (v1 `onEvent`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HarnessEvent {
    /// the agent-side session id, to resume follow-ups
    Session {
        id: String,
    },
    Tool(Tool),
    ToolOutput {
        id: String,
        text: String,
    },
    ToolError {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    Text {
        text: String,
    },
    Thinking {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<String>,
    },
    Change(Change),
    /// a call its permissions refused; `rule` allows exactly that on a retry
    Blocked {
        tool: String,
        detail: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        rule: Option<String>,
    },
    Limits(Limits),
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        models: Option<Map<String, Value>>,
    },
    /// background tasks still running
    Background {
        tasks: Vec<String>,
    },
    Result(TurnResult),
}

impl HarnessEvent {
    pub fn session(id: impl Into<String>) -> Self {
        Self::Session { id: id.into() }
    }
    pub fn text(text: impl Into<String>) -> Self {
        Self::Text { text: text.into() }
    }
    /// The v1 JSON of this event (what the goldens hold).
    pub fn to_json(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}
