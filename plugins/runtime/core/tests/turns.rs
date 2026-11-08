//! A turn's life in pure code: harness events → transcript and head (v1 runner.js `#onEvent`, `stepOf`,
//! `clipOutput`), how it ends and where the task lands (`#finishTurn`, `settle`, `skipHeld`), the list row
//! (`summarize`), event upcasters, and the v1 session file round trip (plan §4.8).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#![recursion_limit = "256"]

use std::collections::BTreeMap;

use serde_json::{Value, json};
use wisp_runtime_api::harness::{HarnessChangeOp, HarnessEvent};
use wisp_runtime_api::model::{
    Activity, ChangeOp, Edit, Presentation, Session, SessionState, ToolKind, Turn, TurnStatus,
};
use wisp_runtime_api::points::Outcome;
use wisp_runtime_core::activity::{self, Effect, Head, MAX_OUTPUT};
use wisp_runtime_core::land::{self, Ending, Facts};
use wisp_runtime_core::summary::{RowFacts, summarize};
use wisp_runtime_core::{blocks, import, upcast};

fn ev(v: Value) -> HarnessEvent {
    HarnessEvent::from_v1(v).unwrap()
}

fn fallback(t: &str) -> bool {
    blocks::parse(t).fallback
}

fn apply(h: &mut Head, v: Value) -> Effect {
    activity::apply(h, &ev(v), false, &fallback)
}

#[test]
fn v1_event_json_reads_as_the_contract() {
    for v in [
        json!({"type":"session","id":"abc"}),
        json!({"type":"tool","kind":"run","label":"npm test","detail":"npm test","id":"c1"}),
        json!({"type":"tool_error","name":"Bash","text":"exit 1","id":"c1"}),
        json!({"type":"change","file":"a.ts","op":"create","edits":[{"before":"","after":"x"}],"beforeFile":null}),
        json!({"type":"limits","windows":[{"id":"5h","used":0.4,"resetsAt":1.7e12,"ms":null}],"rejected":"5h","complete":true}),
        json!({"type":"result","text":"done","isError":false,"stats":{"costUsd":0.01,"durationMs":1200,"totals":{"x":1}},"background":0}),
    ] {
        let e = ev(v.clone());
        assert_eq!(
            HarnessEvent::from_v1(serde_json::to_value(&e).unwrap()).unwrap(),
            e,
            "{v}"
        );
    }
}

#[test]
fn tool_calls_text_and_failures_become_steps() {
    let mut h = Head::default();
    let e = apply(
        &mut h,
        json!({"type":"tool","kind":"run","label":"Run tests","id":"c1","output":"ok"}),
    );
    assert!(
        matches!(e, Effect::Append(Activity::Tool { tool: ToolKind::Run, ref call_id, output: Some(_), .. }) if call_id.as_deref() == Some("c1"))
    );
    // a read's output isn't shown (it is the file)
    let e = apply(
        &mut h,
        json!({"type":"tool","kind":"read","label":"Read a.ts","output":"…"}),
    );
    assert!(matches!(
        e,
        Effect::Append(Activity::Tool { output: None, .. })
    ));
    assert_eq!(
        apply(&mut h, json!({"type":"tool_error","text":"boom"})),
        Effect::Append(Activity::ToolError {
            name: "Tool".into(),
            text: "boom".into()
        })
    );
    apply(&mut h, json!({"type":"text","text":"hello"}));
    assert_eq!(h.text.as_deref(), Some("hello"));
    apply(&mut h, json!({"type":"session","id":"conv"}));
    assert_eq!(h.resume_id.as_deref(), Some("conv"));
}

#[test]
fn long_output_keeps_its_first_and_last_lines() {
    let text = (0..400)
        .map(|i| format!("line {i}\n"))
        .collect::<Vec<_>>()
        .concat();
    let out = activity::clip_output(&text);
    assert!(out.encode_utf16().count() < MAX_OUTPUT);
    assert!(out.starts_with("line 0\n") && out.ends_with("line 399"));
    assert!(out.contains(" lines cut …"));
    assert_eq!(activity::clip_output("short\n\n"), "short");
}

