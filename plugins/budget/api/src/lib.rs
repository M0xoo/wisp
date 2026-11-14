//! wisp.budget contract: usage windows, "Automations stop at", banked (early) resets, the before:run
//! budget guard and compare metrics.
//!
//! Other plugins (crew, later, goal, automations) hold unattended work through [`BudgetService`]:
//! a read-only question "is this account past its stop line, and until when?" ([`PlanHold`]). They
//! release held work when [`PlanFree`] says an account's plan reset early and no window still holds it.
//!
//! The section marked "shared contract" was written first so the other crew-row plugins can build
//! against it; extend it additively.

pub mod commands;
pub mod events;
pub mod model;
pub mod usage;

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use wisp_kernel::{Call, Event, Point, Result, Service};

pub use model::{
    AccountView, Banked, BankedCredit, BankedDue, Drain, DrainFailed, LimitWindow, LimitsReport, NoticeKind, OverageKind, OverageView,
    Past, Period, RunSubject, Share, WindowNotice, WindowNow, WindowView,
};
pub use usage::{AccountTurns, COMPARE_DAYS, COMPARE_MIN, ModelCompare, PlanWindow, TaskUse, WhereView};

// ---------- shared contract (crew, later, goal, automations depend on it) ----------

/// The window that holds unattended work back on an account (v1 `budget.hold`, budget.js ~456).
/// `until` is the latest reset among the windows at or past the line.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "budget/")]
pub struct PlanHold {
    /// the harness id (`claude`, `codex`)
    pub agent: String,
    /// the account id, `default` when the harness has one
    pub account: String,
    /// the window id (`five_hour`, `seven_day`, …)
    pub window: String,
    pub label: String,
    /// share of the window used, 0..=1
    pub used: f64,
    /// the stop line, 0..=1
    pub stop: f64,
    /// ms since the epoch: when every window past the line has reset
    #[ts(type = "number")]
    pub until: i64,
    /// one sentence for the user ("Claude Code is past 90% of its 5-hour window until 9:00 pm")
    #[serde(default)]
    pub why: String,
    /// true: the machine is short (memory, CPU, run slots), not the plan
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub load: bool,
}

/// Read-only budget questions, safe inside an interceptor. Every method takes `&Call` first and
/// starts with `call.require("budget:read")?`.
pub trait BudgetApi: Send + Sync + 'static {
    /// The hold on `agent`'s `account` (empty: the harness's current account), or `None`: it can run.
    fn plan_hold(&self, call: &Call, agent: &str, account: &str) -> Result<Option<PlanHold>>;
    /// When the account can run again after a limit: the latest reset among windows at 99.5%+
    /// whose reset hasn't passed (v1 `budget.resetAt`), or `None` when it doesn't know.
    fn reset_at(&self, call: &Call, agent: &str, account: &str) -> Result<Option<i64>>;

    // ---- additive (budget agent, 2026-11-08): the rest of v1's reads. Defaults answer "nothing
    // known", so a test fake that implements only the two above keeps compiling. ----

    /// The line Automations stop at draws for this harness (0..1), or `None` when it is off.
    fn stop_for(&self, call: &Call, _agent: &str) -> Result<Option<f64>> {
        call.require(PERM_READ)?;
        Ok(None)
    }
    /// An account's windows as they stand now (a passed reset reads as fresh: 0%, no time).
    fn windows(&self, call: &Call, _agent: &str, _account: &str) -> Result<Vec<WindowNow>> {
        call.require(PERM_READ)?;
        Ok(Vec::new())
    }
    /// Settings → Usage: every account of `agent` with something to show.
    fn view(&self, call: &Call, _agent: &str) -> Result<Vec<AccountView>> {
        call.require(PERM_READ)?;
        Ok(Vec::new())
    }
    /// A window's closed periods, oldest first (the allowance view).
    fn periods(&self, call: &Call, _agent: &str, _account: &str, _window: &str) -> Result<Vec<Period>> {
        call.require(PERM_READ)?;
        Ok(Vec::new())
    }
    /// When the account's windows were last read (a run's report or a live read).
    fn reading_at(&self, call: &Call, _agent: &str, _account: &str) -> Result<Option<i64>> {
        call.require(PERM_READ)?;
        Ok(None)
    }
    /// Ask near the limit: what a unit of work takes of the window, learned from runs (None: not yet).
    fn rate(&self, call: &Call, _agent: &str, _account: &str, _window: &str) -> Result<Option<f64>> {
        call.require(PERM_READ)?;
        Ok(None)
    }
    /// Ask near the limit: the line you said yes at for this window while it hasn't reset; 0 if none.
    fn acked(&self, call: &Call, _agent: &str, _account: &str, _window: &str, _resets_at: Option<i64>) -> Result<f64> {
        call.require(PERM_READ)?;
        Ok(0.0)
    }
    /// Drain watch's card for the account, or `None`.
    fn drain(&self, call: &Call, _agent: &str, _account: &str) -> Result<Option<Drain>> {
        call.require(PERM_READ)?;
        Ok(None)
    }
    /// Banked resets whose one phone note is due (the day before each expires).
    fn banked_due(&self, call: &Call, _agent: &str) -> Result<Vec<BankedDue>> {
        call.require(PERM_READ)?;
        Ok(Vec::new())
    }
}

