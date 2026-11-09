//! wisp.goal pure logic (goals: rounds, verdicts, judges, stalls), sans-IO. After each finished turn of
//! a task with a goal, its judges each say whether the goal is met; their votes (majority, all, any)
//! decide: met, another round with what they said, or, past the round limit, a stall that asks you.

use serde::{Deserialize, Serialize};

/// Turns a goal may take before it stops and asks, when nothing says.
pub const MAX_ROUNDS: u32 = 3;

/// What one judge said.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Verdict {
    pub judge: String,
    pub met: bool,
    /// why not (empty when met)
    pub why: String,
}

/// A judge's answer read: `NOT MET: why` (or `not met — why`) is no, `MET` is yes; anything else is no,
/// with the judge's silence as why (an unclear verdict never ends a goal).
pub fn verdict(judge: &str, answer: &str) -> Verdict {
    let up = answer.to_ascii_uppercase();
    if let Some(at) = up.find("NOT MET") {
        let why = answer[at + 7..].trim_start_matches([':', ' ', '-', '—']).lines().next().unwrap_or_default();
        let why = why.split(['"', '`']).next().unwrap_or_default().trim().to_owned();
        return Verdict { judge: judge.to_owned(), met: false, why: if why.is_empty() { "the goal isn't met yet".into() } else { why } };
    }
    if up.contains("MET") {
        return Verdict { judge: judge.to_owned(), met: true, why: String::new() };
    }
    Verdict { judge: judge.to_owned(), met: false, why: format!("{judge} didn't say whether it's met") }
}

/// The votes counted: `all`, `any`, else a majority (a tie isn't met).
pub fn met(vote: &str, v: &[Verdict]) -> bool {
    let yes = v.iter().filter(|x| x.met).count();
    match vote {
        "all" => !v.is_empty() && yes == v.len(),
        "any" => yes > 0,
        _ => yes * 2 > v.len(),
    }
}

/// What happens after a judged round.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Next {
    Met,
    /// another round, told this
    Again(String),
    /// the rounds are spent: ask the user
    Stall(String),
}

/// After round `round` (1-based) of at most `max`.
pub fn next(vote: &str, v: &[Verdict], round: u32, max: u32) -> Next {
    if met(vote, v) {
        return Next::Met;
    }
    let why: Vec<String> = v.iter().filter(|x| !x.met).map(|x| format!("{}: {}", x.judge, x.why)).collect();
    let why = why.join("\n");
    if round >= max.max(1) {
        Next::Stall(format!("The goal isn't met after {round} rounds.\n{why}\nKeep going?"))
    } else {
        Next::Again(format!("The goal isn't met yet. What the judges said:\n{why}\nKeep going until it is."))
    }
}

/// The prompt a judge gets.
pub fn judge_prompt(goal: &str, title: &str, answer: &str) -> String {
    format!("You judge whether a task met its goal. Answer with one line: MET, or NOT MET: <what's missing>.\n\nGoal: {goal}\nTask: {title}\nIts last answer:\n{answer}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verdicts_votes_and_rounds() {
        assert!(verdict("r", "MET").met);
        let no = verdict("r", "Fake: NOT MET: the tests still fail\nmore");
        assert_eq!((no.met, no.why.as_str()), (false, "the tests still fail"));
        assert!(!verdict("r", "looks fine").met, "unclear is no");
        let v = |m: &[bool]| m.iter().enumerate().map(|(i, &met)| Verdict { judge: format!("j{i}"), met, why: if met { String::new() } else { "x".into() } }).collect::<Vec<_>>();
        assert!(met("majority", &v(&[true, true, false])) && !met("majority", &v(&[true, false])));
        assert!(met("any", &v(&[false, true])) && !met("all", &v(&[false, true])) && !met("all", &[]));
        assert_eq!(next("all", &v(&[true]), 1, 3), Next::Met);
        assert!(matches!(next("all", &v(&[false]), 1, 3), Next::Again(_)));
        assert!(matches!(next("all", &v(&[false]), 3, 3), Next::Stall(s) if s.contains("after 3 rounds")));
    }
}