#[test]
fn changes_merge_per_file_and_blocked_actions_dedupe() {
    let mut h = Head::default();
    for (op, after) in [("create", "a"), ("edit", "b")] {
        apply(
            &mut h,
            json!({"type":"change","file":"x.ts","op":op,"edits":[{"before":"","after":after}]}),
        );
    }
    assert_eq!(
        (h.changes.len(), h.changes[0].op, h.changes[0].edits.len()),
        (1, ChangeOp::Add, 2)
    );
    assert_eq!(HarnessChangeOp::Write.normalised(), ChangeOp::Modify);
    for _ in 0..2 {
        apply(
            &mut h,
            json!({"type":"blocked","tool":"Bash","detail":"npm publish","rule":"Bash(npm publish)"}),
        );
    }
    assert_eq!(h.blocked.len(), 1);
}

#[test]
fn a_plain_text_result_with_background_tasks_keeps_the_turn_open() {
    let mut h = Head::default();
    apply(&mut h, json!({"type":"background","tasks":["dev server"]}));
    let e = apply(
        &mut h,
        json!({"type":"result","text":"I'll report once it's done","isError":false,"background":1}),
    );
    assert!(
        matches!(e, Effect::Waiting(Activity::Tool { tool: ToolKind::Background, ref label, .. }) if label == "Waiting on background task: dev server")
    );
    let e = apply(
        &mut h,
        json!({"type":"result","text":"all done","isError":false}),
    );
    assert!(matches!(e, Effect::Finish { ref text, .. } if text == "all done"));
    // a full presentation with something left up is a finished task
    let full = "```wisp\n{\"blocks\":[{\"type\":\"hero\",\"title\":\"Up\"}]}\n```";
    assert!(matches!(
        apply(
            &mut Head::default(),
            json!({"type":"result","text":full,"isError":false,"background":1})
        ),
        Effect::Finish { .. }
    ));
}

#[test]
fn a_run_that_exits_without_a_result_ends_with_the_interim_or_an_error() {
    let mut h = Head {
        interim: Some(("so far".into(), None)),
        ..Head::default()
    };
    assert!(
        matches!(activity::exit_without_result(&mut h), Effect::Finish { ref text, is_error: false, .. } if text == "so far")
    );
    assert!(matches!(
        activity::exit_without_result(&mut h),
        Effect::Finish { is_error: true, .. }
    ));
}

fn ending(stopped: bool, interrupted: bool, is_error: bool, text: &str) -> Ending<'_> {
    Ending {
        stopped,
        interrupted,
        is_error,
        text,
        harness: "Claude Code",
        changes: &[],
        reason: None,
    }
}

#[test]
fn a_turn_ends_stopped_interrupted_failed_or_done() {
    let parse = |t: &str| blocks::presentation(t, &[]);
    let (s, p) = land::end_presentation(&ending(true, false, false, ""), parse);
    assert_eq!(
        (s, p.blocks[0]["title"].as_str()),
        (TurnStatus::Stopped, Some("Stopped"))
    );
    assert_eq!(
        land::end_presentation(&ending(true, true, false, ""), parse)
            .1
            .blocks[0]["title"],
        "Interrupted"
    );
    let (s, p) = land::end_presentation(
        &ending(false, false, true, "\n  Error: rate limited\nmore"),
        parse,
    );
    assert_eq!(s, TurnStatus::Error);
    assert_eq!(
        (
            p.blocks[0]["title"].as_str(),
            p.blocks[0]["summary"].as_str()
        ),
        (Some("Claude Code failed"), Some("Error: rate limited"))
    );
    let (s, p) = land::end_presentation(&ending(false, false, false, "plain answer"), parse);
    assert!(s == TurnStatus::Done && p.fallback);
}

