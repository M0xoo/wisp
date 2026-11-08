//! The sync endpoints (ADR-0005, plan §4.3) and the v1 event stream.
//!   GET  /api/events?topics&cursor…  the v2 stream (any hello key in the query): wisp-sync's, mounted
//!   GET  /api/events                 a v1 client: hello, then every broadcast by name, a ping every 25 s
//!   POST /api/events                 sub, unsub, window, mutate for an open v2 stream (X-Wisp-Client)
//!   POST /api/cmd                    a command by Idempotency-Key, outside any stream → `Kernel::call`
//! wisp-sync plugs in through `SyncMount`; until it is mounted the v2 calls answer 503 (retry) and v1
//! clients work as before. The `Hub` is also the kernel's `notify` service: a notice reaches v2 streams
//! as a `notice` frame and v1 streams as an event of that name.
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, RwLock};

use bytes::Bytes;
use serde_json::{Value, json};
use tokio::sync::{OnceCell, mpsc};
use wisp_kernel::services::Notify;
use wisp_kernel::{BoxFuture, Caller, Result, WireError};

/// The query keys that make GET /api/events a v2 hello (packages/sync `HelloQuery`).
pub const HELLO_KEYS: [&str; 9] = [
    "proto_min",
    "proto_max",
    "client_id",
    "build",
    "epoch",
    "cursor",
    "topics",
    "fresh",
    "passive",
];
pub const PING_SECS: u64 = 25;
/// Frames a v1 client may fall behind by before it is dropped (it reconnects and reloads).
const LEGACY_QUEUE: usize = 1024;
/// Command results remembered for a retry over a flaky tunnel.
const IDEM_KEPT: usize = 10_000;

/// What wisp-sync provides to the edge.
pub trait SyncMount: Send + Sync + 'static {
    /// The v2 stream for a hello (the query) and its `Last-Event-ID`: SSE bytes, frame by frame.
    fn events(
        &self,
        caller: Caller,
        query: Vec<(String, String)>,
        last_event_id: Option<String>,
    ) -> Result<mpsc::Receiver<Bytes>>;
    /// A client message (sub, unsub, window, mutate) for the open stream `client`.
    fn message(
        &self,
        caller: Caller,
        client: String,
        body: Bytes,
    ) -> BoxFuture<'static, Result<()>>;
    fn notice(&self, kind: &str, data: &Value, topic: Option<&str>);
    /// v2 streams with a non-passive subscription (a passive one never keeps a box awake)
    fn looking(&self) -> usize;
    /// the store's head seq, answered with a command's result
    fn head_seq(&self) -> i64;
}

pub fn has_hello(query: &[(String, String)]) -> bool {
    query.iter().any(|(k, _)| HELLO_KEYS.contains(&k.as_str()))
}

pub fn frame(event: &str, data: &Value) -> Bytes {
    Bytes::from(format!("event: {event}\ndata: {data}\n\n"))
}

#[derive(Debug)]
struct Legacy {
    tx: mpsc::Sender<Bytes>,
    /// another wisp relaying this one's events: it doesn't count as someone looking
    relay: bool,
}

#[derive(Default)]
pub struct Hub {
    legacy: Mutex<Vec<Legacy>>,
    mount: RwLock<Option<Arc<dyn SyncMount>>>,
}

impl std::fmt::Debug for Hub {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Hub")
            .field("legacy", &self.legacy.lock().map_or(0, |l| l.len()))
            .finish_non_exhaustive()
    }
}

impl Hub {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn mount(&self, m: Arc<dyn SyncMount>) {
        if let Ok(mut slot) = self.mount.write() {
            *slot = Some(m);
        }
    }

    pub fn mounted(&self) -> Option<Arc<dyn SyncMount>> {
        self.mount.read().ok().and_then(|m| m.clone())
    }

    /// A v1 stream: `hello` first, then every broadcast.
    pub fn attach_legacy(&self, relay: bool) -> mpsc::Receiver<Bytes> {
        let (tx, rx) = mpsc::channel(LEGACY_QUEUE);
        let _ = tx.try_send(frame("hello", &json!({})));
        if let Ok(mut l) = self.legacy.lock() {
            l.push(Legacy { tx, relay });
        }
        rx
    }

    /// `from_machine`: relayed from one of this wisp's machines; not sent on to a relaying wisp (two that
    /// list each other would loop). A client that is gone or too far behind is dropped, never waited on.
    pub fn broadcast(&self, event: &str, data: &Value, from_machine: bool) {
        let Ok(mut l) = self.legacy.lock() else {
            return;
        };
        if l.is_empty() {
            return;
        }
        let f = frame(event, data);
        l.retain(|c| {
            if from_machine && c.relay {
                !c.tx.is_closed()
            } else {
                c.tx.try_send(f.clone()).is_ok()
            }
        });
    }

    pub fn ping(&self) {
        self.broadcast("ping", &json!({}), false);
    }

    /// Clients looking: v1 streams that aren't relays, plus v2 streams with an active subscription.
    pub fn looking(&self) -> usize {
        let v1 = self.legacy.lock().map_or(0, |l| {
            l.iter().filter(|c| !c.relay && !c.tx.is_closed()).count()
        });
        v1 + self.mounted().map_or(0, |m| m.looking())
    }

