//! /side (v1 server/side.js, its prompts): a side discussion about a task, a task of its own that
//! works in the main task's folder as it is now and gets the main task's latest state with every
//! message. Every write it makes goes through wisp's gate first. These are its texts.

use super::btw::btw_digest;
use super::handoff::{PastTurn, Render};
use super::text::{Re, js_s, trim};

static SIDE_CMD: Re = Re::new(concat!("(?i)^/side(?:", js_s!(), "+|$)"));

/// The opening message in "/side why …" ('' for a bare /side), or None when the text isn't a /side.
pub fn side_ask(text: &str) -> Option<String> {
    let t = trim(text);
    SIDE_CMD.is_match(t).then(|| trim(&SIDE_CMD.replace(t, "")).to_owned())
}

/// What a write refused on a side discussion that can't ask before a write says.
pub const SIDE_DENIED: &str = "This is a read-only side discussion: this harness can't ask wisp before a write, so nothing may be changed here. Do not retry; answer from what you can read, and say what the main task (or the user) would have to do.";

/// What a write the user turned down at a clash says. `other`: the clash was with another side discussion.
pub fn side_kept(words: &str, other: bool) -> String {
    let (whose, there) = if other { ("other side discussion", "that side discussion") } else { ("main task", "the main task") };
    let said = if words.is_empty() { String::new() } else { format!(" They said: {words}") };
    format!(
        "The user kept the {whose}'s version: nothing was changed.{said} Do not retry this change. Say what the user could tell {there} instead (a follow-up they can send there)."
    )
}

/// The task a side discussion is about (`sideOf`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SideOf<'a> {
    pub id: &'a str,
    pub title: &'a str,
}

/// The system prompt's part for a side discussion. `session_tool`: how the harness names
/// `wisp_session` ('' without wisp's tools). `edits`: it may edit behind the gate; else it only reads,
/// and `name` (its harness's) is why.
pub fn side_note(of: SideOf<'_>, session_tool: &str, edits: bool, name: &str) -> String {
    let tool = if session_tool.is_empty() { String::new() } else { format!("`{session_tool}` with id {} reads its whole record.", of.id) };
    let read = format!("`git status`, `git diff`, `git log` show what it changed. {tool}");
    let open = format!(
        "\n\n# wisp side discussion\n\nThis task is a side discussion about another wisp task, the main task “{}” (wisp task {}). Another agent run does the main task's work; here you talk it over with the user: explain what it did and why, review it, weigh options, plan what to ask it next.\n",
        of.title, of.id
    );
    let latest = "- Every message from the user starts with the main task's latest state (under \"The main task now\"). It may have moved on since your last answer: go by the latest one.";
    if !edits {
        return format!(
            "{open}
- Change nothing. No edits, no file writes, no commits, no branches, no installs, no commands with side effects, no new tasks. You run read-only; anything that would change something is refused. {name} can’t ask wisp before a write, so side discussions on it only read.
- Read freely: the files in the folder you're in are the main task's work as it is right now ({read})
{latest}
- Answer as for any wisp task, wisp presentation block included. Where a change is wanted, say what to tell the main task (a follow-up the user can send there) instead of making it."
        );
    }
    format!(
        "{open}
- You share the main task's folder: the files here are its work as it is right now ({read}) What you change lands in that work, and the main task may be editing at the same time.
- Run what the user asks and edit what they ask, when they ask. Don't start changes of your own: this is a discussion, the main task does the work.
- wisp checks every write before it happens. A file the main task hasn't touched goes through. One it changed elsewhere goes through with a warning. Lines it changed are a clash: the user sees a card here, and if they accept, wisp tells the main task. If they keep the main task's version your call is refused: don't retry it, and say what to tell the main task instead.
- Commits, pushes, resets, stashes, rebases, merges and the like rewrite the main task's work: they count as clashes, and so does a command that removes or writes over a file it changed (`rm`, `>`, `sed -i`, `patch`, `cp`…). wisp's own Ship, rollback, fork, goals and terminal stay on the main task. You can't start tasks, delegate or edit the crew.
{latest}
- Answer as for any wisp task, wisp presentation block included."
    )
}

/// The main task as a side discussion sees it before each message.
#[derive(Debug, Clone, Copy)]
pub struct MainTask<'a> {
    pub title: &'a str,
    pub turns: &'a [PastTurn<'a>],
}

/// What goes before each of the user's messages: the main task as it stands now (None once it's gone).
pub fn side_prompt(main: Option<MainTask<'_>>, text: &str, now_ms: i64, render: Render<'_>) -> String {
    let head = match main {
        Some(m) => {
            let digest = btw_digest(m.turns, now_ms, render);
            let digest = if digest.is_empty() { "_Nothing has run on it yet._".to_owned() } else { digest };
            format!("## The main task now: “{}”\n\n{digest}", m.title)
        }
        None => {
            "## The main task now\n\n_The main task was deleted: only what was said here, and its folder as it is, are left._".to_owned()
        }
    };
    format!("{head}\n\n---\n\n## The user, in this side discussion\n\n{text}")
}
