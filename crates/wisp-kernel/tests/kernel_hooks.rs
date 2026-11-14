//! Interceptors (plan §6.1b, §6.11.2 rules 3–5): priority order, modify, veto with `then`, time
//! budgets with failure closed/open, no re-entering a (plugin, hook) pair, random order under test.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::needless_pass_by_value,
    clippy::type_complexity,
    clippy::too_many_lines,
    clippy::too_many_arguments,
    clippy::many_single_char_names
)]
mod common;

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use wisp_kernel::{Caller, Code, Failure, FollowUp, Hook, InterceptOpts, PluginGroup, Verdict};

struct Before;
impl Hook for Before {
    const ID: &'static str = "before:run";
    type Ctx = Value;
}

cmd!(Run, "owner.run", Value, Value);
cmd!(Note, "owner.note", String, ());

type Log = Arc<Mutex<Vec<String>>>;

fn owner(log: Log) -> common::P {
    common::plugin("wisp.owner", json!({}), move |s| {
        s.command::<Run, _, _>(|ctx, call, v| async move { ctx.run_hook::<Before>(&call, v).await });
        let log = log.clone();
        s.command::<Note, _, _>(move |_, call, t| {
            let log = log.clone();
            async move {
                log.lock().unwrap().push(format!("note:{t}:depth{}", call.depth()));
                Ok(())
            }
        });
    })
}

fn guard(
    id: &str,
    priority: i32,
    failure: Failure,
    timeout_ms: u64,
    f: impl Fn(Value) -> Verdict<Value> + Send + Sync + Clone + 'static,
    sleep_ms: u64,
    log: Log,
) -> common::P {
    let name = id.to_owned();
    common::plugin(id, json!({ "permissions": ["owner:note"] }), move |s| {
        let (f, log, name) = (f.clone(), log.clone(), name.clone());
        s.intercept::<Before, _, _>(InterceptOpts { priority, failure, timeout_ms }, move |_, _, c| {
            let (f, log, name) = (f.clone(), log.clone(), name.clone());
            async move {
                log.lock().unwrap().push(name);
                if sleep_ms > 0 {
                    tokio::time::sleep(std::time::Duration::from_millis(sleep_ms)).await;
                }
                f(c)
            }
        });
    })
}

fn cont(_: Value) -> Verdict<Value> {
    Verdict::Continue
}

#[tokio::test]
async fn order_modify_and_veto_with_follow_ups() {
    let log: Log = Arc::default();
    let add = |c: Value| Verdict::Modify { ctx: json!({ "n": c["n"].as_i64().unwrap_or(0) + 1 }) };
    let no = |c: Value| {
        if c["n"] == 2 {
            Verdict::Veto {
                code: "budget_exceeded".into(),
                message: "over".into(),
                then: vec![FollowUp { cmd: "owner.note".into(), args: json!("sorry") }],
            }
        } else {
            Verdict::Continue
        }
    };
    let g = PluginGroup::new()
        .add(owner(log.clone()))
        .add(guard("acme.c", 5, Failure::Open, 200, no, 0, log.clone()))
        .add(guard("acme.a", -1, Failure::Open, 200, add, 0, log.clone()))
        .add(guard("acme.b", 0, Failure::Open, 200, add, 0, log.clone()));
    let k = common::start(g).await;
    let e = k.call(Caller::user(), "owner.run", json!({ "n": 0 })).await.unwrap_err();
    assert_eq!(e.code, Code::Vetoed);
    assert_eq!(e.details.unwrap(), json!({ "by": "acme.c", "reason": "budget_exceeded", "hook": "before:run" }));
    k.idle().await;
    // the follow-up ran after, as a new root call (depth 0) speaking for acme.c
    assert_eq!(*log.lock().unwrap(), ["acme.a", "acme.b", "acme.c", "note:sorry:depth0"]);
    log.lock().unwrap().clear();
    assert_eq!(k.call(Caller::user(), "owner.run", json!({ "n": 5 })).await.unwrap(), json!({ "n": 7 }));
}

