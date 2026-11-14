//! A task started at a mode cap (F-chan-10, v1 server/capped.js): `runtime.create`'s `cap` is kept on the task in
//! the slot a crew job's cap uses, holds its first mode, and every later turn to it; asking for more is refused
//! unless the user asks (which lifts it); the edge names its agent `agent:capped`.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::{rig, until};
use serde_json::json;
use wisp_runtime_api::commands::{FollowUpArgs, StartArgs};
use wisp_runtime_api::model::{Mode, TurnStatus};

fn capped(prompt: &str, mode: Option<Mode>, cap: Mode) -> StartArgs {
    StartArgs { prompt: prompt.into(), cwd: Some("/tmp".into()), mode, cap: Some(cap), ..StartArgs::default() }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cap_given_to_create_is_stored_on_the_task_and_holds_its_first_turn() {
    let r = rig().await;
    // no mode asked: it runs at the cap, not at the default Full auto
    let id = r.rt.create(capped("fix it", None, Mode::Edits)).await.unwrap().id.0;
    let s = r.rt.repo.session(&id).await.unwrap();
    assert_eq!(s.ext["wisp.runtime"]["capped"], json!({ "mode": "edits" }), "the crew job's shape: {:?}", s.ext);
    assert_eq!(s.mode, Mode::Edits);
    assert_eq!(r.rt.turns(&id, None, None).await.unwrap()[0].mode, Mode::Edits);
    assert_eq!(r.rt.agent_set(&id).as_deref(), Some("agent:capped"), "its agent speaks as agent:capped at the edge");

    // a lower mode stays; a Plan cap is its own set; Full auto is no cap at all
    let plan = r.rt.create(capped("look", Some(Mode::Plan), Mode::Plan)).await.unwrap().id.0;
    assert_eq!(r.rt.agent_set(&plan).as_deref(), Some("agent:capped:plan"));
    let free = r.rt.create(capped("anything", None, Mode::Auto)).await.unwrap().id.0;
    let s = r.rt.repo.session(&free).await.unwrap();
    assert!(s.ext["wisp.runtime"].get("capped").is_none() && s.mode == Mode::Auto, "{:?}", s.ext);
    assert_eq!(r.rt.agent_set(&free), None);

    // asked to start above its own cap: refused, nothing made
    let before = r.rt.repo.sessions().await.unwrap().len();
    let e = r.rt.create(capped("go wild", Some(Mode::Auto), Mode::Edits)).await.unwrap_err();
    let w = wisp_kernel::WireError::from(e);
    assert_eq!(w.code, wisp_kernel::Code::Forbidden);
    assert!(w.message.contains("Full auto is above this task's cap of Edits"), "{}", w.message);
    assert_eq!(r.rt.repo.sessions().await.unwrap().len(), before);

    // a rename keeps the cap (it once replaced runtime's whole slot)
    r.rt.rename(&id, "Fix it").await.unwrap();
    assert_eq!(r.rt.repo.session(&id).await.unwrap().ext["wisp.runtime"]["capped"]["mode"], "edits");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_mode_above_the_cap_is_refused_for_anyone_but_the_user_and_no_turn_runs_above_it() {
    let r = rig().await;
    let id = r.rt.create(capped("fix it", Some(Mode::Edits), Mode::Edits)).await.unwrap().id.0;
    until("the first turn", || async { r.rt.turns(&id, None, Some(1)).await.unwrap().pop().is_some_and(|t| t.status == TurnStatus::Done) })
        .await;
    for set in ["plugin:wisp.channels", "agent:session", "agent:capped", "crew:ops"] {
        let e = wisp_kernel::WireError::from(r.rt.mode_asked(&id, Mode::Auto, set).await.unwrap_err());
        assert_eq!(e.code, wisp_kernel::Code::Forbidden, "{set}");
        assert_eq!(
            e.message,
            "Refused: Full auto is above this task's cap of Edits, set by the channel that started it. Use Edits or lower; the user can raise it in wisp."
        );
    }
    r.rt.mode_asked(&id, Mode::Plan, "plugin:wisp.channels").await.unwrap();
    r.rt.mode_asked(&id, Mode::Edits, "agent:capped").await.unwrap();

    // a queued item that asks for more (it got past every door): its turn still runs at the cap
    let f = FollowUpArgs { id: id.as_str().into(), text: "now everything".into(), mode: Some(Mode::Auto), ..FollowUpArgs::default() };
    r.rt.follow_up(f).await.unwrap();
    until("the follow-up's turn", || async {
        r.rt.turns(&id, None, None).await.unwrap().iter().filter(|t| t.status == TurnStatus::Done).count() == 2
    })
    .await;
    let turns = r.rt.turns(&id, None, None).await.unwrap();
    assert_eq!(turns[1].mode, Mode::Edits, "never above the cap");
    assert_eq!(r.rt.repo.session(&id).await.unwrap().mode, Mode::Edits);

    // the user asking in wisp lifts it (v1: "You choosing a higher mode in wisp clears it for that task")
    r.rt.mode_asked(&id, Mode::Auto, "user:full").await.unwrap();
    let s = r.rt.repo.session(&id).await.unwrap();
    assert!(s.ext["wisp.runtime"].get("capped").is_none(), "{:?}", s.ext);
    assert_eq!(r.rt.agent_set(&id), None, "its agent is agent:session again");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_fork_of_a_capped_task_keeps_its_cap() {
    let r = rig().await;
    let id = r.rt.create(capped("fix it", Some(Mode::Edits), Mode::Edits)).await.unwrap().id.0;
    until("the first turn", || async { r.rt.turns(&id, None, Some(1)).await.unwrap().pop().is_some_and(|t| t.status == TurnStatus::Done) })
        .await;
    let a = wisp_runtime_api::commands::ForkArgs { id: id.as_str().into(), turn_id: None, title: None };
    let fork = r.rt.fork(a).await.unwrap().id.0;
    assert_eq!(r.rt.repo.session(&fork).await.unwrap().ext["wisp.runtime"]["capped"], json!({ "mode": "edits" }));
    assert_eq!(r.rt.agent_set(&fork).as_deref(), Some("agent:capped"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_restart_reloads_every_capped_tasks_cap_from_its_list_row() {
    let r = rig().await;
    let id = r.rt.create(capped("fix it", Some(Mode::Edits), Mode::Edits)).await.unwrap().id.0;
    let plan = r.rt.create(capped("look", Some(Mode::Plan), Mode::Plan)).await.unwrap().id.0;
    let free = r.rt.create(capped("anything", None, Mode::Auto)).await.unwrap().id.0;
    for t in [&id, &plan, &free] {
        until("the first turn", || async {
            r.rt.turns(t, None, Some(1)).await.unwrap().pop().is_some_and(|t| t.status == TurnStatus::Done)
        })
        .await;
    }
    let row = r.rt.list(&wisp_runtime_api::commands::ListArgs::default()).into_iter().find(|s| s.id.0 == id).unwrap();
    assert_eq!(row.fields.get("capped"), Some(&json!("edits")), "the list row says the cap: {:?}", row.fields);

    // a second runtime over the same store, as after a restart: none of these is waiting on an ask
    let rt2 = wisp_runtime::Runtime::new(
        wisp_runtime::repo::Repo::new(r.store.clone()),
        r.host.clone(),
        std::sync::Arc::new(wisp_proc::sim::SimProc::new()),
        std::sync::Arc::new(wisp_store::SystemClock),
    );
    rt2.start().await.unwrap();
    assert_eq!(rt2.agent_set(&id).as_deref(), Some("agent:capped"), "not agent:session until its row is written again");
    assert_eq!(rt2.agent_set(&plan).as_deref(), Some("agent:capped:plan"));
    assert_eq!(rt2.agent_set(&free), None);

    // lifted, then restarted: it stays lifted
    rt2.mode_asked(&id, Mode::Auto, "user:full").await.unwrap();
    let rt3 = wisp_runtime::Runtime::new(
        wisp_runtime::repo::Repo::new(r.store.clone()),
        r.host.clone(),
        std::sync::Arc::new(wisp_proc::sim::SimProc::new()),
        std::sync::Arc::new(wisp_store::SystemClock),
    );
    rt3.start().await.unwrap();
    assert_eq!(rt3.agent_set(&id), None);
    assert_eq!(rt3.agent_set(&plan).as_deref(), Some("agent:capped:plan"));
}
