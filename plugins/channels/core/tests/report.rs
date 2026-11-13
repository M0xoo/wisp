//! What a channel hears about a task (v1 test/remote.test.js "message", "heldUp"; channel.test.js "waiting").
#![allow(clippy::unwrap_used, clippy::needless_pass_by_value)]

use serde_json::json;
use wisp_channels_api::policy::Seen;
use wisp_channels_api::views::{ActionKind, AskView, Permission, SessionView, TurnView};
use wisp_channels_core::report::{Report, message, report_kind, up_of};

fn task() -> SessionView {
    SessionView { id: "s1".into(), title: "Fix login".into(), ..SessionView::default() }
}

fn turned(blocks: serde_json::Value, status: &str) -> SessionView {
    SessionView {
        turns: vec![TurnView {
            id: "t1".into(),
            status: status.into(),
            presentation: Some(json!({ "blocks": blocks })),
            ..TurnView::default()
        }],
        ..task()
    }
}

#[test]
fn an_asks_options_are_answer_buttons_under_the_project_and_task() {
    let s = SessionView {
        ask: Some(AskView {
            id: "a1".into(),
            question: Some("Which db?".into()),
            options: vec!["pg".into(), "sqlite".into()],
            context: Some("x".repeat(900)),
            ..AskView::default()
        }),
        ..task()
    };
    let m = message(&s, Some("api"), None);
    assert_eq!(m.title, "❓ api: Fix login");
    assert!(m.text.starts_with("Which db?\n\n") && m.text.chars().count() < 620, "the context cut to 600");
    assert_eq!(
        m.actions.iter().map(|a| (a.label.as_str(), a.kind, a.reference.as_str(), a.index)).collect::<Vec<_>>(),
        [("pg", ActionKind::Answer, "a1", 0), ("sqlite", ActionKind::Answer, "a1", 1)]
    );
}

#[test]
fn a_finished_turn_reads_its_hero_and_its_question_options_are_reply_buttons() {
    let s = turned(
        json!([{ "type": "hero", "title": "Login fixed", "summary": "Token refresh now retries.", "status": "done" }, { "type": "question", "question": "Ship it?", "options": [{ "label": "Open a PR", "reply": "open a PR" }, "Not yet"] }]),
        "done",
    );
    let m = message(&s, None, Some("ignored: the hero wins"));
    assert_eq!(m.title, "✅ Fix login");
    assert_eq!(m.text, "Login fixed\n\nToken refresh now retries.\n\nShip it?");
    assert_eq!(
        m.actions.iter().map(|a| (a.label.as_str(), a.kind, a.reference.as_str())).collect::<Vec<_>>(),
        [("Open a PR", ActionKind::Reply, "t1"), ("Not yet", ActionKind::Reply, "t1")]
    );
}

#[test]
fn no_hero_the_preview_then_the_answer_text_then_ready_for_review_and_one_mark_done() {
    let m = message(&turned(json!([{ "type": "markdown", "text": "It's 42." }]), "done"), None, Some(""));
    assert_eq!((m.title.as_str(), m.text.as_str()), ("📝 Fix login", "It's 42."));
    assert_eq!(m.actions.iter().map(|a| (a.label.as_str(), a.kind)).collect::<Vec<_>>(), [("Mark done", ActionKind::Done)]);
    assert_eq!(message(&turned(json!([]), "done"), None, Some("first line")).text, "first line");
    let e = message(&turned(json!([]), "error"), None, None);
    assert_eq!((e.title.as_str(), e.text.as_str()), ("⛔ Fix login", "Ready for review."));
    let same = message(&turned(json!([{ "type": "hero", "title": "Fix login", "status": "partial" }]), "done"), None, None);
    assert_eq!(
        (same.title.as_str(), same.text.as_str()),
        ("🟡 Fix login", "Ready for review."),
        "a hero title like the task's isn't said twice"
    );
}

#[test]
fn an_ask_only_wisp_can_answer_goes_up_to_the_task_a_subagent_side_or_crew_job_came_from() {
    assert_eq!(up_of(&SessionView { parent_id: Some("p".into()), ..task() }).as_deref(), Some("p"));
    assert_eq!(up_of(&SessionView { side_of: Some(json!({ "id": "q" })), ..task() }).as_deref(), Some("q"));
    assert_eq!(up_of(&SessionView { crew: Some(json!({ "job": "delegated", "from": { "id": "r" } })), ..task() }).as_deref(), Some("r"));
    assert_eq!(up_of(&SessionView { crew: Some(json!({ "job": "queued", "from": { "id": "r" } })), ..task() }), None);
    assert_eq!(up_of(&task()), None);
}

#[test]
fn a_channel_task_that_stalls_on_an_approval_says_so_once_where_it_cant_be_approved() {
    let perm = AskView {
        id: "a1".into(),
        permission: Some(Permission { action: Some("edit src/a.ts".into()), ..Permission::default() }),
        ..AskView::default()
    };
    let s = SessionView { ask: Some(perm.clone()), ..task() };
    let mut said = Seen::default();
    assert_eq!(report_kind("slack", &s, &mut said, false), Report::Waiting("Waiting for your OK in wisp: edit src/a.ts".into()));
    assert_eq!(report_kind("slack", &s, &mut said, false), Report::Quiet, "said once");
    let next = SessionView { ask: Some(AskView { id: "a2".into(), ..perm }), ..task() };
    assert_eq!(
        report_kind("github", &next, &mut Seen::default(), true),
        Report::Waiting("Waiting for your OK in wisp.".into()),
        "a public repo: nothing of the ask"
    );
    assert_eq!(report_kind("telegram", &next, &mut Seen::default(), false), Report::Full, "Telegram's buttons approve");
    let question = SessionView { ask: Some(AskView { id: "a3".into(), question: Some("Which?".into()), ..AskView::default() }), ..task() };
    assert_eq!(report_kind("slack", &question, &mut Seen::default(), false), Report::Full, "a question is answered in the thread");
}
