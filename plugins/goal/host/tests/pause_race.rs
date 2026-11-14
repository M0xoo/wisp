//! `goal.pause` against a stand-in wisp.runtime that lands a round's result between the pause's read of the goal
//! and its write: the pause moves on from the result (its count kept), never writes the goal back as it was read.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use serde_json::json;
use wisp_goal::GoalPlugin;
use wisp_kernel::Caller;
use wisp_runtime_api::model::Session;
use wisp_runtime_api::testing::SlotRuntime;
use wisp_testkit::TestApp;

#[tokio::test]
async fn a_round_that_lands_while_a_pause_is_written_keeps_its_count() {
    let rt = SlotRuntime::new(Session { id: "t1".into(), cwd: "/tmp".into(), title: "t".into(), ..Session::default() });
    rt.set("wisp.goal", json!({ "text": "a.txt says hello", "state": "again", "rounds": 1 }));
    let k = TestApp::new().with(GoalPlugin).with(rt.clone()).start().await;
    rt.race("wisp.goal", json!({ "text": "a.txt says hello", "state": "again", "rounds": 2, "verdicts": [{ "met": false }] }));
    k.call(Caller::user(), "goal.pause", json!({ "id": "t1", "why": "lunch" })).await.unwrap();
    let g = rt.ext("wisp.goal");
    assert_eq!((g["state"].clone(), g["rounds"].clone(), g["why"].clone()), (json!("paused"), json!(2), json!("lunch")));
    assert_eq!(rt.writes().iter().map(|w| w.2).collect::<Vec<_>>(), [false, true]);
}
