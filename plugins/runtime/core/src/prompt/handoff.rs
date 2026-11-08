//! Switching harness in a follow-up (v1 server/handoff.js). Each harness keeps its own conversation,
//! so one picked up mid-task hasn't seen the turns that ran elsewhere: `handoff_note` writes those
//! turns out (requests, reports, files touched) ahead of the follow-up's prompt.
//!
//! size-ok: v1 handoff.js's rules and their tests, one decision each

use std::fmt::{self, Write as _};

use serde_json::Value;
use wisp_runtime_api::model::{Activity, Turn, TurnStatus};

use super::mentions::text_mentions;
use super::text::{Re, clip, join_some, js_s, truncate};

/// characters of earlier turns, newest kept first
const BUDGET: usize = 24_000;
const MAX_RULES: usize = 12;
const RULE_CHARS: usize = 300;
const PER_TURN: usize = 6_000;

/// The parts of a report worth passing on. Diffs, code and terminal output are on disk or in git.
pub const KEEP: [&str; 11] = [
    "hero",
    "markdown",
    "steps",
    "stats",
    "files",
    "tests",
    "commits",
    "checklist",
    "callout",
    "question",
    "next",
];

/// Renders blocks as markdown (the `blocks` module's renderer, which this module doesn't depend on).
#[derive(Clone, Copy)]
pub struct Render<'a>(pub &'a dyn Fn(&[Value], &Turn) -> String);

impl fmt::Debug for Render<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Render(..)")
    }
}

fn render_nothing(_: &[Value], _: &Turn) -> String {
    String::new()
}

impl Default for Render<'_> {
    fn default() -> Self {
        Self(&render_nothing)
    }
}

/// A delegation a turn made: who to, and what it was asked.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Delegated {
    pub name: String,
    pub prompt: String,
}

/// One turn of a task, with what the host knows of it beyond the row (other plugins' slots and the
/// event log): what a hand-off or a /btw digest writes out.
#[derive(Debug, Clone)]
#[allow(clippy::struct_excessive_bools)] // v1's turn flags, one for one
pub struct PastTurn<'a> {
    pub turn: &'a Turn,
    /// its harness's display name ("Claude Code")
    pub name: String,
    /// the files it edited and didn't revert
    pub files: Vec<String>,
    /// it ran on another place before the task moved here (that place's name)
    pub moved: Option<String>,
    /// one of a fork's first turns: it ran in the task this was forked from
    pub forked: bool,
    /// one of a shared task's turns: it ran on someone else's wisp
    pub shared: bool,
    pub rolled_back: bool,
    pub delegations: Vec<Delegated>,
    /// a goal round or a scheduled follow-up: not the user's own words
    pub automated: bool,
    /// its activity so far (a running turn's, for /btw)
    pub activity: &'a [Activity],
}

impl<'a> PastTurn<'a> {
    pub fn new(turn: &'a Turn, name: impl Into<String>) -> Self {
        Self {
            turn,
            name: name.into(),
            files: Vec::new(),
            moved: None,
            forked: false,
            shared: false,
            rolled_back: false,
            delegations: Vec::new(),
            automated: false,
            activity: &[],
        }
    }

    fn elsewhere(&self) -> bool {
        self.moved.as_deref().is_some_and(|m| !m.is_empty()) || self.forked || self.shared
    }
}

/// The task this one was forked from (`forkedFrom`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ForkedFrom {
    pub title: String,
    pub turn: u32,
    pub of: u32,
}

/// Who shared this task from their wisp (`sharedFrom`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SharedFrom {
    pub name: String,
    pub handle: String,
    pub title: String,
}

/// What a hand-off reads of the task.
#[derive(Debug, Clone, Default)]
pub struct Handoff<'a> {
    /// every turn of the task, the one about to run last
    pub turns: &'a [PastTurn<'a>],
    /// the harness taking the next turn
    pub agent: &'a str,
    /// the conversation it resumes, if any
    pub resume_id: Option<&'a str>,
    /// the account it runs on, when its harness's conversations stay with the login (another
    /// account's turns count as missed)
    pub login: Option<&'a str>,
    pub forked_from: Option<ForkedFrom>,
    pub shared_from: Option<SharedFrom>,
    /// the task's goal while one is in progress (wisp.goal's slot)
    pub done_when: &'a str,
}

