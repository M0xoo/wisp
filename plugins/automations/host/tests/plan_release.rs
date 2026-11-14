//! Round 176 (v1 index.js `app.triggers.release`): a trigger's run that wisp.budget holds for the plan (Automations
//! stop at, `turn.held` by `wisp.budget`, kind `plan`) makes the trigger's row say `held`, with why; the plan freeing
//! early (`budget.plan_free`) for that account clears it, another account's doesn't, and `automations.release` does
//! the same by hand.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;

use serde_json::{Value, json};
use wisp_automations::AutomationsPlugin;
use wisp_automations_api::{PROVIDERS, Provided, TriggerProvider, TriggerSpec};
use wisp_budget_api::PlanFree;
use wisp_kernel::{Caller, Kernel, Manifest, Plugin, Result, Setup};
use wisp_runtime_api::commands as r;
use wisp_runtime_api::events::TurnHeld;
use wisp_runtime_api::model::Session;
use wisp_store::{Location, Store, SystemClock};
use wisp_testkit::{FakeClock, TestApp};

const T0: i64 = 1_800_000_000_000;

fn manifest(id: &str) -> Manifest {
    Manifest::from_value(json!({ "wispPlugin": 1, "id": id, "version": "2.0.0", "api": "^1" })).unwrap()
}

/// wisp.runtime as the engine calls it: `runtime.create` makes `t1`, a Codex task on the CLI's own login.
struct Runtime;
impl Plugin for Runtime {
    fn manifest(&self) -> Manifest {
        manifest("wisp.runtime")
    }
    fn setup(&self, s: &mut Setup) -> Result<()> {
        s.command::<r::Create, _, _>(|_, _, _a: r::StartArgs| async move { Ok(r::Created { id: "t1".into(), turn_id: None }) });
        s.command::<r::Get, _, _>(|_, _, _a: r::IdArgs| async move {
            Ok(serde_json::from_value::<Session>(json!({ "id": "t1", "title": "deploys", "agent": "codex", "model": "", "effort": "",
                "mode": "auto", "cwd": "/repo", "state": "review", "createdAt": 0, "updatedAt": 0 }))
            .unwrap())
        });
        Ok(())
    }
}

/// wisp.budget: only its events, sent from the test.
struct Budget;
impl Plugin for Budget {
    fn manifest(&self) -> Manifest {
        manifest("wisp.budget")
    }
    fn setup(&self, _: &mut Setup) -> Result<()> {
        Ok(())
    }
}

/// A plugin that brings the trigger (`trigger.provider@1`): a chat message starts a task.
struct Brings;
impl TriggerProvider for Brings {
    fn triggers(&self) -> Vec<Provided> {
        let spec = TriggerSpec {
            on: "chat.message".into(),
            prompt: "Deploy it".into(),
            project: "/repo".into(),
            users: vec!["U1".into()],
            ..TriggerSpec::default()
        };
        vec![Provided { name: "deploys".into(), spec, paused: false, full_auto: false }]
    }
}
struct Provider;
impl Plugin for Provider {
    fn manifest(&self) -> Manifest {
        Manifest::from_value(json!({ "wispPlugin": 1, "id": "wisp.testprovider", "version": "1.0.0", "api": "^1" })).unwrap()
    }
    fn setup(&self, s: &mut Setup) -> Result<()> {
        let p: Arc<dyn TriggerProvider> = Arc::new(Brings);
        s.contribute(&PROVIDERS, p);
        Ok(())
    }
}

async fn kernel(clock: &FakeClock) -> Kernel {
    let store = Store::open(Location::Memory, Arc::new(SystemClock)).unwrap();
    // durable events (turn.held) go through the store's log, as in `wisp serve`
    let log = wisp_kernel::durable::EventLogService(Arc::new(store.clone()));
    TestApp::new().clock(clock).service(store).service(log).with(AutomationsPlugin).with(Runtime).with(Budget).with(Provider).start().await
}

async fn row(k: &Kernel) -> Value {
    let rows = k.call(Caller::user(), "automations.trigger.ls", json!({})).await.unwrap();
    rows.as_array().and_then(|l| l.iter().find(|t| t["name"] == "deploys")).cloned().unwrap_or_else(|| panic!("no row: {rows}"))
}

async fn until_state(k: &Kernel, want: &str) -> Value {
    for _ in 0..300 {
        let r = row(k).await;
        if r["state"] == want {
            return r;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("the row isn't {want}: {}", row(k).await);
}

fn held(k: &Kernel, turn: &str) {
    let ctx = k.ctx("wisp.runtime").unwrap();
    let e = TurnHeld { session_id: "t1".into(), turn_id: turn.into(), by: "wisp.budget".into(), kind: "plan".into() };
    ctx.emit(&ctx.root_call(), &e);
}

fn free(k: &Kernel, account: &str) {
    let ctx = k.ctx("wisp.budget").unwrap();
    ctx.emit(&ctx.root_call(), &PlanFree { agent: "codex".into(), account: account.into(), started: 1 });
}

#[tokio::test(flavor = "multi_thread")]
async fn a_row_held_for_the_plan_is_released_when_that_plan_frees() {
    let clock = FakeClock::at(T0);
    let k = kernel(&clock).await;
    let ev = json!({ "on": "chat.message", "key": "chat:slack:U1:1", "at": T0, "summary": "deploy",
        "payload": { "channel": "slack", "user": "U1", "text": "deploy", "trusted": true } });
    let n = k.call(Caller::user(), "automations.trigger.push", ev).await.unwrap();
    let log = k.call(Caller::user(), "automations.trigger.log", json!({ "name": "deploys" })).await.unwrap();
    assert_eq!(n["n"], 1, "{n} {log} {}", row(&k).await);
    // wisp.budget held its run for the plan: the row says so, with why
    held(&k, "u1");
    let r = until_state(&k, "held").await;
    assert!(r["why"].as_str().unwrap().contains("codex"), "{r}");
    // another account's plan freeing moves nothing; this one's (`default`: the CLI's own login) clears it
    free(&k, "work");
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    assert_eq!(row(&k).await["state"], "held");
    free(&k, "default");
    until_state(&k, "on").await;
    // held again (its next turn); `automations.release` by hand does the same, and says how many
    held(&k, "u2");
    until_state(&k, "held").await;
    let n = k.call(Caller::user(), "automations.release", json!({ "agent": "claude" })).await.unwrap();
    assert_eq!(n["n"], 0, "another harness: {n}");
    let n = k.call(Caller::user(), "automations.release", json!({ "agent": "codex" })).await.unwrap();
    assert_eq!(n["n"], 1, "{n}");
    assert_eq!(row(&k).await["state"], "on");
}
