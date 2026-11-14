//! `runtime.setExt` with `expect` (a plugin's read-then-write): it goes only while the slot still holds what was read,
//! compared under the task's lock in the write itself, so a write that landed in between wins (wisp.goal's rounds).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::rig;
use serde_json::{Value, json};
use wisp_runtime_api::spec::AdoptArgs;

#[tokio::test(flavor = "multi_thread")]
async fn a_conditional_ext_write_goes_only_on_the_slot_it_read() {
    let r = rig().await;
    let turn = serde_json::to_value(wisp_runtime_api::model::Turn { prompt: "fix".into(), ..Default::default() }).unwrap();
    let id =
        r.rt.adopt(AdoptArgs { title: "t".into(), agent: "fake".into(), cwd: String::new(), turns: vec![turn], ..AdoptArgs::default() })
            .await
            .unwrap()
            .id
            .0;
    let judging = json!({ "state": "judging", "running": [{ "run": "r1" }] });
    // an empty slot is expected as null
    r.rt.set_ext(&id, "wisp.goal", judging.clone(), Some(&Value::Null)).await.unwrap();
    // a drop lands (unconditional), then the round writes what it read before it
    r.rt.set_ext(&id, "wisp.goal", json!({ "state": "cleared" }), None).await.unwrap();
    let e = r.rt.set_ext(&id, "wisp.goal", json!({ "state": "again", "rounds": 1 }), Some(&judging)).await.unwrap_err();
    assert!(e.to_string().contains("changed meanwhile"), "{e}");
    assert_eq!(r.rt.get(&id).await.unwrap().ext["wisp.goal"], json!({ "state": "cleared" }), "the drop stands");
    // on the slot it read, it goes
    r.rt.set_ext(&id, "wisp.goal", json!({ "state": "again" }), Some(&json!({ "state": "cleared" }))).await.unwrap();
    assert_eq!(r.rt.get(&id).await.unwrap().ext["wisp.goal"]["state"], "again");
}