impl Handoff<'_> {
    fn mine(&self, t: &PastTurn<'_>) -> bool {
        let agent = if t.turn.agent.is_empty() {
            self.agent
        } else {
            t.turn.agent.as_str()
        };
        agent == self.agent
            && self.login.is_none_or(|login| {
                t.turn
                    .account
                    .as_deref()
                    .filter(|a| !a.is_empty())
                    .unwrap_or("default")
                    == login
            })
    }
}

/// The turns before the current one that `h.agent` hasn't seen (indices into `h.turns`): everything
/// after the last turn it ran, or all of them when it has no conversation to resume. Only a gap
/// another harness filled counts. Moved, forked and shared turns count as unseen by every harness.
pub fn missed_turns(h: &Handoff<'_>) -> Vec<usize> {
    let prior = h.turns.len().saturating_sub(1);
    let from = if h.resume_id.is_some_and(|r| !r.is_empty()) {
        h.turns[..prior]
            .iter()
            .rposition(|t| !t.elsewhere() && h.mine(t))
            .map_or(0, |i| i + 1)
    } else {
        0
    };
    let missed: Vec<usize> = (from..prior).collect();
    if missed
        .iter()
        .any(|&i| h.turns[i].elsewhere() || !h.mine(&h.turns[i]))
    {
        missed
    } else {
        Vec::new()
    }
}

/// One earlier turn as markdown: the request, its report and the files it edited. /btw uses it too.
pub fn turn_text(t: &PastTurn<'_>, n: usize, render: Render<'_>) -> String {
    let turn = t.turn;
    let report = if turn.status == TurnStatus::Running {
        String::new()
    } else {
        let blocks: Vec<Value> = turn
            .presentation
            .iter()
            .flat_map(|p| p.blocks.iter())
            .filter(|b| {
                b.get("type")
                    .and_then(Value::as_str)
                    .is_some_and(|ty| KEEP.contains(&ty))
            })
            .cloned()
            .collect();
        let md = if blocks.is_empty() {
            String::new()
        } else {
            (render.0)(&blocks, turn)
        };
        if md.is_empty() {
            clip(turn.text.as_deref().unwrap_or(""), 1500)
        } else {
            md
        }
    };
    let mut head = format!("### Turn {n} · {}", t.name);
    if !turn.model.is_empty() {
        let _ = write!(head, " ({})", turn.model);
    }
    if let Some(m) = t.moved.as_deref().filter(|m| !m.is_empty()) {
        let _ = write!(head, " · on {m}");
    }
    match turn.status {
        TurnStatus::Stopped => head.push_str(" · stopped"),
        TurnStatus::Error => head.push_str(" · failed"),
        _ => {}
    }
    if t.rolled_back {
        head.push_str(" · rolled back, its edits were undone");
    }
    let files: Vec<String> = t.files.iter().map(|f| format!("`{f}`")).collect();
    let delegated: Vec<String> = t
        .delegations
        .iter()
        .map(|d| format!("@{} ({})", d.name, clip(&text_mentions(&d.prompt), 120)))
        .collect();
    let parts = [
        head,
        format!("**User:** {}", text_mentions(&turn.prompt)),
        if report.is_empty() {
            String::new()
        } else {
            format!("**Report:**\n\n{report}")
        },
        if files.is_empty() {
            String::new()
        } else {
            format!("**Files it edited:** {}", files.join(", "))
        },
        if delegated.is_empty() {
            String::new()
        } else {
            format!("**Delegated:** {}", delegated.join("; "))
        },
    ];
    truncate(&join_some(&parts, "\n\n"), PER_TURN)
}

// What the user ruled out or narrowed in their own messages: a turn digest clips them, and a harness
// taking the task over would lose them.
static RULES: [Re; 6] = [
    Re::new(
        r"(?i)\b(?:don'?t|do not|never|must not|mustn'?t|shouldn'?t|should not|avoid)\s+(?:[A-Za-z0-9_]+ing\s+)?(?:touch|chang|modif|edit|delet|remov|renam|refactor|rewrit|add|commit|push|merge|install|upgrad|bump|deploy|publish|run)",
    ),
    Re::new(r"(?i)\bonly\s+(?:change|touch|edit|modify|work (?:in|on))\b"),
    Re::new(r"(?i)\bleave\b[^\n\r\x{2028}\x{2029}]{1,80}?\b(?:alone|as (?:it )?is|untouched)\b"),
    Re::new(r"(?i)\bwithout (?:changing|touching|modifying|editing)\b"),
    Re::new(r"(?i)\bkeep\b[^\n\r\x{2028}\x{2029}]{1,60}?\b(?:as (?:it )?is|unchanged|untouched)\b"),
    Re::new(r"(?i)\b(?:no new|not? (?:any )?new) (?:dependenc|packages?|librar|files?)"),
];
static BULLET: Re = Re::new(concat!(
    "^",
    js_s!(),
    "*(?:[-*•>]|[0-9]+[.)])",
    js_s!(),
    "*"
));

