//! `wisp_task` and `wisp_available`, the decisions and the words (v1 routes/control.js `POST /internal/task/:id`,
//! `GET /internal/available/:id`, capped.js). Pure: the host reads the tasks, the harnesses and the machines, and
//! carries out what these allow.

use wisp_runtime_api::model::Mode;

/// The task whose agent asks.
#[derive(Debug, Clone, Copy)]
pub struct Asking<'a> {
    pub id: &'a str,
    /// its lead, when it is a subagent
    pub parent: Option<&'a str>,
    /// the mode cap a channel started it with (v1 `session.capped.mode`)
    pub cap: Option<Mode>,
}

/// The task it wants to act on.
#[derive(Debug, Clone, Copy)]
pub struct Other<'a> {
    pub id: &'a str,
    pub parent: Option<&'a str>,
    pub agent: &'a str,
    pub mode: Mode,
    /// it runs under a channel's cap too
    pub capped: bool,
    /// the asking task started it (v1 `origin: { kind: 'task', id }`)
    pub started_by_asking: bool,
}

/// Why not: v1's words, or the capped refusal's `what` (the kernel holds that sentence, `caps::capped_refusal`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    Says(String),
    Capped(&'static str),
}

/// A subagent works for its lead: only a task the user (or their crew) started acts on other tasks.
pub fn lead_refusal(me: &Asking<'_>) -> Option<Refusal> {
    me.parent.map(|_| Refusal::Says("A subagent can't act on other tasks: say so in your report, and your lead can.".into()))
}

/// The guards before any action, in v1's order. `mode`: the mode the call asks for, if any.
pub fn refusal(me: &Asking<'_>, x: &Other<'_>, mode: Option<Mode>) -> Option<Refusal> {
    let says = |s: &str| Some(Refusal::Says(s.to_owned()));
    if x.id == me.id {
        return says("That is this task. resume_later schedules a follow-up to yourself.");
    }
    if x.parent.is_some() {
        return says("That is a subagent of another task; act on its lead instead.");
    }
    if me.parent == Some(x.id) {
        return says("That is your own lead.");
    }
    if x.agent == "wisp" {
        return says("That is the welcome tour; it has no agent.");
    }
    // Only what it started, while that's still under a cap: asking any other task to do something would be
    // doing it without the cap. The other task's mode stays where it is, too.
    if let Some(cap) = me.cap {
        if let Some(m) = mode.filter(|m| m.rank() > cap.rank()) {
            return Some(Refusal::Says(over_cap(m, cap)));
        }
        if !x.started_by_asking || !x.capped {
            return Some(Refusal::Capped("act on a task it didn’t start"));
        }
        if mode.is_some_and(|m| m != x.mode) {
            return Some(Refusal::Capped("change another task’s mode"));
        }
    }
    None
}

/// The mode a caller's capability set caps it at: `agent:capped` is Edits, `agent:capped:<mode>` that mode.
pub fn cap_of(set: &str) -> Option<Mode> {
    match set.strip_prefix("agent:capped")? {
        "" => Some(Mode::Edits),
        rest => mode_of(rest.strip_prefix(':')?),
    }
}

pub fn mode_of(s: &str) -> Option<Mode> {
    match s {
        "plan" => Some(Mode::Plan),
        "edits" => Some(Mode::Edits),
        "auto" => Some(Mode::Auto),
        _ => None,
    }
}

pub fn mode_id(m: Mode) -> &'static str {
    match m {
        Mode::Plan => "plan",
        Mode::Edits => "edits",
        Mode::Auto => "auto",
    }
}

/// v1 `MODE_LABEL`.
pub fn mode_label(m: Mode) -> &'static str {
    match m {
        Mode::Plan => "Plan",
        Mode::Edits => "Edits",
        Mode::Auto => "Full auto",
    }
}

/// v1 capped.js `overCap`.
pub fn over_cap(mode: Mode, cap: Mode) -> String {
    format!(
        "Refused: {} is above this task's cap of {}, set by the channel that started it. Use {} or lower; the user can raise it in wisp.",
        mode_label(mode),
        mode_label(cap),
        mode_label(cap)
    )
}

pub const BAD_MODE: &str = "mode must be plan, edits or auto.";
pub const BAD_ACTION: &str = "action is one of reply, stop, done, archive, unarchive, rename (wait is answered by the MCP server).";
pub const NEEDS_TEXT: &str = "text is required.";
pub const NEEDS_TITLE: &str = "title is required.";

/// The task id as an agent wrote it: trimmed, without a `wisp:` prefix.
pub fn task_id(raw: &str) -> &str {
    let t = raw.trim();
    t.strip_prefix("wisp:").unwrap_or(t)
}

pub fn no_task(id: &str) -> String {
    format!("No task `{id}` on this computer. wisp_sessions lists them.")
}

/// How v1 names the other task in its answers.
pub fn name(title: &str, id: &str) -> String {
    format!("“{title}” (`{id}`)")
}

pub fn still_working(name: &str) -> String {
    format!("{name} is still working; stop it first or wait.")
}

/// A new title: one line, at most 120 characters.
pub fn title(raw: &str) -> String {
    raw.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(120).collect()
}

/// Where a reply went.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Replied {
    Answered,
    Held,
    Queued,
    Interrupted,
    Sent,
}