#[test]
fn the_first_answer_names_the_task_after_its_topic_never_its_title() {
    let p = blocks::presentation(
        "```wisp\n{\"blocks\":[{\"type\":\"hero\",\"title\":\"Added X\",\"topic\":\" Rate limit \"}]}\n```",
        &[],
    );
    assert_eq!(land::topic_title(&p).as_deref(), Some("Rate limit"));
    let quick = blocks::presentation(
        "It is 42.\n\n```wisp\n{\"topic\":\"The answer\",\"blocks\":[]}\n```",
        &[],
    );
    assert_eq!(land::topic_title(&quick).as_deref(), Some("The answer"));
    assert_eq!(land::topic_title(&Presentation::default()), None);
    assert_eq!(land::auto_title("  fix   the\nlogin"), "fix the");
    assert_eq!(land::auto_title(&"x".repeat(80)).chars().count(), 64);
}

#[test]
fn where_a_task_lands() {
    let none = || None;
    let l = land::land(Facts::default(), Outcome::default(), none);
    assert_eq!(
        (l.state, l.unread, l.notify),
        (SessionState::Review, true, true)
    );
    // a follow-up about to start: Working, no notification, and no after-turn step is asked
    let l = land::land(
        Facts {
            follow_up_waits: true,
            ..Facts::default()
        },
        Outcome::default(),
        || panic!("not asked"),
    );
    assert_eq!(
        (l.state, l.unread, l.notify, l.handing),
        (SessionState::Running, false, false, true)
    );
    // a lead waiting on its delegates
    let l = land::land(
        Facts {
            owes: true,
            ..Facts::default()
        },
        Outcome::default(),
        none,
    );
    assert_eq!((l.state, l.notify), (SessionState::Running, false));
    // an after-turn step holds it
    let l = land::land(Facts::default(), Outcome::default(), || {
        Some("wisp.goal".into())
    });
    assert_eq!(
        (l.state, l.run_after.as_deref()),
        (SessionState::Running, Some("wisp.goal"))
    );
}

#[test]
fn where_a_task_lands_after_housekeeping_quiet_outcomes_and_settle() {
    let none = || None;
    // a compaction is housekeeping: never checked, quiet when it knows where the task was
    let l = land::land(
        Facts {
            compact: true,
            compact_back: true,
            ..Facts::default()
        },
        Outcome::default(),
        || panic!("not asked"),
    );
    assert!(l.quiet && !l.notify && l.state == SessionState::Done);
    // a quiet crew check-in is filed and archived; For later is parked unread, nobody pinged
    let l = land::land(
        Facts::default(),
        Outcome {
            quiet: true,
            ..Outcome::default()
        },
        none,
    );
    assert!(l.archive && !l.unread && !l.notify);
    let l = land::land(
        Facts::default(),
        Outcome {
            later: true,
            ..Outcome::default()
        },
        none,
    );
    assert!(l.for_later && l.unread && !l.notify);
    // a subagent reports to its lead, not to the user
    assert!(
        !land::land(
            Facts {
                sub: true,
                ..Facts::default()
            },
            Outcome::default(),
            none
        )
        .notify
    );
    // settle: a goal wants it next, or it lands
    assert!(land::settle(true, false, false, none).is_none());
    assert_eq!(
        land::settle(false, false, false, || Some("g".into()))
            .unwrap()
            .run_after
            .as_deref(),
        Some("g")
    );
    let l = land::settle(false, true, false, none).unwrap();
    assert!(!l.unread && !l.notify);
}

#[test]
fn a_skipped_held_turn_says_why() {
    assert_eq!(
        land::skipped("limit", "Claude 5-hour", "").blocks[0]["summary"],
        "Claude 5-hour window was near its limit."
    );
    assert_eq!(
        land::skipped("harness", "", "Codex").blocks[0]["summary"],
        "Codex had changed and wasn’t trusted."
    );
}

fn session() -> Session {
    Session {
        id: "s1".into(),
        title: "T".into(),
        agent: "claude".into(),
        cwd: "/p".into(),
        ..Session::default()
    }
}

fn done_turn(summary: &str, status: &str) -> Turn {
    let p = Presentation {
        blocks: vec![json!({"type":"hero","title":"x","summary":summary,"status":status})],
        v: 1,
        ..Presentation::default()
    };
    Turn {
        status: TurnStatus::Done,
        presentation: Some(p),
        ..Turn::default()
    }
}

