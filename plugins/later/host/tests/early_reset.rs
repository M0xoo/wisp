//! F-auto-12: a banked Codex reset lands early (`budget.plan_free`, v1 app.resetEarly): the task waiting at its
//! usage limit carries on now, not at the old reset three hours away, and the phone hears it in v1's words, counting
//! the runs wisp.budget started itself. Another account's reset moves nothing.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::{Arc, Mutex};

use serde_json::json;
use wisp_budget_api::PlanFree;
use wisp_budget_api::commands as b;
use wisp_channels_api as ch;
use wisp_kernel::{Caller, Kernel, Manifest, Plugin, Result, Setup};
use wisp_later::LaterPlugin;
use wisp_runtime_api::commands as r;
use wisp_runtime_api::model::Session;
use wisp_store::{Location, Store, SystemClock};
use wisp_testkit::{FakeClock, TestApp};

const NOW: i64 = 1_800_000_000_000;
const H: i64 = 3_600_000;

#[derive(Clone, Default)]
struct Seen {
    sent: Arc<Mutex<Vec<String>>>,
    notes: Arc<Mutex<Vec<(String, String)>>>,
}

fn manifest(id: &str) -> Manifest {
    Manifest::from_value(json!({ "wispPlugin": 1, "id": id, "version": "2.0.0", "api": "^1" })).unwrap()
}

/// wisp.runtime as far as later calls it: one Codex task, `t1`, on the CLI's own login.
struct Runtime(Seen);
impl Plugin for Runtime {
    fn manifest(&self) -> Manifest {
        manifest("wisp.runtime")
    }
    fn setup(&self, s: &mut Setup) -> Result<()> {
        s.command::<r::Get, _, _>(move |_, _, _a: r::IdArgs| async move {
            Ok(serde_json::from_value::<Session>(json!({ "id": "t1", "title": "Ship it", "agent": "codex", "model": "", "effort": "",
                "mode": "auto", "cwd": "/repo", "state": "review", "createdAt": 0, "updatedAt": 0 }))
            .unwrap())
        });
        let seen = self.0.clone();
        s.command::<r::FollowUp, _, _>(move |_, _, a: r::FollowUpArgs| {
            seen.sent.lock().unwrap().push(a.text);
            async move { Ok(r::FollowedUp { turn_id: None, queued: None }) }
        });
        s.command::<r::SetExt, _, _>(|_, _, _| async move { Ok(r::Ack::default()) });
        Ok(())
    }
}

/// wisp.budget: nothing holds the plan now (it reset early), and it says so with `budget.plan_free`.
struct Budget;
impl Plugin for Budget {
    fn manifest(&self) -> Manifest {
        manifest("wisp.budget")
    }
    fn setup(&self, s: &mut Setup) -> Result<()> {
        s.command::<b::Hold, _, _>(|_, _, _| async move { Ok(None) });
        Ok(())
    }
}

/// wisp.channels: the phone's notes.
struct Channels(Seen);
impl Plugin for Channels {
    fn manifest(&self) -> Manifest {
        manifest("wisp.channels")
    }
    fn setup(&self, s: &mut Setup) -> Result<()> {
        let seen = self.0.clone();
        s.command::<ch::SendNotice, _, _>(move |_, _, a: ch::SendArgs| {
            seen.notes.lock().unwrap().push((a.msg.title, a.msg.text));
            async move { Ok(ch::Sent { sent: 1 }) }
        });
        Ok(())
    }
}

async fn kernel(seen: &Seen, clock: &FakeClock) -> Kernel {
    let store = Store::open(Location::Memory, Arc::new(SystemClock)).unwrap();
    TestApp::new()
        .clock(clock)
        .service(store)
        .with(LaterPlugin)
        .with(Runtime(seen.clone()))
        .with(Budget)
        .with(Channels(seen.clone()))
        .start()
        .await
}

async fn eventually(what: &str, mut ok: impl FnMut() -> bool) {
    for _ in 0..400 {
        if ok() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("{what}");
}

fn free(k: &Kernel, account: &str, started: u32) {
    let ctx = k.ctx("wisp.budget").unwrap();
    ctx.emit(&ctx.root_call(), &PlanFree { agent: "codex".into(), account: account.into(), started });
}

#[tokio::test(flavor = "multi_thread")]
async fn a_task_waiting_at_its_limit_carries_on_when_the_plan_resets_early() {
    let (seen, clock) = (Seen::default(), FakeClock::at(NOW));
    let k = kernel(&seen, &clock).await;
    // the run hit Codex's limit, Wait for the reset is on: it carries on at the reset, three hours away
    let l = k.call(Caller::user(), "later.waitAtLimit", json!({ "sessionId": "t1", "at": NOW + 3 * H, "agent": "codex" })).await.unwrap();
    assert_eq!(l["at"], NOW + 3 * H, "{l}");
    // another account's plan reset early: nothing of this one's moves
    free(&k, "work", 0);
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert!(seen.sent.lock().unwrap().is_empty());
    assert!(seen.notes.lock().unwrap().is_empty(), "nothing started, so the phone hears nothing");
    // this account's plan reset early, and budget started one held run of its own: the task goes now
    free(&k, "default", 1);
    eventually("the task carries on at once", || seen.sent.lock().unwrap().len() == 1).await;
    assert!(seen.sent.lock().unwrap()[0].contains(wisp_later_api::LIMIT_CARRY_ON), "{:?}", seen.sent.lock().unwrap());
    eventually("the phone hears it", || !seen.notes.lock().unwrap().is_empty()).await;
    let notes = seen.notes.lock().unwrap().clone();
    assert_eq!(
        notes,
        [("\u{21bb} codex reset early".to_owned(), "Its plan reset before its time. 2 tasks waiting on it start now.".to_owned())],
        "v1's words; no harness registered here, so its id names it"
    );
    let left = k.call(Caller::user(), "later.list", json!({ "sessionId": "t1" })).await.unwrap();
    assert_eq!(left.as_array().unwrap().len(), 0, "{left}");
}
