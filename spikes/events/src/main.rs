//! ADR-0044's budgets: emit → handler p99, durable append rate, replay of 100 k. Exits 1 on a miss.
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::json;
use wisp_kernel::durable::{Durable, EventLog, EventLogService, NewEvent};
use wisp_kernel::{App, Caller, Command, Event, Manifest, Plugin, PluginGroup, Result, Setup};
use wisp_store::{Location, Store, SystemClock};

const P99_MS: f64 = 1.0;
const APPEND_PER_S: f64 = 20_000.0;
const REPLAY_MS: u128 = 1_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Ping {
    at: u64,
}
impl Event for Ping {
    const TYPE: &'static str = "bench.ping";
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Fact {
    n: u64,
}
impl Event for Fact {
    const TYPE: &'static str = "bench.fact";
    const DURABLE: bool = true;
}

struct Emit;
impl Command for Emit {
    const ID: &'static str = "bench.emit";
    type Args = u64;
    type Out = ();
}

struct P(&'static str, Arc<dyn Fn(&mut Setup) + Send + Sync>);
impl Plugin for P {
    fn manifest(&self) -> Manifest {
        Manifest::from_value(json!({ "wispPlugin": 1, "id": self.0, "version": "1.0.0", "api": "^1", "permissions": ["bench:emit"] })).unwrap_or_else(|e| panic!("{e:?}"))
    }
    fn setup(&self, s: &mut Setup) -> Result<()> {
        (self.1)(s);
        Ok(())
    }
}

fn now_us(t0: Instant) -> u64 {
    u64::try_from(t0.elapsed().as_micros()).unwrap_or(u64::MAX)
}

async fn latency() -> f64 {
    let t0 = Instant::now();
    let lat = Arc::new(Mutex::new(Vec::<u64>::new()));
    let l2 = lat.clone();
    let src = P("wisp.bench", Arc::new(|s| {
        s.command::<Emit, _, _>(move |ctx, call, at| async move {
            ctx.emit(&call, &Ping { at });
            Ok(())
        });
    }));
    let sink = P("wisp.sink", Arc::new(move |s| {
        let l = l2.clone();
        s.on::<Ping, _, _>(move |_, e| {
            let l = l.clone();
            async move { l.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(now_us(t0).saturating_sub(e.at)) }
        });
    }));
    let k = App::new().plugins(PluginGroup::new().add(src).add(sink)).start().await.unwrap_or_else(|e| panic!("{e:?}"));
    for _ in 0..5_000 {
        let _ = k.call(Caller::user(), "bench.emit", json!(now_us(t0))).await;
        k.idle().await;
    }
    let mut v = lat.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
    v.sort_unstable();
    let p99 = v.get(v.len() * 99 / 100).copied().unwrap_or(0);
    #[allow(clippy::cast_precision_loss)]
    let ms = p99 as f64 / 1000.0;
    ms
}

fn store(dir: &std::path::Path) -> Store {
    Store::open(Location::Path(dir.join("wisp.db")), Arc::new(SystemClock)).unwrap_or_else(|e| panic!("{e}"))
}

fn row(n: u64) -> NewEvent {
    NewEvent { ty: "bench.fact".into(), plugin: "wisp.bench".into(), subject: Some(format!("s{}", n % 100)), key: None, cause: None, root: "r".into(), at: 0, data: json!({ "n": n }) }
}

async fn append_rate(st: &Store) -> f64 {
    let n = 100_000u64;
    let t = Instant::now();
    for chunk in 0..(n / 1000) {
        let rows: Vec<NewEvent> = (0..1000).map(|i| row(chunk * 1000 + i)).collect();
        st.append(rows).await.unwrap_or_else(|e| panic!("{e:?}"));
    }
    #[allow(clippy::cast_precision_loss)]
    let r = n as f64 / t.elapsed().as_secs_f64();
    r
}

async fn per_command(st: &Store) -> f64 {
    let src = P("wisp.bench", Arc::new(|s| {
        s.command::<Emit, _, _>(|ctx, call, n| async move {
            ctx.emit(&call, &Fact { n });
            Ok(())
        });
    }));
    let k = App::new().service(st.clone()).service(EventLogService(Arc::new(st.clone()))).plugins(PluginGroup::new().add(src)).start().await.unwrap_or_else(|e| panic!("{e:?}"));
    let n = 2_000u64;
    let t = Instant::now();
    for i in 0..n {
        let _ = k.call(Caller::user(), "bench.emit", json!(i)).await;
    }
    k.idle().await;
    #[allow(clippy::cast_precision_loss)]
    let r = n as f64 / t.elapsed().as_secs_f64();
    r
}

async fn replay(st: &Store) -> Duration {
    // a subscription that knew the log from its start: everything is behind it
    st.set_cursor("wisp.sub", "all", 0).await.unwrap_or_else(|e| panic!("{e:?}"));
    let got = Arc::new(AtomicU64::new(0));
    let g = got.clone();
    let sub = P("wisp.sub", Arc::new(move |s| {
        let g = g.clone();
        s.on_durable::<Fact, _, _>("all", move |_, _, d| {
            let g = g.clone();
            async move {
                if let Durable::Event { .. } = d {
                    g.fetch_add(1, Ordering::Relaxed);
                }
                Ok(())
            }
        });
    }));
    let (_, last) = st.bounds().await.unwrap_or_else(|e| panic!("{e:?}"));
    let t = Instant::now();
    let k = App::new().service(st.clone()).service(EventLogService(Arc::new(st.clone()))).plugins(PluginGroup::new().add(sub)).start().await.unwrap_or_else(|e| panic!("{e:?}"));
    k.idle().await;
    let took = t.elapsed();
    assert_eq!(got.load(Ordering::Relaxed), last, "every event replayed");
    took
}

#[tokio::main]
async fn main() {
    let dir = std::env::temp_dir().join(format!("wisp-events-bench-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap_or_else(|e| panic!("{e}"));
    let p99 = latency().await;
    let st = store(&dir);
    let rate = append_rate(&st).await;
    let per_cmd = per_command(&st).await;
    let took = replay(&st).await;
    println!("emit → in-process handler p99: {p99:.3} ms (≤ {P99_MS} ms)");
    println!("durable append: {rate:.0} events/s, 1 000 a transaction (≥ {APPEND_PER_S})");
    println!("one durable event per command, its own transaction: {per_cmd:.0} commands/s (reported)");
    println!("replay of 100 000: {} ms (≤ {REPLAY_MS} ms)", took.as_millis());
    let _ = std::fs::remove_dir_all(&dir);
    let ok = p99 <= P99_MS && rate >= APPEND_PER_S && took.as_millis() <= REPLAY_MS;
    std::process::exit(i32::from(!ok));
}