#[test]
fn the_row_says_what_the_last_answer_said_and_what_runs_now() {
    let s = session();
    let none = BTreeMap::new;
    let done = done_turn("Added the limiter", "partial");
    let row = summarize(
        &s,
        &RowFacts {
            last: Some(&done),
            report: Some(&done),
            turn_count: 1,
            ..RowFacts::default()
        },
        none(),
    );
    assert_eq!(
        (row.status.as_str(), row.preview.as_str(), row.live.as_str()),
        ("partial", "Added the limiter", "")
    );
    let running = Turn {
        status: TurnStatus::Running,
        ..Turn::default()
    };
    let row = summarize(
        &s,
        &RowFacts {
            last: Some(&running),
            report: Some(&running),
            live_step: Some("Run tests"),
            ..RowFacts::default()
        },
        none(),
    );
    assert_eq!(
        (row.status.as_str(), row.live.as_str()),
        ("running", "Run tests")
    );
    let compact = Turn {
        status: TurnStatus::Running,
        by: Some("compact".into()),
        ..Turn::default()
    };
    assert_eq!(
        summarize(
            &s,
            &RowFacts {
                last: Some(&compact),
                ..RowFacts::default()
            },
            none()
        )
        .live,
        "Compacting"
    );
}

#[test]
fn the_row_says_who_a_lead_waits_on_what_it_asks_and_what_plugins_add() {
    let s = session();
    let none = BTreeMap::new;
    let done = done_turn("Added the limiter", "partial");
    let running = Turn {
        status: TurnStatus::Running,
        ..Turn::default()
    };
    let names = ["Ada".to_owned(), "Bo".to_owned(), "Ada".to_owned()];
    let row = summarize(
        &s,
        &RowFacts {
            last: Some(&done),
            report: Some(&done),
            waiting_on: &names,
            ..RowFacts::default()
        },
        none(),
    );
    assert_eq!(
        (row.status.as_str(), row.live.as_str()),
        ("running", "Waiting on Ada, Bo")
    );
    let opts = ["Yes".to_owned()];
    let row = summarize(
        &s,
        &RowFacts {
            last: Some(&running),
            ask: Some(("Ship it?", &opts, false)),
            ..RowFacts::default()
        },
        none(),
    );
    assert_eq!(row.live, "Asks: Ship it?");
    assert_eq!(row.fields["options"], json!(["Yes"]));
    let failed = Turn {
        status: TurnStatus::Error,
        ..Turn::default()
    };
    assert_eq!(
        summarize(
            &s,
            &RowFacts {
                last: Some(&failed),
                report: Some(&failed),
                ..RowFacts::default()
            },
            none()
        )
        .status,
        "blocked"
    );
    // contributed fields are flattened onto the row (v1 names)
    let row = summarize(
        &s,
        &RowFacts::default(),
        BTreeMap::from([("branch".to_owned(), json!("feat/x"))]),
    );
    assert_eq!(serde_json::to_value(&row).unwrap()["branch"], "feat/x");
}

#[test]
fn v1_activity_items_read_through_the_v0_upcaster_and_back() {
    let items = [
        json!({"t":1,"kind":"run","label":"npm test","detail":"npm test","call":"c1","output":"ok"}),
        json!({"t":2,"kind":"text","label":"hi"}),
        json!({"t":3,"kind":"error","label":"Bash failed: exit 1"}),
        json!({"t":4,"kind":"check","label":"Checking the tests","by":"wisp"}),
    ];
    let read: Vec<Activity> = items.iter().map(|i| upcast::read(0, i).unwrap()).collect();
    assert!(
        matches!(&read[0], Activity::Tool { tool: ToolKind::Run, call_id: Some(c), .. } if c == "c1")
    );
    assert_eq!(
        read[2],
        Activity::ToolError {
            name: "Bash".into(),
            text: "exit 1".into()
        }
    );
    assert!(matches!(&read[3], Activity::Notice { text, .. } if text == "Checking the tests"));
    for (a, i) in read.iter().zip(&items) {
        let mut back = upcast::to_v0(a);
        back["t"] = i["t"].clone();
        assert_eq!(&back, i);
        assert_eq!(
            upcast::read(1, &serde_json::to_value(a).unwrap()).as_ref(),
            Some(a)
        );
    }
}

