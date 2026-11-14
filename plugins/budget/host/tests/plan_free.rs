//! wisp.budget's calls into other plugins, through its manifest (default deny, ADR-0008): Drain watch's phone note
//! (`channels.send`) and starting a held run (`runtime.release`) reach them; and an early reset that frees the plan
//! tells the phone by itself when wisp.later is off (later sends that note when it's on, so it's never sent twice).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::{Arc, Mutex};

use serde_json::json;
use wisp_budget::BudgetPlugin;
use wisp_channels_api as ch;
use wisp_kernel::{Caller, Kernel, Manifest, Plugin, Result, Setup};
use wisp_runtime_api::commands as r;
use wisp_runtime_api::events::TurnEnded;
use wisp_runtime_api::hooks::{BeforeRun, BeforeRunCtx};
use wisp_store::{Location, Store, SystemClock};
use wisp_testkit::{FakeClock, TestApp};

const NOW: i64 = 1_800_000_000_000;
const H: i64 = 3_600_000;

#[derive(Clone, Default)]
struct Seen {
    notes: Arc<Mutex<Vec<(String, String)>>>,
    released: Arc<Mutex<Vec<String>>>,
}
impl Seen {
    fn notes(&self) -> Vec<(String, String)> {
        self.notes.lock().unwrap().clone()
    }
    fn released(&self) -> Vec<String> {
        self.released.lock().unwrap().clone()
    }
}

fn manifest(id: &str) -> Manifest {
    Manifest::from_value(json!({ "wispPlugin": 1, "id": id, "version": "2.0.0", "api": "^1" })).unwrap()
}

