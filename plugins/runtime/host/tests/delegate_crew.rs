//! A lead hands a job to a member of the crew (F-crew-11, v1 crew.js `#delegate`): `runtime.delegate` asks
//! `crew.assign` (typed, through the crew's api) with `from` = the lead, so the job runs as the member and the
//! lead's Team tab lists it; the delegation is kept on the lead so `subagent_results` reads its report.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::collections::BTreeMap;

use common::{rig_with, until};
use serde_json::json;
use wisp_runtime::Recorder;
use wisp_runtime_api::commands::{DelegateArgs, DelegateTask, StartArgs};
use wisp_runtime_api::model::TurnStatus;

fn lead(team: &serde_json::Value) -> StartArgs {
    let mut ext = BTreeMap::new();
    ext.insert("wisp.runtime".to_owned(), json!({ "subagents": team, "capped": { "mode": "edits" } }));
    StartArgs { prompt: "slow lead".into(), cwd: Some("/tmp".into()), ext, ..StartArgs::default() }
}

fn task(subagent: &str, prompt: &str) -> DelegateTask {
    DelegateTask { subagent: subagent.into(), prompt: prompt.into() }
}

#[tokio::test(flavor = "multi_thread")]
async fn delegating_to_a_crew_member_assigns_the_job_through_crew_with_the_lead_as_from() {
    let mut answers = BTreeMap::new();
    answers.insert(
        "crew.assign".to_owned(),
        json!({ "session": { "id": "studio|job-1", "agent": "claude", "model": "opus", "effort": "high", "state": "running" } }),
    );
    let r = rig_with(Recorder { answers, ..Recorder::default() }).await;
    let team = json!([
        { "name": "ada", "label": "Ada", "agent": "auto", "crew": "crew-ada" },
        { "name": "far", "agent": "fake", "machine": "studio" },
    ]);
    let made = r.rt.create(lead(&team)).await.unwrap();
    let id = made.id.clone();
    until("the lead runs", || async {
        r.rt.turns(id.as_str(), None, Some(1)).await.unwrap().pop().is_some_and(|t| t.status == TurnStatus::Running)
    })
    .await;

    let out =
        r.rt.delegate(DelegateArgs { id: id.clone(), tasks: vec![task("ada", "fix the flaky test"), task("ada", " "), task("far", "x")] })
            .await
            .unwrap();
    assert!(out[0].error.is_none(), "{out:?}");
    assert_eq!(out[0].id.0, "studio|job-1", "the job as the crew keeps it (on the member's machine)");
    assert_eq!((out[0].subagent.as_str(), out[0].agent.as_str(), out[0].model.as_str()), ("ada", "claude", "opus"));
    assert_eq!(out[0].place.as_deref(), Some("crew"));
    assert_eq!(out[1].error.as_deref(), Some("The task prompt is empty."));
    assert!(out[2].error.as_deref().unwrap().contains("far runs on another machine"), "{out:?}");

    // one crew.assign: the member's id, the prompt, the lead as `from`, and its cap
    let asked: Vec<_> = r.host.asked.lock().unwrap().iter().filter(|(c, _)| c == "crew.assign").cloned().collect();
    assert_eq!(asked.len(), 1, "{asked:?}");
    let a = &asked[0].1;
    assert_eq!(a["id"], "crew-ada");
    assert_eq!(a["prompt"], "fix the flaky test");
    assert_eq!(a["from"]["id"], id.as_str());
    assert_eq!(a["from"]["title"], made_title(&r, id.as_str()).await);
    assert_eq!(a["capped"]["mode"], "edits");

    // the lead keeps it: on its turn (what subagent_results reads with no ids) and as a crew job, not a child
    let l = r.rt.repo.session(id.as_str()).await.unwrap();
    assert_eq!(l.ext["wisp.runtime"]["crewJobs"]["studio|job-1"], "ada");
    assert!(l.ext["wisp.runtime"].get("children").and_then(|c| c.get("ada")).is_none(), "a crew job isn't a hidden child");
    let t = r.rt.turns(id.as_str(), None, Some(1)).await.unwrap().pop().unwrap();
    assert_eq!(t.ext["wisp.runtime"]["delegations"][0]["sessionId"], "studio|job-1");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_crew_refusal_comes_back_as_that_tasks_error() {
    // no crew answers here: crew.assign is unavailable, and the lead reads why
    let r = rig_with(Recorder::default()).await;
    let made = r.rt.create(lead(&json!([{ "name": "ada", "crew": "crew-ada", "count": 2 }]))).await.unwrap();
    let id = made.id.clone();
    until("the lead runs", || async {
        r.rt.turns(id.as_str(), None, Some(1)).await.unwrap().pop().is_some_and(|t| t.status == TurnStatus::Running)
    })
    .await;
    let out = r.rt.delegate(DelegateArgs { id: id.clone(), tasks: vec![task("ada", "go"), task("ada#2", "go")] }).await.unwrap();
    assert!(out[0].error.as_deref().unwrap().contains("crew.assign"), "{out:?}");
    // a copy's name never makes a hidden child of a crew row: the member's own limit counts, not copies
    assert_eq!(out[1].error.as_deref(), Some("Delegate to ada, not ada#2."), "{out:?}");
    let l = r.rt.repo.session(id.as_str()).await.unwrap();
    assert!(l.ext["wisp.runtime"].get("crewJobs").is_none(), "nothing went: nothing kept");
}

async fn made_title(r: &common::Rig, id: &str) -> String {
    r.rt.repo.session(id).await.unwrap().title
}
