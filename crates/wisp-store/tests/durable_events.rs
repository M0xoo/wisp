//! Durable events (ADR-0044) with a real store under the kernel: appended in the command's transaction,
//! replayed from a cursor, effectively once, deduped, trimmed, parked and retried.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::too_many_lines)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use wisp_kernel::durable::{Durable, EventLog, EventLogService};
use wisp_kernel::{App, Caller, Command, Event, Kernel, Manifest, Plugin, PluginGroup, Result, Setup, WireError};
use wisp_store::{Col, EntityDef, Location, ManualClock, Migration, Row, Store};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Made {
    n: u32,
    #[serde(default)]
    key: Option<String>,
}
impl Event for Made {
    const TYPE: &'static str = "src.made";
    const DURABLE: bool = true;
    fn key(&self) -> Option<String> {
        self.key.clone()
    }
    fn subject(&self) -> Option<String> {
        Some(format!("n{}", self.n))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct MakeArgs {
    n: u32,
    #[serde(default)]
    count: u32,
    #[serde(default)]
    key: Option<String>,
    /// fail the write (rolled back)
    #[serde(default)]
    fail_write: bool,
    /// write nothing
    #[serde(default)]
    no_write: bool,
}

struct MakeCmd;
impl Command for MakeCmd {
    const ID: &'static str = "src.make";
    type Args = MakeArgs;
    type Out = ();
}

struct RetryCmd;
impl Command for RetryCmd {
    const ID: &'static str = "sink.retry";
    type Args = u64;
    type Out = usize;
}

fn on_notes(_: &Row) -> Vec<String> {
    vec!["plugin:wisp.src:notes".into()]
}

const NOTE: EntityDef = EntityDef { kind: "src_note", table: "src_note", key: "id", columns: &[("id", Col::Text), ("body", Col::Text)], json_columns: &[], parent: None, seq: None, topics: on_notes };

fn note(id: &str) -> Row {
    let mut r = Row::new();
    r.insert("id".into(), json!(id));
    r.insert("body".into(), json!("x"));
    r
}

struct P {
    id: &'static str,
    f: Arc<dyn Fn(&mut Setup) + Send + Sync>,
}

impl Plugin for P {
    fn manifest(&self) -> Manifest {
        Manifest::from_value(json!({ "wispPlugin": 1, "id": self.id, "version": "1.0.0", "api": "^1", "permissions": ["src:make"] })).unwrap()
    }
    fn setup(&self, s: &mut Setup) -> Result<()> {
        (self.f)(s);
        Ok(())
    }
}

fn store_of(k: &wisp_kernel::Ctx) -> Store {
    k.service::<Store>().unwrap().as_ref().clone()
}

/// The source: `src.make` emits `count` (or 1) durable events, then writes a note (or not, or a failing write).
fn source() -> P {
    P {
        id: "wisp.src",
        f: Arc::new(|s| {
            s.command::<MakeCmd, _, _>(|ctx, call, a| async move {
                for i in 0..a.count.max(1) {
                    ctx.emit(&call, &Made { n: a.n + i, key: a.key.clone() });
                }
                if a.no_write {
                    return Ok(());
                }
                let st = store_of(&ctx);
                let fail = a.fail_write;
                let id = format!("made-{}", a.n);
                st.write(move |w| {
                    w.upsert(NOTE.kind, note(&id))?;
                    if fail {
                        return Err(wisp_store::StoreError::Internal("injected".into()));
                    }
                    Ok(())
                })
                .await
                .map_err(|e| WireError::internal(e.to_string()))
            });
        }),
    }
}

#[derive(Default)]
struct Seen {
    got: Mutex<Vec<u32>>,
    depths: Mutex<Vec<u32>>,
    gaps: Mutex<Vec<(u64, u64)>>,
    tries: AtomicU32,
}

/// The sink: a durable subscription that records what it saw and writes one effect row per event.
fn sink(seen: Arc<Seen>, mode: &'static str) -> P {
    P {
        id: "wisp.sink",
        f: Arc::new(move |s| {
            let seen = seen.clone();
            s.on_durable::<Made, _, _>("count", move |ctx, call, d| {
                let seen = seen.clone();
                async move {
                    match d {
                        Durable::Gap { from, to } => {
                            seen.gaps.lock().unwrap().push((from, to));
                            Ok(())
                        }
                        Durable::Event { event, seq, .. } => {
                            let t = seen.tries.fetch_add(1, Ordering::SeqCst);
                            match mode {
                                "fail-write-once" if t == 0 => {
                                    // the effect and the cursor roll back together
                                    let st = store_of(&ctx);
                                    let r = st
                                        .write(move |w| {
                                            w.upsert(NOTE.kind, note(&format!("effect-{seq}")))?;
                                            Err::<(), _>(wisp_store::StoreError::Internal("crash before commit".into()))
                                        })
                                        .await;
                                    return r.map_err(|e| WireError::internal(e.to_string()));
                                }
                                "panic-after-write" => {
                                    let st = store_of(&ctx);
                                    st.write(move |w| w.upsert(NOTE.kind, note(&format!("effect-{seq}"))).map(|_| ())).await.unwrap();
                                    panic!("after the write");
                                }
                                "always-fail" => return Err(WireError::internal("no")),
                                "chain" => {
                                    seen.depths.lock().unwrap().push(call.cause_depth());
                                    seen.got.lock().unwrap().push(event.n);
                                    if event.n < 5 {
                                        ctx.run_json(&call, "src.make", json!({ "n": event.n + 1, "noWrite": true, "no_write": true })).await?;
                                    }
                                    return Ok(());
                                }
                                _ => {}
                            }
                            let st = store_of(&ctx);
                            st.write(move |w| w.upsert(NOTE.kind, note(&format!("effect-{seq}"))).map(|_| ())).await.map_err(|e| WireError::internal(e.to_string()))?;
                            seen.got.lock().unwrap().push(event.n);
                            Ok(())
                        }
                    }
                }
            });
            s.command::<RetryCmd, _, _>(|ctx, _call, seq| async move { ctx.retry_event(seq).await });
        }),
    }
}

/// An in-process (ephemeral-path) subscriber to the same type.
fn live(got: Arc<Mutex<Vec<u32>>>) -> P {
    P {
        id: "wisp.live",
        f: Arc::new(move |s| {
            let got = got.clone();
            s.on::<Made, _, _>(move |_, e| {
                let got = got.clone();
                async move { got.lock().unwrap().push(e.n) }
            });
        }),
    }
}

fn open(path: &Path) -> Store {
    let now = i64::try_from(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()).unwrap();
    let st = Store::open(Location::Path(path.to_path_buf()), Arc::new(ManualClock::new(now))).unwrap();
    st.migrate("src", &[Migration::sql(1, "CREATE TABLE src_note (id TEXT PRIMARY KEY, body TEXT) STRICT;")]).unwrap();
    st.define_entity(NOTE).unwrap();
    st
}

async fn kernel(st: &Store, plugins: Vec<P>) -> Kernel {
    let mut g = PluginGroup::new();
    for p in plugins {
        g = g.add(p);
    }
    App::new().service(st.clone()).service(EventLogService(Arc::new(st.clone()))).plugins(g).start().await.unwrap()
}

fn temp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("wisp-durable-{name}-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    std::fs::create_dir_all(&d).unwrap();
    d.join("wisp.db")
}

async fn make(k: &Kernel, args: Value) -> std::result::Result<Value, WireError> {
    k.call(Caller::user(), "src.make", args).await
}

fn notes(st: &Store) -> Vec<String> {
    st.read(|r| Ok(r.query(NOTE.kind, &wisp_store::Query::new())?.iter().filter_map(|x| x.get("id").and_then(Value::as_str).map(str::to_owned)).collect::<Vec<_>>())).unwrap()
}

async fn settle(k: &Kernel) {
    tokio::time::timeout(Duration::from_secs(20), k.idle()).await.expect("settles");
}

#[tokio::test(flavor = "multi_thread")]
async fn durable_event_rolled_back_with_its_command_is_never_seen() {
    let path = temp("rollback");
    let st = open(&path);
    let seen = Arc::new(Seen::default());
    let live_got = Arc::new(Mutex::new(Vec::new()));
    let k = kernel(&st, vec![source(), sink(seen.clone(), ""), live(live_got.clone())]).await;
    assert!(make(&k, json!({ "n": 1, "fail_write": true })).await.is_err());
    make(&k, json!({ "n": 2 })).await.unwrap();
    settle(&k).await;
    let rows = EventLog::read(&st, 0, 100).await.unwrap();
    assert_eq!(rows.iter().map(|r| r.event.data["n"].as_u64().unwrap()).collect::<Vec<_>>(), [2], "the rolled-back one isn't in the log");
    assert_eq!(*seen.got.lock().unwrap(), [2]);
    assert_eq!(*live_got.lock().unwrap(), [2]);
    // in the command's own transaction: the note and the event together
    assert!(notes(&st).contains(&"made-2".to_owned()) && !notes(&st).contains(&"made-1".to_owned()));
    assert_eq!(rows[0].event.subject.as_deref(), Some("n2"));
}

#[tokio::test(flavor = "multi_thread")]
async fn restart_replays_from_cursor_without_loss_or_duplicate_effect() {
    let path = temp("restart");
    let seen = Arc::new(Seen::default());
    {
        let st = open(&path);
        let k = kernel(&st, vec![source(), sink(seen.clone(), "")]).await;
        make(&k, json!({ "n": 1 })).await.unwrap();
        settle(&k).await;
        assert_eq!(*seen.got.lock().unwrap(), [1]);
    }
    {
        // the sink isn't here (switched off, or not yet started): events go on being made
        let st = open(&path);
        let k = kernel(&st, vec![source()]).await;
        make(&k, json!({ "n": 2 })).await.unwrap();
        make(&k, json!({ "n": 3, "no_write": true })).await.unwrap();
        settle(&k).await;
    }
    let st = open(&path);
    let again = Arc::new(Seen::default());
    let k = kernel(&st, vec![source(), sink(again.clone(), "")]).await;
    settle(&k).await;
    assert_eq!(*again.got.lock().unwrap(), [2, 3], "replayed from its cursor: not 1 again, and nothing lost");
    let effects: Vec<String> = notes(&st).into_iter().filter(|n| n.starts_with("effect-")).collect();
    assert_eq!(effects.len(), 3, "{effects:?}");
    assert_eq!(st.cursor("wisp.sink", "count").await.unwrap(), Some(3));
}

#[tokio::test(flavor = "multi_thread")]
async fn crash_between_handler_write_and_cursor_cannot_happen() {
    // the handler's write fails before commit: its effect and its cursor roll back together, and the retry does both
    let st = open(&temp("crash-a"));
    let seen = Arc::new(Seen::default());
    let k = kernel(&st, vec![source(), sink(seen.clone(), "fail-write-once")]).await;
    make(&k, json!({ "n": 7, "no_write": true })).await.unwrap();
    settle(&k).await;
    assert_eq!(*seen.got.lock().unwrap(), [7]);
    assert_eq!(notes(&st).iter().filter(|n| n.starts_with("effect-")).count(), 1);
    assert_eq!(st.cursor("wisp.sink", "count").await.unwrap(), Some(1));
    drop(k);
    // the handler crashes after its write committed: the cursor rode on it, so the effect isn't repeated
    let st = open(&temp("crash-b"));
    let seen = Arc::new(Seen::default());
    let k = kernel(&st, vec![source(), sink(seen.clone(), "panic-after-write")]).await;
    make(&k, json!({ "n": 8, "no_write": true })).await.unwrap();
    settle(&k).await;
    assert_eq!(seen.tries.load(Ordering::SeqCst), 1, "no retry after the write committed");
    assert_eq!(notes(&st).iter().filter(|n| n.starts_with("effect-")).count(), 1);
    assert_eq!(st.cursor("wisp.sink", "count").await.unwrap(), Some(1));
}

#[tokio::test(flavor = "multi_thread")]
async fn lagging_durable_subscriber_reads_the_table_then_rejoins_live_in_order() {
    let path = temp("lag");
    let n = u32::try_from(wisp_kernel::durable::RING).unwrap() + 500;
    {
        let st = open(&path);
        let k = kernel(&st, vec![source()]).await;
        // a subscriber that knew the log before this burst: its cursor is at 0
        st.set_cursor("wisp.sink", "count", 0).await.unwrap();
        make(&k, json!({ "n": 0, "count": n, "no_write": true })).await.unwrap();
        settle(&k).await;
    }
    let st = open(&path);
    let seen = Arc::new(Seen::default());
    let k = kernel(&st, vec![source(), sink(seen.clone(), "")]).await;
    settle(&k).await;
    make(&k, json!({ "n": 100_000, "no_write": true })).await.unwrap();
    settle(&k).await;
    let got = seen.got.lock().unwrap().clone();
    assert_eq!(got.len(), n as usize + 1);
    assert!(got[..n as usize].iter().enumerate().all(|(i, x)| *x == u32::try_from(i).unwrap()), "in order from the table");
    assert_eq!(*got.last().unwrap(), 100_000, "then live");
}

#[tokio::test(flavor = "multi_thread")]
async fn cursor_past_retention_gets_gap_and_resyncs_state() {
    let path = temp("gap");
    let st = open(&path);
    st.set_cursor("wisp.sink", "count", 0).await.unwrap();
    {
        let k = kernel(&st, vec![source()]).await;
        make(&k, json!({ "n": 1, "count": 5, "no_write": true })).await.unwrap();
        settle(&k).await;
    }
    // only the newest 2 are kept
    st.trim_events(i64::MAX, 2).await.unwrap();
    let seen = Arc::new(Seen::default());
    let k = kernel(&st, vec![source(), sink(seen.clone(), "")]).await;
    settle(&k).await;
    assert_eq!(*seen.gaps.lock().unwrap(), [(1, 3)], "once, for what's gone");
    assert_eq!(*seen.got.lock().unwrap(), [4, 5]);
    assert!(k.failures("wisp.sink").iter().any(|f| f.code == "gap"));
}

#[tokio::test(flavor = "multi_thread")]
async fn same_type_and_key_within_24h_recorded_once() {
    let st = open(&temp("dedupe"));
    let live_got = Arc::new(Mutex::new(Vec::new()));
    let k = kernel(&st, vec![source(), live(live_got.clone())]).await;
    make(&k, json!({ "n": 1, "key": "pr-42" })).await.unwrap();
    make(&k, json!({ "n": 2, "key": "pr-42" })).await.unwrap();
    make(&k, json!({ "n": 3, "key": "pr-43", "no_write": true })).await.unwrap();
    settle(&k).await;
    let rows = EventLog::read(&st, 0, 10).await.unwrap();
    assert_eq!(rows.iter().map(|r| r.event.key.clone().unwrap()).collect::<Vec<_>>(), ["pr-42", "pr-43"]);
    assert_eq!(*live_got.lock().unwrap(), [1, 3], "a repeat isn't published either");
    // a store opened again remembers the last day's keys
    let path = st.home().unwrap().join("wisp.db");
    drop(k);
    drop(st);
    let st = open(&path);
    let k = kernel(&st, vec![source()]).await;
    make(&k, json!({ "n": 4, "key": "pr-42", "no_write": true })).await.unwrap();
    settle(&k).await;
    assert_eq!(EventLog::read(&st, 0, 10).await.unwrap().len(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn causation_chain_depth_cuts_trigger_loops_at_3() {
    let st = open(&temp("cause"));
    let seen = Arc::new(Seen::default());
    let k = kernel(&st, vec![source(), sink(seen.clone(), "chain")]).await;
    make(&k, json!({ "n": 1, "no_write": true })).await.unwrap();
    settle(&k).await;
    assert_eq!(*seen.got.lock().unwrap(), [1, 2, 3, 4, 5]);
    // each handler's call knows how deep it is; what a trigger refuses past 3 (ADR-0043)
    assert_eq!(*seen.depths.lock().unwrap(), [1, 2, 3, 4, 5]);
    let rows = EventLog::read(&st, 0, 10).await.unwrap();
    assert_eq!(rows[0].event.cause, None);
    assert_eq!(rows[1].event.cause, Some(rows[0].seq));
    assert_eq!(rows[4].event.cause, Some(rows[3].seq));
}

#[tokio::test(flavor = "multi_thread")]
async fn plugin_switched_off_keeps_its_cursor_and_resumes_on_again() {
    let st = open(&temp("off"));
    let seen = Arc::new(Seen::default());
    let k = kernel(&st, vec![source(), sink(seen.clone(), "")]).await;
    make(&k, json!({ "n": 1 })).await.unwrap();
    settle(&k).await;
    k.set_enabled("wisp.sink", false).await.unwrap();
    make(&k, json!({ "n": 2 })).await.unwrap();
    make(&k, json!({ "n": 3 })).await.unwrap();
    settle(&k).await;
    assert_eq!(*seen.got.lock().unwrap(), [1]);
    k.set_enabled("wisp.sink", true).await.unwrap();
    settle(&k).await;
    assert_eq!(*seen.got.lock().unwrap(), [1, 2, 3]);
}

#[tokio::test(flavor = "multi_thread")]
async fn handler_panic_retried_3_times_then_parked_with_reason() {
    let st = open(&temp("park"));
    let seen = Arc::new(Seen::default());
    let k = kernel(&st, vec![source(), sink(seen.clone(), "always-fail")]).await;
    make(&k, json!({ "n": 1, "no_write": true })).await.unwrap();
    make(&k, json!({ "n": 2, "no_write": true })).await.unwrap();
    settle(&k).await;
    assert_eq!(seen.tries.load(Ordering::SeqCst), 6, "3 tries each");
    let parked = st.parked().await.unwrap();
    assert_eq!(parked.iter().map(|p| (p.seq, p.why.as_str())).collect::<Vec<_>>(), [(1, "no"), (2, "no")]);
    // the cursor moved on: the next one isn't held up
    assert_eq!(st.cursor("wisp.sink", "count").await.unwrap(), Some(2));
    // retry delivers it again (and fails again: parked again)
    let n = k.call(Caller::plugin("wisp.sink"), "sink.retry", json!(1)).await.unwrap();
    settle(&k).await;
    assert_eq!(n, json!(1));
    assert_eq!(seen.tries.load(Ordering::SeqCst), 9);
    assert_eq!(st.parked().await.unwrap().len(), 2);
}
