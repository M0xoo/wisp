//! /btw (v1 server/btw.js): a side question about a task ("/btw did you also update the docs?"),
//! answered while its run carries on, by a read-only run of its own: a fork of the agent's
//! conversation where the harness can fork one, else a fresh run that gets wisp's record of the task.
//! Nothing goes back into the task's conversation. These are the texts; the host runs it.

use wisp_runtime_api::model::{Activity, TurnStatus};

use super::handoff::{PastTurn, Render, turn_text};
use super::mentions::text_mentions;
use super::text::{Re, clip, join_some, js_s, trim, truncate};

static BTW_CMD: Re = Re::new(concat!("(?i)^/btw(?:", js_s!(), "+|$)"));
/// side questions running at once, per task
pub const MAX_BTW: usize = 3;
pub const BTW_TIMEOUT_MS: u64 = 5 * 60_000;
/// earlier turns written out for a run that can't fork
const DIGEST_TURNS: usize = 4;
/// the running turn's latest actions it gets to see
const LIVE_ACTS: usize = 40;

/// The question in "/btw did you …", or None when the text isn't a /btw.
pub fn btw_question(text: &str) -> Option<String> {
    let t = trim(text);
    BTW_CMD
        .is_match(t)
        .then(|| trim(&BTW_CMD.replace(t, "")).to_owned())
}

/// Marks the run as a side question (the system prompt, where the harness takes one).
pub const BTW_SYSTEM: &str = "# wisp btw\n\nYou answer a side question about a coding task. You only read; you change nothing.";

fn rules(forked: bool) -> String {
    let who = if forked {
        "This is a copy of the conversation so far: the original keeps working on the task in parallel, and it"
    } else {
        "Another agent run is working on this task, and it"
    };
    format!(
        "# wisp btw

The user has a quick side question (/btw) about this task. {who} does the work. This reply only answers the user.

- Answer just the question, briefly: a few sentences or a short list, in plain markdown.
- Change nothing: no edits, no file writes, no commits, no commands with side effects. Reading files, `git diff` and `git status` is fine when you need to check.
- No wisp presentation block and no wisp tools (ask_user, delegate): this isn't a task result.
- If you can't tell from what's here, say so instead of guessing."
    )
}

/// What one step of a running turn is called in the digest (v1's activity `label`).
fn act_label(a: &Activity) -> Option<&str> {
    match a {
        Activity::Tool { label, .. } => Some(label),
        Activity::Notice { text, .. } => Some(text),
        _ => None,
    }
}

fn minutes_since(now_ms: i64, started_ms: i64) -> i64 {
    // Math.max(1, Math.round(ms / 60_000))
    let d = now_ms.saturating_sub(started_ms);
    if d <= 0 {
        1
    } else {
        (d.saturating_add(30_000) / 60_000).max(1)
    }
}

fn running_text(t: &PastTurn<'_>, n: usize, now_ms: i64) -> String {
    let labels: Vec<&str> = t.activity.iter().filter_map(act_label).collect();
    let acts = &labels[labels.len().saturating_sub(LIVE_ACTS)..];
    let said = t.activity.iter().rev().find_map(|a| match a {
        Activity::Text { text } => Some(text.as_str()),
        _ => None,
    });
    let files: Vec<String> = t.files.iter().map(|f| format!("`{f}`")).collect();
    let parts = [
        format!(
            "### Turn {n} · {} · still running (started {} min ago)",
            t.name,
            minutes_since(now_ms, t.turn.started_at)
        ),
        format!("**User:** {}", text_mentions(&t.turn.prompt)),
        if acts.is_empty() {
            String::new()
        } else {
            let lines: Vec<String> = acts.iter().map(|a| format!("- {}", clip(a, 160))).collect();
            format!(
                "**What it has done so far (oldest first):**\n{}",
                lines.join("\n")
            )
        },
        if files.is_empty() {
            String::new()
        } else {
            format!("**Files it edited so far:** {}", files.join(", "))
        },
        match said.filter(|s| !s.is_empty()) {
            Some(s) => format!("**Its latest message:** {}", truncate(s, 1200)),
            None => String::new(),
        },
    ];
    join_some(&parts, "\n\n")
}

/// What the task has been doing, for a run that can't fork: earlier turns, and the latest one's
/// actions so far.
pub fn btw_digest(turns: &[PastTurn<'_>], now_ms: i64, render: Render<'_>) -> String {
    let from = turns.len().saturating_sub(DIGEST_TURNS);
    let mut parts: Vec<String> = Vec::with_capacity(DIGEST_TURNS + 1);
    if from > 0 {
        parts.push(format!(
            "_{from} earlier turn{} left out._",
            if from > 1 { "s" } else { "" }
        ));
    }
    for (i, t) in turns.iter().enumerate().skip(from) {
        parts.push(if t.turn.status == TurnStatus::Running {
            running_text(t, i + 1, now_ms)
        } else {
            turn_text(t, i + 1, render)
        });
    }
    parts.join("\n\n")
}

/// The side question's prompt. `forked`: the run resumes a copy of the conversation, so it already
/// knows the task.
pub fn btw_prompt(
    turns: &[PastTurn<'_>],
    question: &str,
    forked: bool,
    now_ms: i64,
    render: Render<'_>,
) -> String {
    let head = rules(forked);
    if forked {
        return format!("{head}\n\n## Side question\n\n{question}");
    }
    format!(
        "{head}\n\n## The task so far\n\n{}\n\n---\n\n## Side question\n\n{question}",
        btw_digest(turns, now_ms, render)
    )
}

/// The reply as markdown. `rendered`: the reply's wisp block as markdown (its notes and blocks), when
/// the agent ended with one anyway; None when the parse fell back to the text.
pub fn btw_answer(text: &str, rendered: Option<&str>) -> String {
    let md = rendered.map_or_else(|| trim(text).to_owned(), str::to_owned);
    if md.is_empty() {
        "_No answer._".to_owned()
    } else {
        md
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minutes_round_as_v1_did() {
        assert_eq!(minutes_since(0, 0), 1);
        assert_eq!(minutes_since(89_999, 0), 1);
        assert_eq!(minutes_since(90_000, 0), 2);
        assert_eq!(minutes_since(180_000, 0), 3);
        assert!(BTW_CMD.get().is_some());
    }
}
