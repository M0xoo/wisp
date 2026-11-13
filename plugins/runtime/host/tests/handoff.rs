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
