//! `/goal …` as a whole prompt (v1 services/launch.js asGoal, slash-text.js goalAsk): "/goal all tests pass" starts
//! a task whose prompt and goal are both "all tests pass", from New task, the CLI, the phone or a channel alike.
//! `before:create` reads it and changes the task's args; it writes nothing. A reply box's `/goal …` is the goal
//! UI's (it sets the open task's goal); there is no goal to drop before the task exists, so `/goal drop` here is
//! refused with where it works.

use serde_json::Value;
use wisp_kernel::{Failure, InterceptOpts, Setup, Verdict};
use wisp_runtime_api::hooks::BeforeCreate;

/// What a prompt says as a `/goal` command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Typed {
    /// `/goal <condition>`
    Set(String),
    /// `/goal drop` (or clear, off, none)
    Drop,
    /// `/goal` alone
    Bare,
}

/// The `/goal` in a prompt, or None when it isn't one (`/goals`, `/goal` later in the text).
pub fn typed(prompt: &str) -> Option<Typed> {
    let t = prompt.trim();
    let rest = t.strip_prefix('/')?;
    let (head, tail) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
    if !head.eq_ignore_ascii_case("goal") {
        return None;
    }
    let tail = tail.trim();
    Some(match tail.to_ascii_lowercase().as_str() {
        "" => Typed::Bare,
        "drop" | "clear" | "off" | "none" => Typed::Drop,
        _ => Typed::Set(tail.to_owned()),
    })
}

pub const DROP_FIRST: &str = "No goal to drop yet: /goal drop works in a task’s reply box.";
pub const SAY_WHAT: &str = "Say what has to be true after /goal, like “/goal all tests pass”.";

pub(crate) fn register(s: &mut Setup) {
    s.intercept::<BeforeCreate, _, _>(
        InterceptOpts { priority: 10, failure: Failure::Open, timeout_ms: 200 },
        |_ctx, _call, mut a| async move {
            // a goal sent with it already says what done means, and a subagent can't have one (refuse_goal_on):
            // the prompt is the agent's, as typed
            if a.goal.as_ref().is_some_and(|g| !g.is_null()) || a.parent_id.is_some() {
                return Verdict::Continue;
            }
            match typed(&a.prompt) {
                None => Verdict::Continue,
                Some(Typed::Set(text)) => {
                    a.goal = Some(Value::String(text.clone()));
                    a.prompt = text;
                    Verdict::Modify { ctx: a }
                }
                Some(Typed::Drop) => Verdict::Veto { code: "invalid".into(), message: DROP_FIRST.into(), then: Vec::new() },
                Some(Typed::Bare) => Verdict::Veto { code: "invalid".into(), message: SAY_WHAT.into(), then: Vec::new() },
            }
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    /// v1 slash-text.js goalAsk and isGoalDrop, as the server reads a prompt.
    #[test]
    fn a_goal_typed_as_the_whole_prompt_is_read() {
        assert_eq!(typed("/goal all tests pass"), Some(Typed::Set("all tests pass".into())));
        assert_eq!(typed("  /GOAL   it works on a phone \n"), Some(Typed::Set("it works on a phone".into())));
        assert_eq!(typed("/goal\tmulti\nline"), Some(Typed::Set("multi\nline".into())));
        assert_eq!(typed("/goal"), Some(Typed::Bare));
        assert_eq!(typed("/goal Drop"), Some(Typed::Drop));
        assert_eq!(typed("/goal none"), Some(Typed::Drop));
        assert_eq!(typed("/goal drop the table"), Some(Typed::Set("drop the table".into())), "only the word alone drops");
        assert_eq!(typed("/goals"), None);
        assert_eq!(typed("fix it /goal tests pass"), None);
        assert_eq!(typed(""), None);
    }
}
