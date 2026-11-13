//! Benches for the kernel's hot paths (ADR-0011), run on demand:
//! `cargo test --release -p wisp-kernel --test kernel_bench -- --ignored --nocapture`
//! Dispatch overhead: a no-op command through the permission check and the trace, typed (in-process)
//! and JSON (the edge). Event throughput: one command emitting N events to one subscriber.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::cast_precision_loss, clippy::print_stderr)]
mod common;

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::json;
use wisp_kernel::{Caller, Event, PluginGroup};

cmd!(Noop, "bench.noop", (), ());
cmd!(Burst, "bench.burst", u64, ());
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Tick(u64);
impl Event for Tick {
    const TYPE: &'static str = "bench.tick";
}

fn plugins(got: Arc<AtomicU64>) -> PluginGroup {
    let b = common::plugin("wisp.bench", json!({}), |s| {
        s.command::<Noop, _, _>(|_, _, ()| async { Ok(()) });
        s.command::<Burst, _, _>(|ctx, call, n| async move {
            for i in 0..n {
                ctx.emit(&call, &Tick(i));
            }
            Ok(())
        });
    });
    // a second plugin calling into the first: the permission check runs on both sets
    let c = common::plugin("wisp.caller", json!({ "permissions": ["bench:noop"] }), move |s| {
        let got = got.clone();
        s.on::<Tick, _, _>(move |_, _| {
            let got = got.clone();
            async move {
                got.fetch_add(1, Ordering::Relaxed);
            }
        });
    });
    PluginGroup::new().add(b).add(c)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "bench: run with --release --ignored --nocapture"]
async fn bench_dispatch_and_events() {
    let got = Arc::new(AtomicU64::new(0));
    let k = common::start(plugins(got.clone())).await;
    let ctx = k.ctx("wisp.caller").unwrap();
    let root = ctx.root_call();
    let n = 200_000u32;
    for _ in 0..10_000 {
        ctx.run::<Noop>(&root, ()).await.unwrap();
    }
    let t = Instant::now();
    for _ in 0..n {
        ctx.run::<Noop>(&root, ()).await.unwrap();
    }
    let typed = t.elapsed().as_nanos() as f64 / f64::from(n);
    let t = Instant::now();
    for _ in 0..n {
        k.call(Caller::user(), "bench.noop", serde_json::Value::Null).await.unwrap();
    }
    let edge = t.elapsed().as_nanos() as f64 / f64::from(n);
    let events = 500_000u64;
    let t = Instant::now();
    k.call(Caller::user(), "bench.burst", json!(events)).await.unwrap();
    k.idle().await;
    let secs = t.elapsed().as_secs_f64();
    // the subscriber drains while the burst is published: it gets at least the cap, the rest lags
    let delivered = got.load(Ordering::Relaxed);
    assert!(delivered >= wisp_kernel::QUEUE_CAP as u64, "{delivered}");
    k.caught_up("wisp.caller");
    // below the cap: many commands, each a few events, all delivered
    got.store(0, Ordering::Relaxed);
    let t = Instant::now();
    let rounds = 2_000u64;
    for _ in 0..rounds {
        k.call(Caller::user(), "bench.burst", json!(50)).await.unwrap();
    }
    k.idle().await;
    let steady = (rounds * 50) as f64 / t.elapsed().as_secs_f64();
    assert_eq!(got.load(Ordering::Relaxed), rounds * 50);
    eprintln!("dispatch, typed nested (plugin → plugin, 2 permission sets + trace): {typed:.0} ns/call");
    eprintln!("dispatch, edge JSON (user:full, args/result as JSON): {edge:.0} ns/call");
    eprintln!(
        "publish, one burst of {events} (cap {}): {:.0} events/s published, {delivered} delivered, rest lagging",
        wisp_kernel::QUEUE_CAP,
        events as f64 / secs
    );
    eprintln!("publish + deliver, 2000 commands x 50 events, 1 subscriber: {steady:.0} events/s");
}