pub fn replied(how: Replied, name: &str) -> String {
    let how = match how {
        Replied::Answered => "Answered its question; it carries on.",
        Replied::Held => "Held at the user’s usage line; it goes when they say.",
        Replied::Queued => "Queued: it goes once its current run finishes.",
        Replied::Interrupted => "Interrupted its run; it carries on with your message.",
        Replied::Sent => "Sent; it is working on it.",
    };
    format!("{how} {name}. wisp_task with action \"wait\" blocks until it is done.")
}

/// A harness the reply switches to, checked like v1 `checkHarness` on this computer.
pub fn harness_refusal(agent: &str, known: &[(String, String, bool, Option<bool>)]) -> Option<String> {
    if agent.is_empty() || agent == "auto" {
        return None;
    }
    let Some((_, name, available, signed_in)) = known.iter().find(|(id, ..)| id == agent && id != "wisp") else {
        let ids: Vec<&str> = known.iter().map(|(id, ..)| id.as_str()).filter(|id| *id != "wisp").collect();
        return Some(format!("Unknown harness “{agent}”. One of: {}, or auto.", ids.join(", ")));
    };
    (!available).then(|| format!("{name} isn't {} on this computer.", if *signed_in == Some(false) { "signed in" } else { "installed" }))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn me(cap: Option<Mode>) -> Asking<'static> {
        Asking { id: "me", parent: None, cap }
    }
    fn other(id: &'static str) -> Other<'static> {
        Other { id, parent: None, agent: "claude", mode: Mode::Edits, capped: false, started_by_asking: false }
    }
    fn says(r: Option<Refusal>) -> String {
        match r {
            Some(Refusal::Says(s)) => s,
            Some(Refusal::Capped(w)) => format!("capped: {w}"),
            None => String::new(),
        }
    }

    #[test]
    fn a_task_never_acts_on_itself_its_lead_a_subagent_or_the_tour() {
        assert!(says(refusal(&me(None), &other("me"), None)).starts_with("That is this task."));
        let sub = Other { parent: Some("lead"), ..other("s") };
        assert_eq!(says(refusal(&me(None), &sub, None)), "That is a subagent of another task; act on its lead instead.");
        let child = Asking { id: "me", parent: Some("lead"), cap: None };
        assert_eq!(says(refusal(&child, &other("lead"), None)), "That is your own lead.");
        assert!(lead_refusal(&child).is_some() && lead_refusal(&me(None)).is_none());
        let tour = Other { agent: "wisp", ..other("t") };
        assert_eq!(says(refusal(&me(None), &tour, None)), "That is the welcome tour; it has no agent.");
        assert_eq!(refusal(&me(None), &other("x"), Some(Mode::Auto)), None, "uncapped: any task, any mode");
    }

    #[test]
    fn a_capped_task_acts_only_on_capped_tasks_it_started_and_never_raises_a_mode() {
        let cap = Some(Mode::Edits);
        assert!(says(refusal(&me(cap), &other("x"), Some(Mode::Auto))).starts_with("Refused: Full auto is above this task's cap of Edits"));
        assert_eq!(says(refusal(&me(cap), &other("x"), None)), "capped: act on a task it didn’t start");
        let mine_uncapped = Other { started_by_asking: true, ..other("x") };
        assert_eq!(says(refusal(&me(cap), &mine_uncapped, None)), "capped: act on a task it didn’t start");
        let mine = Other { started_by_asking: true, capped: true, ..other("x") };
        assert_eq!(refusal(&me(cap), &mine, None), None);
        assert_eq!(refusal(&me(cap), &mine, Some(Mode::Edits)), None, "its own mode again is no change");
        assert_eq!(says(refusal(&me(cap), &mine, Some(Mode::Plan))), "capped: change another task’s mode");
    }

    #[test]
    fn the_cap_comes_from_the_callers_set() {
        assert_eq!(cap_of("agent:capped"), Some(Mode::Edits));
        assert_eq!(cap_of("agent:capped:plan"), Some(Mode::Plan));
        assert_eq!(cap_of("agent:session:auto"), None);
        assert_eq!(cap_of("agent:cappedx"), None);
    }

    #[test]
    fn words_for_ids_titles_and_replies() {
        assert_eq!(task_id(" wisp:abc "), "abc");
        assert_eq!(title("  a\n b   c "), "a b c");
        assert_eq!(title(&"x".repeat(200)).len(), 120);
        assert_eq!(
            replied(Replied::Queued, &name("Fix", "t1")),
            "Queued: it goes once its current run finishes. “Fix” (`t1`). wisp_task with action \"wait\" blocks until it is done."
        );
    }

    #[test]
    fn a_harness_switch_names_what_is_missing() {
        let known = vec![
            ("claude".to_owned(), "Claude Code".to_owned(), true, Some(true)),
            ("codex".to_owned(), "Codex".to_owned(), false, Some(false)),
            ("grok".to_owned(), "Grok".to_owned(), false, None),
            ("wisp".to_owned(), "wisp".to_owned(), true, None),
        ];
        assert_eq!(harness_refusal("auto", &known), None);
        assert_eq!(harness_refusal("claude", &known), None);
        assert_eq!(harness_refusal("codex", &known).unwrap(), "Codex isn't signed in on this computer.");
        assert_eq!(harness_refusal("grok", &known).unwrap(), "Grok isn't installed on this computer.");
        assert_eq!(harness_refusal("nope", &known).unwrap(), "Unknown harness “nope”. One of: claude, codex, grok, or auto.");
    }
}
