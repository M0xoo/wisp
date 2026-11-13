//! How a turn ends and where its task lands (v1 runner.js `#finishTurn`, `settle`, `skipHeld`). Pure: the
//! host gathers the facts (is a follow-up waiting, does an after-turn step want it, does a lead still wait
//! on delegates) and applies the answer in one transaction.
//!
//! The rules: a stopped turn says Interrupted when a follow-up replaced it, else Stopped; a failed one
//! shows the harness's error; a follow-up about to start keeps the task in Working (no flash through Needs
//! you, no notification); a lead whose delegates still work stays in Working, unread and unannounced; an
//! after-turn step (Auto's check, a goal round) holds it in Working; a compaction is housekeeping and puts
//! the task back where it was; a quiet outcome files it under Done; a subagent reports to its lead, never
//! to the user.

use serde_json::{Value, json};
use wisp_runtime_api::harness::HarnessStats;
use wisp_runtime_api::model::{
    ChangeOp, FileChange, Presentation, SessionState, TurnStats, TurnStatus,
};
use wisp_runtime_api::points::Outcome;

/// What ended the turn.
#[derive(Debug, Clone, PartialEq)]
pub struct Ending<'a> {
    pub stopped: bool,
    /// stopped because a follow-up interrupted it
    pub interrupted: bool,
    pub is_error: bool,
    pub text: &'a str,
    /// the harness's display name ("Claude Code")
    pub harness: &'a str,
    pub changes: &'a [FileChange],
    /// a stop's own words (a restart), instead of "You stopped this run"
    pub reason: Option<(&'a str, &'a str)>,
}

fn clip_chars(s: &str, n: usize) -> String {
    if s.chars().count() > n {
        format!("{}…", s.chars().take(n - 1).collect::<String>())
    } else {
        s.to_owned()
    }
}

/// The first non-blank line of an error, at most 200 characters (v1 `firstLine`).
pub fn first_line(text: &str) -> String {
    let line = text
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    clip_chars(&line, 200)
}

fn files_block(changes: &[FileChange]) -> Option<Value> {
    (!changes.is_empty()).then(|| {
        let items: Vec<Value> = changes.iter().map(|c| json!({ "path": c.file, "change": if c.op == ChangeOp::Add { "added" } else { "modified" } })).collect();
        json!({ "type": "files", "items": items })
    })
}

fn hero(title: &str, summary: &str, status: &str) -> Value {
    json!({ "type": "hero", "title": title, "summary": summary, "status": status })
}

fn shown(blocks: Vec<Value>) -> Presentation {
    Presentation {
        blocks,
        v: crate::blocks::PARSER_VERSION,
        ..Presentation::default()
    }
}

/// The turn's status and what it shows. `answer`: the parsed answer (`blocks::presentation`), used when
/// the run finished well.
pub fn end_presentation(
    e: &Ending<'_>,
    answer: impl FnOnce(&str) -> Presentation,
) -> (TurnStatus, Presentation) {
    if e.stopped {
        let (title, summary) = if e.interrupted {
            (
                "Interrupted",
                "You sent a follow-up while this was running, so it picked that up instead.",
            )
        } else {
            e.reason.unwrap_or((
                "Stopped",
                "You stopped this run. Follow up to pick it back up.",
            ))
        };
        let mut blocks = vec![hero(title, summary, "partial")];
        blocks.extend(files_block(e.changes));
        return (TurnStatus::Stopped, shown(blocks));
    }
    if e.is_error {
        let summary = first_line(e.text);
        let summary = if summary.is_empty() {
            "It ended without saying why.".to_owned()
        } else {
            summary
        };
        let name = if e.harness.is_empty() {
            "This harness"
        } else {
            e.harness
        };
        let blocks = vec![
            hero(&format!("{name} failed"), &summary, "blocked"),
            json!({ "type": "terminal", "output": if e.text.is_empty() { "No output." } else { e.text }, "exitCode": 1 }),
            json!({ "type": "next", "items": ["Try again", "Explain what went wrong"] }),
        ];
        return (TurnStatus::Error, shown(blocks));
    }
    (TurnStatus::Done, answer(e.text))
}

/// The first answer names the task after what was asked (its hero's topic, else the block's topic), never
/// after what the agent did. The host applies it on the first turn only, to a title wisp made.
pub fn topic_title(p: &Presentation) -> Option<String> {
    let hero_topic = p
        .blocks
        .iter()
        .find(|b| b.get("type").and_then(Value::as_str) == Some("hero"))
        .and_then(|h| h.get("topic"))
        .and_then(Value::as_str);
    let t = [hero_topic, p.topic.as_deref()]
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|t| !t.is_empty())?;
    Some(clip_chars(t, 64))
}

/// v1 `autoTitle(prompt)`: the prompt's first line, whitespace collapsed, at most 64 characters.
pub fn auto_title(prompt: &str) -> String {
    let line = prompt
        .trim()
        .lines()
        .next()
        .unwrap_or("")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    clip_chars(&line, 64)
}

