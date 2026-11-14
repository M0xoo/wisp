//! A task's mode cap (v1 server/capped.js, the runtime's part; F-chan-10): a task a channel started below Full
//! auto carries `capped: { mode }` in runtime's slot (`ext["wisp.runtime"]`), the shape crew's jobs already
//! carry. Its turns never run above it; asking for more is refused, unless the user asks in wisp, which lifts it
//! (v1: "You choosing a higher mode in wisp clears it for that task"). Pure: the host reads the task and the caller.

use serde_json::{Value, json};
use wisp_runtime_api::model::Mode;

use crate::agent_task::{mode_id, mode_of, over_cap};

/// The cap in runtime's slot. A `capped` with no readable mode is Edits (as crew's `at_cap` reads it); none at all,
/// or a null, is no cap.
pub fn of(slot: Option<&Value>) -> Option<Mode> {
    let c = slot?.get("capped").filter(|c| !c.is_null())?;
    Some(c.get("mode").and_then(Value::as_str).and_then(mode_of).unwrap_or(Mode::Edits))
}

/// What runtime's slot keeps for a cap. None at Full auto: that lets a task do anything already (v1 `cappedAt`).
pub fn stored(cap: Mode) -> Option<Value> {
    (cap.rank() < Mode::Auto.rank()).then(|| json!({ "mode": mode_id(cap) }))
}

/// The lower of two caps (a cap never rises on the way down: a channel's, a lead's).
pub fn tighter(a: Option<Mode>, b: Option<Mode>) -> Option<Mode> {
    match (a, b) {
        (Some(x), Some(y)) => Some(if x.rank() <= y.rank() { x } else { y }),
        (x, None) => x,
        (None, y) => y,
    }
}

/// A mode held to the cap.
pub fn at_cap(mode: Mode, cap: Option<Mode>) -> Mode {
    match cap {
        Some(c) if mode.rank() > c.rank() => c,
        _ => mode,
    }
}

/// The person at wisp (`user:full`, or `box`: the person at a grid box's page), not an agent, a channel, a crew
/// member or a key (v1: only the user lifts a cap).
pub fn is_user(set: &str) -> bool {
    set == "user:full" || set == "box"
}

/// What asking a capped task for `mode` does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Asked {
    /// at or under the cap (or no cap): as asked
    Within,
    /// above it, by the user: the cap comes off this task
    Lift,
    /// above it, by anyone else: v1's words
    Refused(String),
}

pub fn ask(mode: Mode, cap: Option<Mode>, set: &str) -> Asked {
    match cap {
        Some(c) if mode.rank() > c.rank() => {
            if is_user(set) {
                Asked::Lift
            } else {
                Asked::Refused(over_cap(mode, c))
            }
        }
        _ => Asked::Within,
    }
}

#[cfg(test)]
#[allow(clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn a_cap_reads_from_the_slot_crews_jobs_and_channels_write() {
        assert_eq!(of(Some(&json!({ "capped": { "mode": "plan" } }))), Some(Mode::Plan));
        assert_eq!(of(Some(&json!({ "capped": {} }))), Some(Mode::Edits), "a cap with no mode is Edits");
        assert_eq!(of(Some(&json!({ "capped": null }))), None);
        assert_eq!(of(Some(&json!({}))), None);
        assert_eq!(of(None), None);
        assert_eq!(stored(Mode::Edits), Some(json!({ "mode": "edits" })));
        assert_eq!(stored(Mode::Auto), None, "Full auto is no cap");
    }

    #[test]
    fn a_capped_task_never_runs_above_its_cap_and_only_the_user_lifts_it() {
        assert_eq!(at_cap(Mode::Auto, Some(Mode::Edits)), Mode::Edits);
        assert_eq!(at_cap(Mode::Plan, Some(Mode::Edits)), Mode::Plan, "a lower mode stays");
        assert_eq!(at_cap(Mode::Auto, None), Mode::Auto);
        assert_eq!(tighter(Some(Mode::Edits), Some(Mode::Plan)), Some(Mode::Plan));
        assert_eq!(tighter(None, Some(Mode::Edits)), Some(Mode::Edits));
        assert_eq!(ask(Mode::Edits, Some(Mode::Edits), "plugin:wisp.channels"), Asked::Within);
        assert_eq!(ask(Mode::Auto, None, "agent:session"), Asked::Within);
        assert_eq!(ask(Mode::Auto, Some(Mode::Edits), "user:full"), Asked::Lift);
        assert_eq!(ask(Mode::Auto, Some(Mode::Edits), "box"), Asked::Lift, "the user at a grid box's page");
        for set in ["agent:session", "agent:capped", "plugin:wisp.channels", "crew:ops", "apikey", "kernel"] {
            let Asked::Refused(why) = ask(Mode::Auto, Some(Mode::Edits), set) else { panic!("{set} may not raise a cap") };
            assert!(why.starts_with("Refused: Full auto is above this task's cap of Edits"), "{why}");
        }
    }
}
