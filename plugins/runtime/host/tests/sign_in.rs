//! A run that failed signed out (v1 sign-in-card.js, F-comp-42): Sign in on the turn arms it, and when that harness's
//! login lands (`runtime.signInDone`, from wisp.accounts) the request is sent again, once, in the same task. Another
//! harness's login, or a turn that didn't fail signed out, sends nothing.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::sync::atomic::Ordering;

use common::{SIGNED_IN, rig, until};
use wisp_runtime_api::commands::StartArgs;
use wisp_runtime_api::model::TurnStatus;

#[tokio::test(flavor = "multi_thread")]
async fn a_signed_out_run_is_sent_again_once_its_login_lands_v1_sign_in_rerun() {
    let r = rig().await;
    let id =
        r.rt.create(StartArgs { prompt: "signedout fix the login".into(), cwd: Some("/tmp".into()), ..StartArgs::default() })
            .await
            .unwrap()
            .id
            .0;
    until("the turn to fail", || async {
        r.rt.turns(&id, None, Some(1)).await.unwrap().pop().is_some_and(|t| t.status == TurnStatus::Error)
    })
    .await;
    let failed = r.rt.turns(&id, None, Some(1)).await.unwrap().pop().unwrap();
    assert_eq!(failed.ext["wisp.runtime"]["authFailed"], true, "the turn shows the sign-in card");
    assert!(r.rt.sign_in(&id, &failed.id).await.unwrap(), "Sign in arms it");
    // another harness's login: nothing goes
    r.rt.sign_in_done("codex", "").await.unwrap();
    assert_eq!(r.sim.spawned().len(), 1);
    SIGNED_IN.store(true, Ordering::SeqCst);
    r.rt.sign_in_done("fake", "").await.unwrap();
    until("the request to go again", || async { r.sim.spawned().len() == 2 }).await;
    until("the rerun to finish", || async {
        r.rt.turns(&id, None, Some(1)).await.unwrap().pop().is_some_and(|t| t.status == TurnStatus::Done)
    })
    .await;
    // once: a second login doesn't send it a third time
    r.rt.sign_in_done("fake", "").await.unwrap();
    assert_eq!(r.sim.spawned().len(), 2);
    assert_eq!(r.sim.spawned()[1].args[0], "signedout fix the login", "the same request");
}
