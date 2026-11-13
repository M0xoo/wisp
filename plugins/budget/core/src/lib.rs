//! wisp.budget pure logic (v1 server/budget.js, web/js/receipt.js, web/js/compare-metrics.js): usage
//! windows, Automations stop at, banked (early) resets, where the plan went, Drain watch, window
//! changes, the before:run guard's decision and compare metrics. Sans-IO: time comes in as `now`
//! (ms since the epoch); no tokio, fs, net or clock.

pub mod accounts;
pub mod ask;
pub mod compare;
pub mod drain;
pub mod ledger;
pub mod limits;
pub mod model;
pub mod plan_shares;
pub mod receipt;
pub mod shape;
pub mod state;
pub mod views;
pub mod where_went;
pub mod windows;
pub mod work;

pub use model::{Budget, Recorded};

use wisp_budget_api::{PlanHold, RunSubject};

/// The crate's one error.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}: not a usage report")]
    BadReport(String),
}

/// The before:run guard's decision (plan §6.11.3; v1 services/launch.js:150-153, later.js:420): only
/// unattended work is held; the user's own run or follow-up never is, and it isn't even read for.
/// `hold_of(agent, account)` is the hold on that account, if any.
pub fn decide(subject: &RunSubject, hold_of: impl FnOnce(&str, &str) -> Option<PlanHold>) -> Option<PlanHold> {
    if subject.attended || subject.agent.is_empty() {
        return None;
    }
    hold_of(&subject.agent, &subject.account)
}

/// Who a run is for, from what `before:run` says of it: `by` names the starter (`crew`, `trigger`,
/// `goal`, `agent`…); anything else, or nothing, is someone at the keyboard.
pub fn subject_of(agent: &str, account: Option<&str>, by: Option<&str>) -> RunSubject {
    RunSubject {
        agent: agent.to_owned(),
        account: account.unwrap_or_default().to_owned(),
        attended: !windows::unattended(by),
        by: by.map(str::to_owned),
    }
}