/// `budget.service@1`, requested by contract (plan §6.11.1).
#[derive(Debug)]
pub struct BudgetService;

impl Service for BudgetService {
    const ID: &'static str = "budget.service";
    const MAJOR: u32 = 1;
    type Api = dyn BudgetApi;
}

/// The permission every [`BudgetApi`] method requires.
pub const PERM_READ: &str = "budget:read";
/// The permission budget's write commands require (record, ack, dismiss, overage).
pub const PERM_WRITE: &str = "budget:write";

/// An account's plan is free again after an early (banked) reset, and no other window still holds it
/// (v1 `app.resetEarly`, index.js ~504). Crew members and triggers skipped for it are released;
/// follow-ups held on it come due now.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "budget/")]
pub struct PlanFree {
    pub agent: String,
    pub account: String,
    /// the held runs wisp.budget itself started for it just now (Automations stop at, Ask near the limit), so the
    /// one phone note counts them with the follow-ups later brings due. Additive (2026-11-14).
    #[serde(default)]
    pub started: u32,
}

impl Event for PlanFree {
    const TYPE: &'static str = "budget.plan_free";
}

// ---------- end of the shared contract ----------

/// The plugin id (manifest `id`).
pub const PLUGIN_ID: &str = "wisp.budget";

/// The veto code of a `before:run` the budget guard refuses (plan §6.11.3).
pub const VETO_CODE: &str = "budget_hold";

/// Who started a run, as `before:run`'s `by` says it: work nobody started by hand (check-ins,
/// triggers, goal rounds, agents' own follow-ups) is what Automations stop at holds back. Anything
/// else (you, a channel message, Compact now) runs (v1 app.reserve, services/launch.js:150).
pub const UNATTENDED_BY: &[&str] = &["crew", "trigger", "automations", "agent", "goal", "review"];

/// v1 `config.defaults` keys budget reads, kept as they were (the importer maps them 1:1).
pub mod settings {
    /// 'off' | '50' | '75' | '90'
    pub const AUTO_STOP: &str = "autoStop";
    /// 'same' | 'off' | '50' | '75' | '90'
    pub const AUTO_STOP_CLAUDE: &str = "autoStopClaude";
    pub const AUTO_STOP_CODEX: &str = "autoStopCodex";
    /// 'on' | 'off' (off unless on)
    pub const DRAIN_WATCH: &str = "drainWatch";
    /// 'on' | 'off' (on unless off)
    pub const WINDOW_NOTICE: &str = "windowNotice";
}

/// Another plugin's reason to hold unattended work (wisp.machine: memory, CPU, run slots). Its hold
/// comes first (v1 `app.reserve.check`: `load.hold() || plan`) and carries `load: true`.
pub trait ReserveSource: Send + Sync + 'static {
    fn id(&self) -> &str;
    /// read-only and fast: called on every check
    fn hold(&self, agent: &str, account: &str) -> Option<PlanHold>;
}

/// `budget.reserve@1`: the list point [`ReserveSource`]s are contributed to.
pub const RESERVE: Point<dyn ReserveSource> = Point::new("budget.reserve", 1);

/// The topics budget's rows are published on: every change, and one agent's.
pub const TOPIC: &str = "budget";
pub fn agent_topic(agent: &str) -> String {
    format!("budget:{agent}")
}
