//! A follow-up handed to another harness (v1 handoff.js, CHANGELOG 0.57.0, F-comp-27): the turns it missed go ahead
//! of the prompt, opening with *What still holds* (the user's rules), and the task keeps its thinking level as the new
//! harness names it, unless the switch picked one. The turn keeps the user's own words.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::{Fake, rig_on, until};
use wisp_runtime::Recorder;
use wisp_runtime_api::commands::{FollowUpArgs, RunPick, StartArgs};
use wisp_runtime_api::model::TurnStatus;

#[tokio::test(flavor = "multi_thread")]
async fn a_hand_off_to_another_harness_keeps_the_users_rules_and_effort_v1_handoff() {
    let r = rig_on(
        Recorder::default(),
        vec![
            Fake::named("fake", "Fake CLI", &["low", "high", "max"]),
            Fake::named("other", "Other CLI", &["low", "medium", "high", "xhigh"]),
        ],
    )
    .await;
    let start = StartArgs {
        prompt: "fix the login. Don't touch the migrations.".into(),
        agent: Some("fake".into()),
        effort: Some("max".into()),
        cwd: Some("/tmp".into()),
        ..StartArgs::default()
    };
    let id = r.rt.create(start).await.unwrap().id;
    let done = |n: usize| {
        let (rt, id) = (r.rt.clone(), id.0.clone());
        async move { rt.turns(&id, None, None).await.unwrap().iter().filter(|t| t.status == TurnStatus::Done).count() == n }
    };
    until("the first turn", || done(1)).await;
    let run = RunPick { agent: Some("other".into()), ..RunPick::default() };
    r.rt.follow_up(FollowUpArgs { id: id.clone(), text: "now the signup page".into(), run: Some(run), ..FollowUpArgs::default() })
        .await
        .unwrap();
    until("the hand-off turn", || done(2)).await;
    let sent = &r.sim.spawned()[1].args[0];
    assert!(sent.contains("### What still holds") && sent.contains("- Don't touch the migrations."), "{sent}");
    assert!(sent.contains("### Turn 1 · Fake CLI") && sent.ends_with("now the signup page"), "{sent}");
    let s = r.rt.get(id.as_str()).await.unwrap();
    assert_eq!(
        (s.agent.as_str(), s.effort.as_str(), s.model.as_str()),
        ("other", "xhigh", ""),
        "max → xhigh, its highest; not the old model"
    );
    let last = r.rt.turns(id.as_str(), None, Some(1)).await.unwrap().pop().unwrap();
    assert_eq!((last.prompt.as_str(), last.effort.as_str()), ("now the signup page", "xhigh"), "the turn keeps your words");
    // the same harness again: it has seen it all, nothing goes ahead
    r.rt.follow_up(FollowUpArgs { id: id.clone(), text: "and the tests".into(), ..FollowUpArgs::default() }).await.unwrap();
    until("the third turn", || done(3)).await;
    assert_eq!(r.sim.spawned()[2].args[0], "and the tests");
    // a level picked with the switch wins
    let pick = RunPick { agent: Some("fake".into()), effort: Some("low".into()), ..RunPick::default() };
    r.rt.follow_up(FollowUpArgs { id: id.clone(), text: "back".into(), run: Some(pick), ..FollowUpArgs::default() }).await.unwrap();
    until("the fourth turn", || done(4)).await;
    assert_eq!(r.rt.get(id.as_str()).await.unwrap().effort, "low");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_hand_off_note_never_quotes_a_env_value_the_task_read_adr_0050() {
    let r = rig_on(Recorder::default(), vec![Fake::named("fake", "Fake CLI", &["low"]), Fake::named("other", "Other CLI", &["low"])]).await;
    let start = StartArgs {
        prompt: "envread and keep sk-live-handoff. Don't touch the key sk-live-handoff.".into(),
        agent: Some("fake".into()),
        cwd: Some("/tmp".into()),
        ..StartArgs::default()
    };
    let id = r.rt.create(start).await.unwrap().id;
    let done = |n: usize| {
        let (rt, id) = (r.rt.clone(), id.0.clone());
        async move { rt.turns(&id, None, None).await.unwrap().iter().filter(|t| t.status == TurnStatus::Done).count() == n }
    };
    until("the first turn", || done(1)).await;
    let run = RunPick { agent: Some("other".into()), ..RunPick::default() };
    r.rt.follow_up(FollowUpArgs { id: id.clone(), text: "carry on".into(), run: Some(run), ..FollowUpArgs::default() }).await.unwrap();
    until("the hand-off turn", || done(2)).await;
    let sent = &r.sim.spawned()[1].args[0];
    assert!(sent.contains("### Turn 1 · Fake CLI") && sent.contains("### What still holds"), "a note went ahead: {sent}");
    assert!(!sent.contains("sk-live-handoff"), "the other harness's prompt quoted a .env value: {sent}");
    assert!(sent.contains("The key is ••••."), "masked, not dropped: {sent}");
    let last = r.rt.turns(id.as_str(), None, Some(1)).await.unwrap().pop().unwrap();
    assert!(!last.prompt.contains("sk-live-handoff"), "the stored turn: {}", last.prompt);
}

/// ADR-0050: a /btw on a harness that can't fork has no copy of the conversation, so it builds no context from the
/// task's steps: its prompt is the question alone (never `btw_prompt`'s digest or raw step text), and what it stores
/// on the task (`ext.wisp.runtime.btw`) holds the question and its own answer, nothing an earlier turn read.
#[tokio::test(flavor = "multi_thread")]
async fn a_btw_without_a_fork_sends_only_its_question_and_stores_no_earlier_step_text_adr_0050() {
    use wisp_runtime_api::commands::BtwArgs;
    let r = rig_on(Recorder::default(), vec![Fake::named("fake", "Fake CLI", &["low"])]).await;
    let start = StartArgs { prompt: "envread it".into(), agent: Some("fake".into()), cwd: Some("/tmp".into()), ..StartArgs::default() };
    let id = r.rt.create(start).await.unwrap().id;
    until("the first turn", || {
        let (rt, id) = (r.rt.clone(), id.0.clone());
        async move { rt.turns(&id, None, None).await.unwrap().iter().any(|t| t.status == TurnStatus::Done) }
    })
    .await;
    let raw = r.rt.activity(&r.rt.turns(id.as_str(), None, None).await.unwrap()[0].id.0, None).await.unwrap();
    assert!(serde_json::to_string(&raw).unwrap().contains("sk-live-handoff"), "the task did read the value");

    r.rt.btw(BtwArgs { id: id.clone(), question: "why?".into(), attachments: Vec::new() }).await.unwrap();
    until("the /btw to spawn", || async { r.sim.spawned().len() == 2 }).await;
    let args = &r.sim.spawned()[1].args;
    assert_eq!(args[0], "why?", "the question alone: {args:?}");
    assert!(!args.iter().any(|a| a.starts_with("--resume")), "no fork, no conversation: {args:?}");
    assert!(args.iter().all(|a| !a.contains("sk-live") && !a.contains("What it has done so far")), "{args:?}");

    let btw = || {
        let (rt, id) = (r.rt.clone(), id.0.clone());
        async move { rt.get(&id).await.unwrap().ext["wisp.runtime"]["btw"][0].clone() }
    };
    until("the /btw answer", || async { btw().await.get("pending").is_none() }).await;
    let entry = btw().await;
    assert_eq!(entry["question"], "why?");
    assert!(entry["answer"].as_str().unwrap().contains("done: why?"), "{entry}");
    let stored = serde_json::to_string(&r.rt.get(id.as_str()).await.unwrap()).unwrap();
    assert!(!stored.contains("sk-live-handoff"), "the stored task quoted a .env value: {stored}");
}
