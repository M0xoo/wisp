//! Events (plan §6.11.2 rule 6): published after the command returns Ok, never for a failed one, in
//! order per subscriber, at least once, lagging past the cap; the store's commit hook.
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

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::json;
use wisp_kernel::{Caller, Event, PluginGroup, WireError};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Made {
    n: u32,
}
impl Event for Made {
    const TYPE: &'static str = "src.made";
}

cmd!(Make, "src.make", (u32, bool), ());
cmd!(Burst, "src.burst", u32, ());
cmd!(Tx, "src.tx", (), ());

fn source() -> common::P {
    common::plugin("wisp.src", json!({}), |s| {
        s.command::<Make, _, _>(|ctx, call, (n, fail)| async move {
            ctx.emit(&call, &Made { n });
            if fail { Err(WireError::conflict("no")) } else { Ok(()) }
        });
        s.command::<Burst, _, _>(|ctx, call, n| async move {
            for i in 0..n {
                ctx.emit(&call, &Made { n: i });
            }
            Ok(())
        });
        // what the store does around its transactions
        s.command::<Tx, _, _>(|ctx, call, ()| async move {
            let hook = ctx.service::<wisp_kernel::CommitHook>()?;
            ctx.emit(&call, &Made { n: 1 });
            hook.committed(&call, Some(9001));
            let mark = hook.mark(&call);
            ctx.emit(&call, &Made { n: 2 });
            hook.rolled_back(&call, mark);
            ctx.emit(&call, &Made { n: 3 });
            Ok(())
        });
    })
}

fn sink(got: Arc<Mutex<Vec<u32>>>, fails: Arc<AtomicU32>) -> common::P {
    common::plugin("wisp.sink", json!({}), move |s| {
        let (got, fails) = (got.clone(), fails.clone());
        s.on::<Made, _, _>(move |_, e| {
            let (got, fails) = (got.clone(), fails.clone());
            async move {
                assert!(!(e.n == 99 && fails.fetch_add(1, Ordering::SeqCst) < 2), "flaky subscriber");
                got.lock().unwrap().push(e.n);
            }
        });
    })
}

#[tokio::test]
async fn after_ok_only_in_order_and_at_least_once() {
    let (got, fails) = (Arc::<Mutex<Vec<u32>>>::default(), Arc::new(AtomicU32::new(0)));
    let k = common::start(PluginGroup::new().add(source()).add(sink(got.clone(), fails.clone()))).await;
    k.call(Caller::user(), "src.make", json!([1, false])).await.unwrap();
    assert!(k.call(Caller::user(), "src.make", json!([2, true])).await.is_err());
    k.call(Caller::user(), "src.burst", json!(100)).await.unwrap();
    k.idle().await;
    let g = got.lock().unwrap().clone();
    assert_eq!(g[0], 1, "the failed command's event never went out");
    assert_eq!(&g[1..], (0..100).collect::<Vec<_>>().as_slice(), "in order, and 99 delivered after two panics");
    assert_eq!(fails.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn lagging_ephemeral_subscriber_drops_and_records_diag() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let g2 = gate.clone();
    let slow = common::plugin("wisp.slow", json!({}), move |s| {
        let g = g2.clone();
        s.on::<Made, _, _>(move |_, _| {
            let g = g.clone();
            async move { g.notified().await }
        });
    });
    let k = common::start(PluginGroup::new().add(source()).add(slow)).await;
    k.call(Caller::user(), "src.burst", json!(wisp_kernel::QUEUE_CAP + 5)).await.unwrap();
    assert!(k.lagging("wisp.slow").is_some());
    assert_eq!(k.failures("wisp.slow").last().unwrap().code, "lagging");
    k.caught_up("wisp.slow");
    assert!(k.lagging("wisp.slow").is_none());
    k.set_enabled("wisp.slow", false).await.unwrap();
    k.idle().await; // dropping the queue settles the work it owed
}

#[tokio::test]
async fn the_commit_hook_publishes_on_commit_and_drops_on_rollback() {
    let seen: Arc<Mutex<Vec<(u32, Option<u64>)>>> = Arc::default();
    let s2 = seen.clone();
    let raw = common::plugin("wisp.raw", json!({}), move |s| {
        let seen = s2.clone();
        s.on_raw("src.*", move |_, env| {
            let seen = seen.clone();
            async move {
                seen.lock().unwrap().push((env.get::<Made>().map_or(0, |m| m.n), env.cursor));
                Ok(())
            }
        });
    });
    let k = common::start(PluginGroup::new().add(source()).add(raw)).await;
    k.call(Caller::user(), "src.tx", json!(null)).await.unwrap();
    k.idle().await;
    // 1 went out on commit with the store's cursor, 2 was rolled back, 3 went out when the command returned
    assert_eq!(*seen.lock().unwrap(), [(1, Some(9001)), (3, None)]);
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Made2 {
    n: u32,
    by: String,
}
impl Event for Made2 {
    const TYPE: &'static str = "src.made@2";
}

cmd!(Both, "src.both", u32, ());

#[tokio::test]
async fn event_v2_type_and_v1_type_both_emitted_for_one_minor() {
    let (v1, v2) = (Arc::<Mutex<Vec<u32>>>::default(), Arc::<Mutex<Vec<String>>>::default());
    let (a, b) = (v1.clone(), v2.clone());
    let src = common::plugin("wisp.src", json!({}), |s| {
        s.command::<Both, _, _>(|ctx, call, n| async move { ctx.emit_versions(&call, &Made2 { n, by: "ada".into() }, &Made { n }) });
    });
    let old = common::plugin("wisp.old", json!({}), move |s| {
        let a = a.clone();
        s.on::<Made, _, _>(move |_, e| {
            let a = a.clone();
            async move { a.lock().unwrap().push(e.n) }
        });
    });
    let new = common::plugin("wisp.new", json!({}), move |s| {
        let b = b.clone();
        s.on::<Made2, _, _>(move |_, e| {
            let b = b.clone();
            async move { b.lock().unwrap().push(e.by) }
        });
    });
    let k = common::start(PluginGroup::new().add(src).add(old).add(new)).await;
    k.call(Caller::user(), "src.both", json!(7)).await.unwrap();
    k.idle().await;
    assert_eq!(
        (v1.lock().unwrap().clone(), v2.lock().unwrap().clone()),
        (vec![7], vec!["ada".to_owned()]),
        "an old subscriber keeps getting the old shape"
    );
}