    pub fn legacy_count(&self) -> usize {
        self.legacy
            .lock()
            .map_or(0, |l| l.iter().filter(|c| !c.tx.is_closed()).count())
    }

    /// Ends every v1 stream (shutdown).
    pub fn close(&self) {
        if let Ok(mut l) = self.legacy.lock() {
            l.clear();
        }
    }
}

impl Notify for Hub {
    fn notice(&self, kind: &str, data: Value, topic: Option<&str>) {
        if let Some(m) = self.mounted() {
            m.notice(kind, &data, topic);
        }
        self.broadcast(kind, &data, false);
    }
}

/// A command's answer, kept by `(caller, Idempotency-Key)` so a retry gets the same answer and the
/// command runs once, even when the retry arrives while the first is still running.
pub type Done = (u16, Value);

#[derive(Debug, Default)]
pub struct Idempotency {
    inner: Mutex<(HashMap<String, Cell>, VecDeque<String>)>,
}

type Cell = Arc<OnceCell<Done>>;

impl Idempotency {
    pub async fn once<F>(&self, key: String, run: F) -> Done
    where
        F: std::future::Future<Output = Done>,
    {
        let cell = {
            let Ok(mut g) = self.inner.lock() else {
                return run.await;
            };
            let (map, order) = &mut *g;
            if let Some(c) = map.get(&key) {
                c.clone()
            } else {
                let c = Arc::new(OnceCell::new());
                map.insert(key.clone(), c.clone());
                order.push_back(key);
                while order.len() > IDEM_KEPT {
                    if let Some(old) = order.pop_front() {
                        map.remove(&old);
                    }
                }
                c
            }
        };
        cell.get_or_init(|| run).await.clone()
    }
}

/// `POST /api/cmd`'s answer: `{ok: true, seq, result}` or `{ok: false, error: {code, message, retry}}`
/// (packages/protocol `CommandResponse`), with the error's HTTP status.
pub fn command_answer(out: Result<Value>, seq: i64) -> Done {
    match out {
        Ok(result) => (200, json!({"ok": true, "seq": seq, "result": result})),
        Err(e) => (
            e.status(),
            json!({"ok": false, "error": {"code": e.code, "message": e.message, "retry": e.retry}, "message": e.message}),
        ),
    }
}

pub fn not_mounted() -> WireError {
    WireError::unavailable("the v2 sync stream is not mounted in this build")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    #[test]
    fn legacy_gets_hello_then_broadcasts_and_relays_skip_machine_events() {
        let hub = Hub::new();
        let mut a = hub.attach_legacy(false);
        let mut r = hub.attach_legacy(true);
        assert_eq!(hub.looking(), 1);
        assert_eq!(
            a.try_recv().unwrap(),
            Bytes::from_static(b"event: hello\ndata: {}\n\n")
        );
        let _ = r.try_recv();
        hub.broadcast("summary", &json!({"id": "s1"}), true);
        assert_eq!(
            a.try_recv().unwrap(),
            Bytes::from_static(b"event: summary\ndata: {\"id\":\"s1\"}\n\n")
        );
        assert!(
            r.try_recv().is_err(),
            "a relay never gets an event relayed from a machine"
        );
        hub.broadcast("config", &json!({}), false);
        assert!(r.try_recv().is_ok());
    }

    #[test]
    fn gone_and_slow_clients_are_dropped() {
        let hub = Hub::new();
        let a = hub.attach_legacy(false);
        drop(a);
        assert_eq!(hub.looking(), 0);
        hub.ping();
        assert_eq!(hub.legacy_count(), 0);
        let _slow = hub.attach_legacy(false);
        for _ in 0..=LEGACY_QUEUE {
            hub.ping();
        }
        assert_eq!(
            hub.legacy_count(),
            0,
            "a client 1024 frames behind is dropped, not waited on"
        );
    }

    #[test]
    fn hello_keys() {
        assert!(has_hello(&[("topics".into(), "list".into())]));
        assert!(has_hello(&[("cursor".into(), "12".into())]));
        assert!(!has_hello(&[("x".into(), "1".into())]));
        assert!(!has_hello(&[]));
    }

    #[tokio::test]
    async fn a_retry_gets_the_first_answer_and_runs_nothing() {
        let idem = Idempotency::default();
        let runs = AtomicU64::new(0);
        let run = || async {
            runs.fetch_add(1, Ordering::SeqCst);
            (200, json!({"n": 1}))
        };
        let (a, b) = tokio::join!(idem.once("k".into(), run()), idem.once("k".into(), run()));
        assert_eq!(a, b);
        assert_eq!(idem.once("k".into(), run()).await.1["n"], 1);
        assert_eq!(runs.load(Ordering::SeqCst), 1);
        idem.once("k2".into(), run()).await;
        assert_eq!(runs.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn command_answers() {
        let (s, v) = command_answer(Ok(json!({"id": "x"})), 7);
        assert_eq!(
            (s, v["ok"].clone(), v["seq"].clone()),
            (200, json!(true), json!(7))
        );
        let (s, v) = command_answer(Err(WireError::forbidden("no")), 7);
        assert_eq!((s, v["error"]["code"].clone()), (403, json!("forbidden")));
    }
}