fn v1_file() -> Value {
    json!({
        "id": "0036ab2aedd1", "title": "Fix login", "titleAuto": true, "agent": "claude", "model": "opus", "effort": "high",
        "mode": "edits", "cwd": "/repo", "state": "review", "unread": true, "createdAt": 1000, "updatedAt": 2000.0,
        "agentSessionId": "conv-1", "worktree": {"branch": "wisp/x", "cwd": "/wt"}, "goal": {"text": "green CI"},
        "queue": [{"id": "q1", "text": "and docs", "attachments": [], "mode": "plan"}], "queueHeld": true,
        "turns": [
            {"id": "t1", "prompt": "fix it", "agent": "claude", "model": "opus", "effort": "high", "mode": "edits", "attachments": [],
             "startedAt": 1000, "endedAt": 1500, "status": "done", "raw": "done", "stats": {"costUsd": 0.5, "inputTokens": 10, "cacheReadTokens": 3},
             "presentation": {"blocks": [{"type": "hero", "title": "Fixed", "status": "done"}]},
             "activity": [{"t": 1100, "kind": "edit", "label": "Edit a.ts", "file": "a.ts"}],
             "changes": [{"file": "a.ts", "op": "edit", "edits": [{"before": "a", "after": "b"}]}], "checkpoint": {"commit": "abc"}},
            {"id": "t2", "prompt": "more", "agent": "claude", "model": "opus", "effort": "high", "mode": "edits", "attachments": [],
             "startedAt": 1600, "endedAt": null, "status": "running", "activity": [], "changes": []}
        ]
    })
}

#[test]
fn a_v1_session_file_imports_1_to_1() {
    let i = import::from_v1(&v1_file()).unwrap();
    let s = &i.session;
    assert_eq!(
        (
            s.id.as_str(),
            s.title.as_str(),
            s.updated_at,
            s.resume_id.as_deref()
        ),
        ("0036ab2aedd1", "Fix login", 2000, Some("conv-1"))
    );
    assert!(s.queue_held && s.queue[0].opts.as_ref().unwrap()["mode"] == "plan");
    assert_eq!(
        s.ext["v1"]["worktree"]["branch"], "wisp/x",
        "other plugins' fields wait for their owner"
    );
    let t = &i.turns[0];
    assert_eq!(
        (t.turn.idx, t.turn.status, t.turn.changed_files),
        (0, TurnStatus::Done, Some(1))
    );
    assert_eq!(
        t.turn.presentation.as_ref().unwrap().v,
        0,
        "rebuilt lazily by the current parser"
    );
    assert_eq!(t.turn.stats.as_ref().unwrap().cache_tokens, Some(3));
    assert_eq!(t.steps.len(), 1);
    assert_eq!(
        t.changes[0].edits,
        vec![Edit {
            before: "a".into(),
            after: "b".into()
        }]
    );
    assert_eq!(t.turn.ext["v1"]["checkpoint"]["commit"], "abc");
    // a turn running when v1 stopped never finished
    assert_eq!(i.turns[1].turn.status, TurnStatus::Stopped);
    assert!(import::from_v1(&json!({"title": "no id"})).is_err());
}

#[test]
fn the_dual_write_gives_v1_its_file_back() {
    let file = v1_file();
    let back = import::to_v1(&import::from_v1(&file).unwrap());
    for k in [
        "id",
        "title",
        "agent",
        "cwd",
        "worktree",
        "goal",
        "agentSessionId",
        "queueHeld",
        "titleAuto",
    ] {
        assert_eq!(back[k], file[k], "{k}");
    }
    assert_eq!(back["queue"][0]["mode"], "plan");
    for k in [
        "id",
        "prompt",
        "raw",
        "activity",
        "checkpoint",
        "presentation",
    ] {
        assert_eq!(back["turns"][0][k], file["turns"][0][k], "turn {k}");
    }
    // import(export(x)) is a fixed point
    assert_eq!(import::to_v1(&import::from_v1(&back).unwrap()), back);
}
