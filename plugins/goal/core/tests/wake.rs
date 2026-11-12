//! v1 #775: a goal is checked only once its agent is done, not while it waits for its own wake-up.
#![allow(clippy::unwrap_used)]

use wisp_goal_core::{Scheduled, WakeGone, wake_gone, waits_for_wake};

fn entry(id: &str, by: &str, remind: bool, set_at: i64) -> Scheduled {
    Scheduled { id: id.into(), by: by.into(), remind, set_at }
}

#[test]
fn a_goal_waits_for_the_wake_up_its_agent_set_this_turn_and_nothing_else() {
    // the agent's own resume_later, set during this turn (started at 100): the goal waits for it
    assert_eq!(waits_for_wake(&[entry("w1", "agent", false, 150)], 100).as_deref(), Some("w1"));
    // a crew member's follow-up counts as the agent's too (anyone but you and wisp)
    assert_eq!(waits_for_wake(&[entry("w2", "Ada", false, 100)], 100).as_deref(), Some("w2"));
    // set before this turn, yours, wisp's own goal round, or a reminder: the turn is checked now
    assert_eq!(waits_for_wake(&[entry("old", "agent", false, 99)], 100), None);
    assert_eq!(waits_for_wake(&[entry("you", "user", false, 150)], 100), None);
    assert_eq!(waits_for_wake(&[entry("round", "wisp", false, 150)], 100), None);
    assert_eq!(waits_for_wake(&[entry("ping", "agent", true, 150)], 100), None);
    assert_eq!(waits_for_wake(&[], 100), None);
}

#[test]
fn a_wake_up_that_never_went_checks_the_goal_if_you_cancelled_it_else_pauses_it() {
    assert_eq!(wake_gone("cancelled"), WakeGone::CheckNow);
    assert_eq!(wake_gone("done"), WakeGone::Pause);
    assert_eq!(wake_gone("missed"), WakeGone::Pause);
}
