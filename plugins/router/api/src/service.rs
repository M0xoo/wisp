//! `router.service@1`: Auto for other plugins. The runtime asks it to pick a harness · model · level
//! when a task runs on `agent: "auto"` (and for a hand-over or a move at a limit), to tell whether a
//! run's error is a limit, and reports what happened afterwards so the router learns.
//!
//! `pick` and `classify` only read (safe inside an interceptor); `report` writes.

use serde::{Deserialize, Serialize};
use wisp_kernel::{Call, Result, Service};

use crate::types::{
    AgentInfo, ChooseArgs, Limit, Pick, Route, Signals, StoredRoute, SummaryLike, Window,
};

/// The permission `pick` and `classify` require.
pub const PERM_READ: &str = "router:read";
/// The permission `report` requires.
pub const PERM_WRITE: &str = "router:write";

/// A pick: v1 `choose()`'s options, plus a hand-over's level-up.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PickRequest {
    #[serde(flatten)]
    pub choose: ChooseArgs,
    /// A hand-over: try this route's model a level up first (low or medium → high, high → xhigh;
    /// v1 Router.levelUp), and pick with `choose` when there's none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level_up: Option<Route>,
}

/// A run's error, to tell a limit from the model failing.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RunError {
    /// the error text the harness gave
    pub text: String,
    /// the harness id (`codex`: a 429 with plan left is a blip)
    pub agent: String,
    /// the account's usage windows as the run ended (wisp.budget); never another account's
    pub windows: Vec<Window>,
    /// the user's offset from UTC in minutes, to read "resets 9pm"; absent: UTC
    #[serde(skip_serializing_if = "Option::is_none")]
    pub utc_offset_min: Option<i32>,
}

/// What happened, for the router to learn from (v1 index.js:315-330, services/auto.js signals,
/// pipeline.js moveOn, feedback.js, sessions.js rollback).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Outcome {
    /// A launch went out with Auto's route.
    Launched { id: String, route: StoredRoute },
    /// A launch you picked yourself (a top-level task): your taste, and a half-weight record.
    Manual {
        id: String,
        agent: String,
        #[serde(default)]
        model: String,
        #[serde(default)]
        effort: String,
        #[serde(default)]
        prompt: String,
        #[serde(default)]
        attachments: u32,
    },
    /// A turn ended. `first`: the task's first turn; `limited`: it stopped at a usage limit (not the
    /// model's fault, nothing counted).
    TurnEnded {
        id: String,
        #[serde(default)]
        first: bool,
        #[serde(default)]
        error: bool,
        #[serde(default)]
        limited: bool,
        #[serde(default)]
        interrupted: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cost_usd: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ms: Option<f64>,
    },
    /// A task's list row changed: its outcome so far (hero, follow-ups, PR, switched).
    Summary { summary: SummaryLike },
    /// Any other signal (👍/👎, rollback, the best-of-2 judge's pick, a test check).
    Signal { id: String, signals: Signals },
    /// The run hit a limit: the harness (or the model) cools and the run is voided.
    Limited {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        key: String,
        limit: Limit,
        #[serde(default)]
        why: String,
    },
    /// You picked a harness yourself after Auto's preview showed `auto`.
    Override {
        #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
        kind: Option<String>,
        auto: String,
        chose: String,
        #[serde(default)]
        prompt: String,
    },
    /// The harnesses detected somewhere. `more`: a machine's, on top of this computer's (none of
    /// this computer's is marked gone).
    Agents {
        agents: Vec<AgentInfo>,
        #[serde(default)]
        more: bool,
    },
}

/// Every method starts with `call.require(PERM_READ | PERM_WRITE)?`.
pub trait RouterApi: Send + Sync + 'static {
    /// A harness · model · level for a task; `None` when nothing allowed can run now.
    fn pick(&self, call: &Call, req: PickRequest) -> Result<Option<Pick>>;
    /// `Some` when the error is a usage, rate, device or capacity limit, with how long to cool.
    fn classify(&self, call: &Call, err: &RunError) -> Result<Option<Limit>>;
    fn report(&self, call: &Call, outcome: Outcome) -> Result<()>;
}

/// `router.service@1`, requested by contract (plan §6.11.1).
#[derive(Debug)]
pub struct RouterService;

impl Service for RouterService {
    const ID: &'static str = "router.service";
    const MAJOR: u32 = 1;
    type Api = dyn RouterApi;
}