/// v1's result stats as the turn's.
pub fn turn_stats(s: &HarnessStats) -> TurnStats {
    let cache = match (s.cache_read_tokens, s.cache_write_tokens) {
        (None, None) => None,
        (read, write) => Some(read.unwrap_or(0) + write.unwrap_or(0)),
    };
    // a map by model, or Claude's list of `{model, input, output, cacheRead, cacheWrite}` keyed by its model
    let models = match s.extra.get("models") {
        Some(Value::Object(m)) => Some(m.iter().map(|(k, v)| (k.clone(), v.clone())).collect()),
        Some(Value::Array(a)) => Some(
            a.iter()
                .filter_map(|m| Some((m.get("model")?.as_str()?.to_owned(), m.clone())))
                .collect(),
        ),
        _ => None,
    };
    let whole = |k: &str| {
        s.extra
            .get(k)
            .and_then(Value::as_f64)
            .filter(|x| x.is_finite() && *x >= 0.0)
            .map(|x| {
                #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)] // finite, ≥ 0, token counts
                let n = x.round() as u64;
                n
            })
    };
    TurnStats {
        cost_usd: s.cost_usd,
        input_tokens: s.input_tokens,
        output_tokens: s.output_tokens,
        cache_tokens: cache,
        ms: s.duration_ms,
        models,
        context_tokens: whole("contextTokens"),
        context_window: whole("contextWindow").filter(|n| *n > 0),
        cache_ttl_ms: whole("cacheTtlMs"),
        subagents: subagents_of(s.extra.get("subagents"), true),
    }
}

/// A harness's `stats.subagents` (`[{ type, calls, read, output, model }]`), read leniently: a row without a type or a
/// call is dropped. `split` false: the turn's per-model counts may hold the whole conversation (a v1 turn from before
/// `stats.totals`), so its subagents' output isn't theirs alone and reads as unknown (v1 `subagentOutput`).
pub fn subagents_of(v: Option<&Value>, split: bool) -> Vec<wisp_runtime_api::model::SubagentStat> {
    let whole = |x: Option<&Value>| {
        x.and_then(Value::as_f64).filter(|x| x.is_finite() && *x > 0.0).map_or(0, |x| {
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)] // finite, > 0: a count
            let n = x.round() as u64;
            n
        })
    };
    v.and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|x| {
                    let kind = x.get("type").and_then(Value::as_str).filter(|k| !k.is_empty())?;
                    let calls = u32::try_from(whole(x.get("calls"))).unwrap_or(u32::MAX);
                    (calls > 0).then(|| wisp_runtime_api::model::SubagentStat {
                        kind: kind.to_owned(),
                        calls,
                        read: whole(x.get("read")),
                        output: if split { whole(x.get("output")) } else { 0 },
                        model: x.get("model").and_then(Value::as_str).unwrap_or_default().to_owned(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The facts the host gathers once a turn ended.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[allow(clippy::struct_excessive_bools)] // the facts v1's #finishTurn weighs, one for one
pub struct Facts {
    pub stopped: bool,
    pub interrupted: bool,
    /// the run still holds the task and a follow-up waits (not held by a Stop)
    pub follow_up_waits: bool,
    /// delegates it sent off still work (a lead only)
    pub owes: bool,
    /// a compaction turn
    pub compact: bool,
    /// a compaction that finished and knows where the task was
    pub compact_back: bool,
    /// a subagent, or a delegated run for a lead elsewhere: reports to its lead
    pub sub: bool,
    /// the task is being deleted
    pub deleting: bool,
    /// at a usage limit, waiting for the reset
    pub waits_reset: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(clippy::struct_excessive_bools)] // where a task lands, as v1's #finishTurn set it
pub struct Landing {
    pub state: SessionState,
    pub unread: bool,
    /// publish `turn.finished` (notify, crew record, judge)
    pub notify: bool,
    /// a follow-up starts as soon as the run lets go
    pub handing: bool,
    /// filed quietly (archived when the outcome says so)
    pub quiet: bool,
    pub archive: bool,
    /// parked in For later
    pub for_later: bool,
    /// the after-turn step that holds the task, to run now
    pub run_after: Option<String>,
}

/// Where the task lands. `after`: the first `runtime.after@1` step that wants this turn (asked only when
/// nothing else holds the task).
pub fn land(f: Facts, outcome: Outcome, after: impl FnOnce() -> Option<String>) -> Landing {
    let handing = f.interrupted || f.follow_up_waits;
    let owes = !f.stopped && !handing && f.owes;
    let run_after = if handing || owes || f.compact {
        None
    } else {
        after()
    };
    let busy = run_after.is_some() || owes || handing;
    let waits = f.waits_reset && !busy;
    let quiet = ((outcome.quiet || outcome.filed) && !busy) || waits || f.compact_back;
    let for_later = outcome.later && !quiet && !busy && !outcome.filed;
    let (state, unread) = if quiet {
        (SessionState::Done, false)
    } else if busy {
        (SessionState::Running, false)
    } else {
        (SessionState::Review, true)
    };
    let notify = !busy && !quiet && !for_later && !f.sub && !f.deleting;
    Landing {
        state,
        unread,
        notify,
        handing,
        quiet,
        archive: outcome.quiet && !busy,
        for_later,
        run_after,
    }
}

/// v1 `settle`: an after-turn step is done with the task it held. `after`: a step that wants it next.
/// None: a turn still runs, nothing to land.
pub fn settle(
    still_running: bool,
    quiet: bool,
    sub: bool,
    after: impl FnOnce() -> Option<String>,
) -> Option<Landing> {
    if still_running {
        return None;
    }
    let base = Landing {
        state: SessionState::Review,
        unread: !quiet,
        notify: !quiet && !sub,
        handing: false,
        quiet,
        archive: false,
        for_later: false,
        run_after: None,
    };
    if !quiet && let Some(id) = after() {
        return Some(Landing {
            state: SessionState::Running,
            unread: false,
            notify: false,
            run_after: Some(id),
            ..base
        });
    }
    Some(base)
}

/// Skip this run (a held turn): it stays, stopped, saying what was skipped.
pub fn skipped(held_kind: &str, label: &str, harness: &str) -> Presentation {
    let why = match held_kind {
        "project" => "This repo’s hooks, servers or setup weren’t trusted.".to_owned(),
        "harness" => format!("{harness} had changed and wasn’t trusted."),
        _ => format!("{label} window was near its limit."),
    };
    shown(vec![hero("Skipped before it started", &why, "info")])
}
