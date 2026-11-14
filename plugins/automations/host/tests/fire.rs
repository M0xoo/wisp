//! The trigger engine on a fake clock, against a stand-in wisp.runtime (F-auto-1, F-auto-4): a cron schedule starts
//! its task on its minute and not before, once per minute, in its project; a chat trigger with `users` starts nothing
//! for someone not listed (v1 hooks.js "Not one of the allowed people") and starts it for someone who is.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use wisp_automations::AutomationsPlugin;
use wisp_automations_api::{PROVIDERS, Provided, TriggerProvider, TriggerSpec};
use wisp_kernel::{Caller, Kernel, Manifest, Plugin, Result, Setup};
use wisp_runtime_api::commands as r;
use wisp_store::{Location, Store, SystemClock};
use wisp_testkit::{FakeClock, TestApp};

/// wisp.runtime as far as the engine calls it: `runtime.create` keeps what it was asked.
#[derive(Clone, Default)]
struct Rt(Arc<Mutex<Vec<r::StartArgs>>>);
impl Rt {
    fn made(&self) -> Vec<r::StartArgs> {
        self.0.lock().unwrap().clone()
    }
}
struct Runtime(Rt);
impl Plugin for Runtime {
    fn manifest(&self) -> Manifest {
        Manifest::from_value(json!({ "wispPlugin": 1, "id": "wisp.runtime", "version": "2.0.0", "api": "^1" })).unwrap()
    }
    fn setup(&self, s: &mut Setup) -> Result<()> {
        let rt = self.0.clone();
        s.command::<r::Create, _, _>(move |_, _, a: r::StartArgs| {
            let mut made = rt.0.lock().unwrap();
            made.push(a);
            let id = format!("t{}", made.len());
            async move { Ok(r::Created { id: id.as_str().into(), turn_id: None }) }
        });
        Ok(())
    }
}

/// A plugin that brings triggers (`trigger.provider@1`), as the crew's wakes do.
struct Brings(Vec<(String, TriggerSpec)>);
impl TriggerProvider for Brings {
    fn triggers(&self) -> Vec<Provided> {
        self.0.iter().map(|(name, spec)| Provided { name: name.clone(), spec: spec.clone(), paused: false, full_auto: false }).collect()
    }
}
struct Provider(Vec<(String, TriggerSpec)>);
impl Plugin for Provider {
    fn manifest(&self) -> Manifest {
        Manifest::from_value(json!({ "wispPlugin": 1, "id": "wisp.testprovider", "version": "1.0.0", "api": "^1" })).unwrap()
    }
    fn setup(&self, s: &mut Setup) -> Result<()> {
        let p: Arc<dyn TriggerProvider> = Arc::new(Brings(self.0.clone()));
        s.contribute(&PROVIDERS, p);
        Ok(())
    }
}

async fn kernel(rt: &Rt, clock: &FakeClock, triggers: Vec<(String, TriggerSpec)>) -> Kernel {
    let store = Store::open(Location::Memory, Arc::new(SystemClock)).unwrap();
    TestApp::new().clock(clock).service(store).with(AutomationsPlugin).with(Runtime(rt.clone())).with(Provider(triggers)).start().await
}

/// Moves the clock on in 15 s steps (the engine's tick), letting each tick's work finish.
async fn run_for(clock: &FakeClock, ms: u64) {
    for _ in 0..ms / 15_000 {
        while clock.sleepers() < 2 {
            tokio::task::yield_now().await;
        }
        clock.advance(15_000);
        for _ in 0..200 {
            tokio::task::yield_now().await;
        }
    }
    while clock.sleepers() < 2 {
        tokio::task::yield_now().await;
    }
}

/// 2027-01-15 08:00:00 UTC, on a minute
const T0: i64 = 1_800_000_000_000;

#[tokio::test(flavor = "multi_thread")]
async fn a_cron_schedule_starts_its_task_on_its_minute_once_in_its_project() {
    let (rt, clock) = (Rt::default(), FakeClock::at(T0));
    // the minute two minutes on, in UTC
    let at = T0 + 2 * 60_000;
    let (h, m) = ((at / 3_600_000) % 24, (at / 60_000) % 60);
    let spec = TriggerSpec {
        on: "schedule".into(),
        cron: format!("{m} {h} * * *"),
        tz: "UTC".into(),
        prompt: "Tidy the docs".into(),
        project: "/repo".into(),
        mode: "plan".into(),
        ..TriggerSpec::default()
    };
    let _k = kernel(&rt, &clock, vec![("nightly".into(), spec)]).await;
    run_for(&clock, 105_000).await;
    assert!(rt.made().is_empty(), "nothing before its minute: {:?}", rt.made().len());
    run_for(&clock, 30_000).await;
    let made = rt.made();
    assert_eq!(made.len(), 1, "once on its minute, though four ticks fall in it");
    let a = &made[0];
    assert_eq!((a.prompt.as_str(), a.cwd.as_deref(), a.title.as_deref()), ("Tidy the docs", Some("/repo"), Some("nightly")));
    assert_eq!(a.lineage.triggered_by.as_deref(), Some("trigger:nightly"));
    // the rest of the day: nothing more
    run_for(&clock, 5 * 60_000).await;
    assert_eq!(rt.made().len(), 1, "a daily schedule fired twice");
}

async fn push(k: &Kernel, user: &str, text: &str, n: u32) -> Value {
    let ev = json!({ "on": "chat.message", "key": format!("chat:slack:{user}:{n}"), "at": T0, "summary": text,
        "payload": { "channel": "slack", "user": user, "text": text, "trusted": true } });
    k.call(Caller::user(), "automations.trigger.push", ev).await.unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_chat_trigger_with_users_starts_nothing_for_someone_not_listed() {
    let (rt, clock) = (Rt::default(), FakeClock::at(T0));
    let mut spec = TriggerSpec {
        on: "chat.message".into(),
        prompt: "Deploy what {event.payload.user} asked for".into(),
        project: "/repo".into(),
        users: vec!["U1".into()],
        ..TriggerSpec::default()
    };
    spec.filters.insert("channel".into(), json!("slack"));
    spec.filters.insert("keyword".into(), json!("deploy"));
    let k = kernel(&rt, &clock, vec![("deploys".into(), spec)]).await;
    push(&k, "U2", "please deploy main", 1).await;
    assert!(rt.made().is_empty(), "U2 isn't one of its users");
    push(&k, "U1", "good morning", 2).await;
    assert!(rt.made().is_empty(), "no keyword in it");
    push(&k, "U1", "please Deploy main", 3).await;
    let made = rt.made();
    let log = k.call(Caller::user(), "automations.trigger.log", json!({ "name": "deploys" })).await.unwrap();
    assert_eq!(made.len(), 1, "{log}");
    assert_eq!(made[0].prompt, "Deploy what U1 asked for");
}