#[tokio::test]
async fn a_slow_guard_vetoes_and_a_slow_open_one_is_skipped() {
    let log: Log = Arc::default();
    let k = common::start(PluginGroup::new().add(owner(log.clone())).add(guard("acme.slow", 0, Failure::Open, 20, cont, 500, log.clone())))
        .await;
    assert_eq!(k.call(Caller::user(), "owner.run", json!(1)).await.unwrap(), json!(1));
    assert_eq!(k.failures("acme.slow").last().unwrap().code, "timeout");
    let k = common::start(PluginGroup::new().add(owner(log.clone())).add(guard("acme.slow", 0, Failure::Closed, 20, cont, 500, log))).await;
    let e = k.call(Caller::user(), "owner.run", json!(1)).await.unwrap_err();
    assert_eq!(e.code, Code::Vetoed);
    assert!(e.message.contains("didn't answer before:run within 20 ms"), "{}", e.message);
}

#[tokio::test]
async fn timeouts_are_capped_at_two_seconds() {
    let log: Log = Arc::default();
    let k = common::start(PluginGroup::new().add(owner(log.clone())).add(guard("acme.slow", 0, Failure::Closed, 60_000, cont, 5_000, log)))
        .await;
    let t = std::time::Instant::now();
    assert!(k.call(Caller::user(), "owner.run", json!(1)).await.is_err());
    let ms = t.elapsed().as_millis();
    assert!((1900..3000).contains(&ms), "{ms}");
}

#[tokio::test]
async fn an_interceptor_cannot_re_enter_its_own_hook() {
    let p = common::plugin("wisp.owner", json!({}), |s| {
        s.command::<Run, _, _>(|ctx, call, v| async move { ctx.run_hook::<Before>(&call, v).await });
        s.intercept::<Before, _, _>(InterceptOpts { failure: Failure::Closed, ..Default::default() }, |ctx, call, c| async move {
            match ctx.run_hook::<Before>(&call, c).await {
                Err(e) if e.code == Code::ReentrantHook => Verdict::Modify { ctx: json!("refused re-entry") },
                other => Verdict::Veto { code: "bad".into(), message: format!("{other:?}"), then: Vec::new() },
            }
        });
    });
    let k = common::start(PluginGroup::new().add(p)).await;
    assert_eq!(k.call(Caller::user(), "owner.run", json!(1)).await.unwrap(), json!("refused re-entry"));
    assert!(
        k.refusals()
            .iter()
            .any(|r| { r.code == "reentrant_hook" && r.stack.iter().filter(|f| *f == "wisp.owner:before:run").count() == 2 })
    );
}

#[tokio::test]
async fn random_order_among_equal_priorities_and_injected_slowness() {
    let log: Log = Arc::default();
    let g = PluginGroup::new()
        .add(owner(log.clone()))
        .add(guard("acme.a", 0, Failure::Open, 200, cont, 0, log.clone()))
        .add(guard("acme.b", 0, Failure::Open, 200, cont, 0, log.clone()))
        .add(guard("acme.c", 0, Failure::Closed, 50, cont, 0, log.clone()));
    let k = common::start(g).await;
    let mut orders = std::collections::BTreeSet::new();
    for seed in 0..16 {
        k.chaos(Some(seed), Vec::new());
        log.lock().unwrap().clear();
        k.call(Caller::user(), "owner.run", json!(1)).await.unwrap();
        orders.insert(log.lock().unwrap().join(","));
    }
    assert!(orders.len() > 1, "a seeded shuffle changes the order: {orders:?}");
    k.chaos(None, vec![("acme.c".into(), "before:run".into(), 200)]);
    assert_eq!(k.call(Caller::user(), "owner.run", json!(1)).await.unwrap_err().code, Code::Vetoed, "a slow guard fails closed");
}
