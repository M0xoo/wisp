//! ADR-0047, as v1's `waitOnline` (services/sandbox.js): a sandbox whose machine is in error (its tunnel failed once)
//! gets one fresh connect each time it's used, so it isn't stuck until the user removes it; in error again after that
//! try, the wait fails at once with the box's own reason (not after the 90 s wait).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use wisp_kernel::{Caller, Command, Manifest, Plugin, Result, Setup};
use wisp_sandbox::SandboxPlugin;
use wisp_testkit::{FakeClock, TestApp};

macro_rules! cmd {
    ($name:ident, $id:literal) => {
        struct $name;
        impl Command for $name {
            const ID: &'static str = $id;
            type Args = Value;
            type Out = Value;
        }
    };
}
cmd!(List, "machines.list");
cmd!(Get, "machines.get");
cmd!(Connect, "machines.connect");
cmd!(Route, "machines.route");

/// The box's state and error, what a connect turns it into, and how many connects it got.
#[derive(Clone)]
struct Box_ {
    now: Arc<Mutex<(String, String)>>,
    after: (String, String),
    connects: Arc<Mutex<u32>>,
}

impl Box_ {
    fn new(after: (&str, &str)) -> Self {
        Self { now: Arc::new(Mutex::new(("error".into(), "the tunnel closed".into()))), after: (after.0.into(), after.1.into()), connects: Arc::default() }
    }
    fn view(&self) -> Value {
        let (state, error) = self.now.lock().unwrap().clone();
        json!({ "id": "m1", "peer": null, "name": "Sandbox", "transport": "grid", "address": "grid.test", "port": 443, "command": "",
            "autoConnect": true, "addedAt": 0, "kind": "grid", "target": "grid.test", "defaultCommand": "", "state": state, "steps": [],
            "error": error, "hint": null, "stale": false, "attempt": 0, "since": null, "remote": null, "outdated": null, "log": [],
            "projects": 0, "working": 0, "sandbox": "sb1", "owner": { "judges": "t1" } })
    }
}

/// wisp.machines as far as a sandbox's wait reads it: one sandbox machine, `m1`. A connect shows *connecting*
/// at once (as machines' does), and the next look shows how that try went.
struct Machines(Box_);
impl Plugin for Machines {
    fn manifest(&self) -> Manifest {
        Manifest::from_value(json!({ "wispPlugin": 1, "id": "wisp.machines", "version": "2.0.0", "api": "^1" })).unwrap()
    }
    fn setup(&self, s: &mut Setup) -> Result<()> {
        let b = self.0.clone();
        s.command::<List, _, _>(move |_, _, _| {
            let v = b.view();
            async move { Ok(json!([v])) }
        });
        let b = self.0.clone();
        s.command::<Get, _, _>(move |_, _, _| {
            let v = b.view();
            let mut now = b.now.lock().unwrap();
            if now.0 == "connecting" {
                *now = b.after.clone();
            }
            async move { Ok(v) }
        });
        let b = self.0.clone();
        s.command::<Connect, _, _>(move |_, _, _| {
            *b.connects.lock().unwrap() += 1;
            *b.now.lock().unwrap() = ("connecting".into(), String::new());
            let v = b.view();
            async move { Ok(v) }
        });
        s.command::<Route, _, _>(|_, _, a: Value| async move {
            assert_eq!(a["cmd"], "sandbox.seed", "{a}");
            Ok(json!({ "cwd": "/home/u/code/scratch" }))
        });
        Ok(())
    }
}

/// `sandbox.place` for the judges' sandbox `m1` already holds; the wait's 1.5 s polls tick by on a fake clock.
async fn place(b: &Box_) -> std::result::Result<Value, wisp_kernel::WireError> {
    let clock = FakeClock::at(1_000);
    let k = TestApp::new().clock(&clock).with(SandboxPlugin { inside: Some(false), home: None }).with(Machines(b.clone())).start().await;
    let tick = clock.clone();
    let ticker = tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            tick.advance(1_500);
        }
    });
    let out = k.call(Caller::user(), "sandbox.place", json!({ "owner": { "judges": "t1" } })).await;
    ticker.abort();
    out
}

#[tokio::test(flavor = "multi_thread")]
async fn a_sandbox_in_error_is_reconnected_when_used_and_gives_up_at_once_with_its_reason_v1_wait_online() {
    // its tunnel failed once: using it again connects it, and it comes up
    let up = Box_::new(("online", ""));
    let out = place(&up).await.unwrap();
    assert_eq!((out["machine"].as_str(), out["made"].as_bool()), (Some("m1"), Some(false)), "{out}");
    assert_eq!(*up.connects.lock().unwrap(), 1);

    // that try fails too: the wait stops there, one connect, with the box's reason
    let down = Box_::new(("error", "the grid refused the tunnel"));
    let err = place(&down).await.unwrap_err();
    // (not the 90 s wait's "The sandbox didn't come up (error): …")
    assert_eq!(err.message, "The sandbox didn't start: the grid refused the tunnel", "{err:?}");
    assert_eq!(*down.connects.lock().unwrap(), 1, "one fresh connect per wait, no loop of them");
}