/// wisp.runtime as far as budget calls it: `runtime.release` starts a held turn.
struct Runtime(Seen);
impl Plugin for Runtime {
    fn manifest(&self) -> Manifest {
        manifest("wisp.runtime")
    }
    fn setup(&self, s: &mut Setup) -> Result<()> {
        let seen = self.0.clone();
        s.command::<r::Release, _, _>(move |_, _, a: r::ReleaseArgs| {
            seen.released.lock().unwrap().push(a.turn_id.0);
            async move { Ok(r::Ack::default()) }
        });
        s.command::<r::TurnSetExt, _, _>(|_, _, _| async move { Ok(r::Ack::default()) });
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

/// wisp.later is on (it sends the early-reset note itself; this stand-in sends nothing).
struct Later;
impl Plugin for Later {
    fn manifest(&self) -> Manifest {
        manifest("wisp.later")
    }
    fn setup(&self, _: &mut Setup) -> Result<()> {
        Ok(())
    }
}

async fn kernel(seen: &Seen, clock: &FakeClock, later: bool) -> Kernel {
    let store = Store::open(Location::Memory, Arc::new(SystemClock)).unwrap();
    let app = TestApp::new().clock(clock).service(store).with(BudgetPlugin).with(Runtime(seen.clone())).with(Channels(seen.clone()));
    if later { app.with(Later).start().await } else { app.start().await }
}

async fn eventually(what: &str, mut ok: impl FnMut() -> bool) {
    for _ in 0..300 {
        if ok() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("{what}");
}

async fn settle() {
    tokio::time::sleep(std::time::Duration::from_millis(60)).await;
}

async fn record(k: &Kernel, window: &str, used: f64, resets_at: i64, ms: i64) {
    let a = json!({ "agent": "codex", "account": "", "report": { "windows": [{ "id": window, "used": used, "resetsAt": resets_at, "ms": ms }], "complete": true } });
    k.call(Caller::user(), "budget.record", a).await.unwrap();
}

fn ended(k: &Kernel, n: u32) {
    let e: TurnEnded = serde_json::from_value(json!({ "sessionId": format!("t{n}"), "turnId": format!("u{n}"), "status": "done",
        "interrupted": false, "costUsd": 1.0, "agent": "codex", "model": "gpt-5" }))
    .unwrap();
    let ctx = k.ctx("wisp.runtime").unwrap();
    ctx.emit(&ctx.root_call(), &e);
}

/// v1 index.js:145 `onDrain`: five runs took a point of the weekly window each, then two took five each: the plan moves
/// 5× faster for the same work, and with Drain watch on the phone hears it through `channels.send`.
#[tokio::test(flavor = "multi_thread")]
async fn drain_watchs_note_reaches_the_phone_through_channels_send() {
    let (seen, clock) = (Seen::default(), FakeClock::at(NOW));
    let k = kernel(&seen, &clock, true).await;
    k.set_setting("budget.drainWatch", Some(json!(true))).unwrap();
    let (week, resets) = (7 * 24 * H, NOW + 6 * 24 * H);
    let mut used = 0.10;
    record(&k, "seven_day", used, resets, week).await;
    for (i, d) in [0.01, 0.01, 0.01, 0.01, 0.01, 0.05, 0.05].into_iter().enumerate() {
        if i == 5 {
            // the usual runs are hours ago; a fresh reading starts the recent ones
            clock.advance(3 * 3_600_000);
            record(&k, "seven_day", used, resets, week).await;
        }
        clock.advance(60_000);
        used += d;
        record(&k, "seven_day", used, resets, week).await;
        ended(&k, u32::try_from(i).unwrap());
        settle().await;
    }
    eventually("Drain watch tells the phone", || !seen.notes().is_empty()).await;
    let notes = seen.notes();
    assert_eq!(notes.len(), 1, "{notes:?}");
    assert!(notes[0].0.contains("faster"), "{notes:?}");
}

/// The plan is past the stop line: a crew run is held. Then a reading shows the window reset early.
async fn held_then_reset_early(k: &Kernel) {
    k.call(Caller::user(), "budget.setStop", json!({ "key": "autoStopCodex", "value": "75" })).await.unwrap();
    record(k, "five_hour", 0.8, NOW + 3 * H, 5 * H).await;
    let c: BeforeRunCtx = serde_json::from_value(json!({ "sessionId": "t1", "turnId": "u1", "agent": "codex", "model": "", "effort": "",
        "mode": "auto", "cwd": "/repo", "prompt": "nightly tidy", "by": "crew", "kind": "first" }))
    .unwrap();
    let ctx = k.ctx("wisp.runtime").unwrap();
    let c = ctx.run_hook::<BeforeRun>(&ctx.root_call(), c).await.unwrap();
    assert_eq!(c.hold.as_ref().map(|h| h.kind.as_str()), Some("plan"), "{c:?}");
    // OpenAI banked a reset: 2% used, the next reset five hours away
    record(k, "five_hour", 0.02, NOW + 5 * H, 5 * H).await;
}

/// F-auto-12 with wisp.later off: the held run starts (`runtime.release`) and budget itself tells the phone, in v1's
/// words; nobody else would.
#[tokio::test(flavor = "multi_thread")]
async fn with_later_off_an_early_reset_tells_the_phone_itself() {
    let (seen, clock) = (Seen::default(), FakeClock::at(NOW));
    let k = kernel(&seen, &clock, false).await;
    held_then_reset_early(&k).await;
    eventually("the held run starts", || seen.released() == ["u1"]).await;
    eventually("the phone hears it", || !seen.notes().is_empty()).await;
    assert_eq!(
        seen.notes(),
        [("\u{21bb} codex reset early".to_owned(), "Its plan reset before its time. 1 task waiting on it starts now.".to_owned())]
    );
}

/// With wisp.later on, later sends that one note (counting its follow-ups too): budget sends none of its own.
#[tokio::test(flavor = "multi_thread")]
async fn with_later_on_budget_sends_no_second_note() {
    let (seen, clock) = (Seen::default(), FakeClock::at(NOW));
    let k = kernel(&seen, &clock, true).await;
    held_then_reset_early(&k).await;
    eventually("the held run starts", || seen.released() == ["u1"]).await;
    settle().await;
    assert!(seen.notes().is_empty(), "later's to send: {:?}", seen.notes());
}