/// `text.split(/\n+|(?<=[.!?])\s+(?=[A-Z])/)`: lines, and sentences that end and start a new one.
fn sentences(text: &str) -> Vec<&str> {
    let is_space = |c: char| super::text::is_js_space(c);
    let mut out = Vec::new();
    let (mut start, mut prev) = (0, None::<char>);
    let mut it = text.char_indices().peekable();
    while let Some((i, c)) = it.next() {
        let run_end = |from: usize, pred: &dyn Fn(char) -> bool| {
            text[from..]
                .char_indices()
                .find(|&(_, c)| !pred(c))
                .map_or(text.len(), |(j, _)| from + j)
        };
        if c == '\n' {
            let end = run_end(i, &|c| c == '\n');
            out.push(&text[start..i]);
            start = end;
        } else if is_space(c) && matches!(prev, Some('.' | '!' | '?')) {
            let end = run_end(i, &is_space);
            if text[end..].starts_with(|n: char| n.is_ascii_uppercase()) {
                out.push(&text[start..i]);
                start = end;
            } else {
                prev = Some(c);
                continue;
            }
        } else {
            prev = Some(c);
            continue;
        }
        while it.peek().is_some_and(|&(j, _)| j < start) {
            prev = it.next().map(|(_, c)| c);
        }
    }
    out.push(&text[start..]);
    out
}

/// The user's "don't touch / only change / leave … alone" lines, from their own turns, once each,
/// oldest first, at most the latest 12.
pub fn constraints_of(turns: &[PastTurn<'_>]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in turns {
        if t.turn.by.as_deref().is_some_and(|b| !b.is_empty())
            || t.automated
            || t.turn.prompt.is_empty()
        {
            continue;
        }
        let text = text_mentions(&t.turn.prompt).replace(['\u{2018}', '\u{2019}'], "'");
        for raw in sentences(&text) {
            let line = BULLET.replace(raw, "");
            let line = super::text::trim(&line);
            if line.is_empty() || !RULES.iter().any(|r| r.is_match(line)) {
                continue;
            }
            let rule = clip(line, RULE_CHARS);
            if !out.contains(&rule) {
                out.push(rule);
            }
        }
    }
    let skip = out.len().saturating_sub(MAX_RULES);
    out.split_off(skip)
}

