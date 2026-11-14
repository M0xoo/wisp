//! A run a trigger started that waits for its plan (Automations stop at, wisp.budget's `before:run` hold; v1
//! triggers.js `t.held`): the row says so, with why, until the plan frees (`budget.plan_free`, v1 `release(agent)`),
//! or the run ends. The next event runs as usual and meets the plan's check again.

use serde::{Deserialize, Serialize};

use crate::engine::State;

/// What a trigger's row says while its run waits for the plan.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanWait {
    pub at: i64,
    /// the run (task id) that waits
    pub session: String,
    pub agent: String,
    /// the account id, `default` for the harness's own login
    pub account: String,
    pub why: String,
}

/// `default` for the harness's own login, as wisp.budget names it.
fn account_of(a: &str) -> &str {
    if a.is_empty() { "default" } else { a }
}

/// The run `w.session` waits for its plan: the row says so (and its log), if it is one of this trigger's runs.
pub fn held(st: &mut State, mut w: PlanWait) -> bool {
    if !st.running.contains(&w.session) {
        return false;
    }
    if w.account.is_empty() {
        "default".clone_into(&mut w.account);
    }
    st.log(w.at, "held", &w.why, "", Some(w.session.clone()));
    st.plan = Some(w);
    true
}

/// `agent@account`'s plan is free: a row that waited for it stops saying so. An empty account is every account of
/// `agent` (v1 `release(agent)`). Whether it waited.
pub fn release(st: &mut State, agent: &str, account: &str) -> bool {
    let hit = st.plan.as_ref().is_some_and(|w| w.agent == agent && (account.is_empty() || w.account == account_of(account)));
    if hit {
        st.plan = None;
    }
    hit
}

/// The run ended (it started after all, or was stopped): nothing waits any more.
pub fn ended(st: &mut State, session: &str) {
    if st.plan.as_ref().is_some_and(|w| w.session == session) {
        st.plan = None;
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn wait(session: &str, account: &str) -> PlanWait {
        PlanWait { at: 5, session: session.into(), agent: "codex".into(), account: account.into(), why: "past 75%".into() }
    }

    #[test]
    fn only_its_own_run_marks_a_row_and_the_log_says_held() {
        let mut st = State { running: vec!["t1".into()], ..State::default() };
        assert!(!held(&mut st, wait("t9", "")), "another trigger's run");
        assert!(st.plan.is_none());
        assert!(held(&mut st, wait("t1", "")));
        assert_eq!(st.plan.as_ref().unwrap().account, "default", "the CLI's own login is `default`, as budget says");
        assert_eq!(st.deliveries.back().map(|d| d.result.as_str()), Some("held"));
    }

    #[test]
    fn the_plan_freeing_releases_that_account_only_and_an_empty_account_releases_them_all() {
        let mut st = State { running: vec!["t1".into()], ..State::default() };
        held(&mut st, wait("t1", "work"));
        assert!(!release(&mut st, "claude", "work"), "another harness");
        assert!(!release(&mut st, "codex", "default"), "another account");
        assert!(release(&mut st, "codex", "work"));
        assert!(st.plan.is_none());
        held(&mut st, wait("t1", "work"));
        assert!(release(&mut st, "codex", ""), "v1 release(agent): every account");
    }

    #[test]
    fn the_run_ending_clears_it() {
        let mut st = State { running: vec!["t1".into()], ..State::default() };
        held(&mut st, wait("t1", ""));
        ended(&mut st, "t2");
        assert!(st.plan.is_some());
        ended(&mut st, "t1");
        assert!(st.plan.is_none());
    }
}