fn keep_note(turns: &[PastTurn<'_>], done_when: &str) -> String {
    let rules = constraints_of(turns);
    if rules.is_empty() && done_when.is_empty() {
        return String::new();
    }
    let mut lines: Vec<String> = rules.iter().map(|r| format!("- {r}")).collect();
    if !done_when.is_empty() {
        lines.push(format!("- Done when: {}", clip(done_when, 600)));
    }
    [
        "### What still holds",
        "The user set these earlier in this task. They hold for you too, whatever the turns below did:",
        &lines.join("\n"),
    ]
    .join("\n\n")
}

const LEVELS: [&str; 6] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/// The same thinking level on the harness taking over, as close as it has one (the lower on a tie);
/// '' when it has none or none was set.
pub fn map_effort<S: AsRef<str>>(effort: &str, levels: &[S]) -> String {
    let levels: Vec<&str> = levels.iter().map(AsRef::as_ref).collect();
    if effort.is_empty() || levels.is_empty() {
        return String::new();
    }
    if levels.contains(&effort) {
        return effort.to_owned();
    }
    let rank = |l: &str| LEVELS.iter().position(|x| *x == l);
    let Some(at) = rank(effort) else {
        return String::new();
    };
    levels
        .iter()
        .filter_map(|l| rank(l).map(|r| (r.abs_diff(at), r, *l)))
        .min_by_key(|&(d, r, _)| (d, r))
        .map(|(_, _, l)| l.to_owned())
        .unwrap_or_default()
}

fn intro(h: &Handoff<'_>, missed: &[&PastTurn<'_>], others: &str, places: &str) -> String {
    if let Some(sh) = h
        .shared_from
        .as_ref()
        .filter(|_| missed.iter().any(|t| t.shared))
    {
        let who = if sh.name.is_empty() {
            "someone"
        } else {
            &sh.name
        };
        let handle = if sh.handle.is_empty() {
            String::new()
        } else {
            format!(" (@{})", sh.handle)
        };
        return format!(
            "You are carrying on a task that {who}{handle} shared from their wisp (“{}”), now in the user's own wisp. Its work so far is in this folder when it came with the share: committed work as commits, the rest as uncommitted changes. Below is what happened so far, oldest first; read the files and `git diff` for the details, then do what the follow-up asks.",
            sh.title
        );
    }
    if let Some(f) = h
        .forked_from
        .as_ref()
        .filter(|_| missed.iter().any(|t| t.forked))
    {
        return format!(
            "This task is a fork of another one (“{}”), made from its turn {} of {} to try another way. You carry on from there in a copy of its work, on a branch of its own: what you change here doesn’t touch the original, which carries on separately. Below is what happened up to the fork, oldest first; read the files and `git diff` for the details, then do what the follow-up asks.",
            f.title, f.turn, f.of
        );
    }
    if !places.is_empty() {
        let on = if others.is_empty() {
            String::new()
        } else {
            format!(", on {others}")
        };
        return format!(
            "You are taking over a task that ran on another computer ({places}){on}, and was moved here. Its work so far is already in this folder: committed work as commits, the rest as uncommitted changes. Below is what happened so far, oldest first; read the files and `git diff` for the details, then carry on with the follow-up."
        );
    }
    if h.resume_id.is_none_or(str::is_empty) {
        return format!(
            "You are taking over a task that another coding agent ({others}) has been working on. Its work is already in this folder. Below is what happened so far, oldest first; read the files and `git diff` for the details, then carry on with the follow-up."
        );
    }
    format!(
        "While you were away, this task continued on another coding agent ({others}). Its work is already in this folder. Below is what happened since your last turn, oldest first; check the files and `git diff` before you rely on what you remember."
    )
}

fn unique(items: impl Iterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for i in items {
        if !out.contains(&i) {
            out.push(i);
        }
    }
    out
}

/// The note for `h.agent` taking the next turn, or '' when it has seen everything.
pub fn handoff_note(h: &Handoff<'_>, render: Render<'_>) -> String {
    let idx = missed_turns(h);
    let Some(&last) = idx.last() else {
        return String::new();
    };
    let missed: Vec<&PastTurn<'_>> = idx.iter().map(|&i| &h.turns[i]).collect();
    let mut parts: Vec<String> = Vec::new();
    let mut used = 0;
    for &i in idx.iter().rev() {
        let text = turn_text(&h.turns[i], i + 1, render);
        let len = super::text::len16(&text);
        if used + len > BUDGET && !parts.is_empty() {
            break;
        }
        parts.insert(0, text);
        used += len;
    }
    let dropped = missed.len() - parts.len();
    let others = unique(
        missed
            .iter()
            .filter(|t| t.turn.agent != h.agent)
            .map(|t| t.name.clone()),
    )
    .join(", ");
    let others = if others.is_empty() {
        format!("{}, signed in to another account", h.turns[last].name)
    } else {
        others
    };
    let places = unique(
        missed
            .iter()
            .filter_map(|t| t.moved.clone().filter(|m| !m.is_empty())),
    )
    .join(", ");
    let mut all = vec![
        "## Earlier in this task".to_owned(),
        intro(h, &missed, &others, &places),
        keep_note(h.turns, h.done_when),
        if dropped > 0 {
            format!(
                "_{dropped} earlier turn{} left out for length._",
                if dropped > 1 { "s" } else { "" }
            )
        } else {
            String::new()
        },
    ];
    all.extend(parts);
    all.extend(["---".to_owned(), "## Follow-up".to_owned()]);
    join_some(&all, "\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_pattern_compiles() {
        assert!(RULES.iter().all(|r| r.get().is_some()));
        assert!(BULLET.get().is_some());
    }

    #[test]
    fn sentences_split_as_v1_did() {
        assert_eq!(
            sentences("a. B c\n\nd! e. F"),
            vec!["a.", "B c", "d! e.", "F"]
        );
        assert_eq!(sentences("x.  \nY"), vec!["x.", "Y"]);
        assert_eq!(sentences("v1.2 ok. fine"), vec!["v1.2 ok. fine"]);
        assert_eq!(sentences(""), vec![""]);
    }
}
