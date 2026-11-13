//! The sync endpoints (ADR-0005, plan §4.3) and the v1 event stream.
//!   GET  /api/events?topics&cursor…  the v2 stream (any hello key in the query): wisp-sync's, mounted
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
pub const HELLO_KEYS: [&str; 9] = ["proto_min", "proto_max", "client_id", "build", "epoch", "cursor", "topics", "fresh", "passive"];
/// Command results remembered for a retry over a flaky tunnel.
const IDEM_KEPT: usize = 10_000;

/// What wisp-sync provides to the edge.
pub trait SyncMount: Send + Sync + 'static {
    /// The v2 stream for a hello (the query) and its `Last-Event-ID`: SSE bytes, frame by frame.
    fn events(&self, caller: Caller, query: Vec<(String, String)>, last_event_id: Option<String>) -> Result<mpsc::Receiver<Bytes>>;
    /// A client message (sub, unsub, window, mutate) for the open stream `client`.
    fn message(&self, caller: Caller, client: String, body: Bytes) -> BoxFuture<'static, Result<()>>;
    fn notice(&self, kind: &str, data: &Value, topic: Option<&str>);
    /// v2 streams with a non-passive subscription (a passive one never keeps a box awake)
    fn looking(&self) -> usize;
    /// the store's head seq, answered with a command's result
    fn head_seq(&self) -> i64;
}

pub fn has_hello(query: &[(String, String)]) -> bool {
    query.iter().any(|(k, _)| HELLO_KEYS.contains(&k.as_str()))
}

#[derive(Default)]
pub struct Hub {
    mount: RwLock<Option<Arc<dyn SyncMount>>>,
}

impl std::fmt::Debug for Hub {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Hub").field("mounted", &self.mounted().is_some()).finish_non_exhaustive()
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

    /// Clients looking: streams with an active subscription.
    pub fn looking(&self) -> usize {
        self.mounted().map_or(0, |m| m.looking())
    }
}

impl Notify for Hub {
    fn notice(&self, kind: &str, data: Value, topic: Option<&str>) {
        if let Some(m) = self.mounted() {
            m.notice(kind, &data, topic);
        }
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
        Err(e) => {
            (e.status(), json!({"ok": false, "error": {"code": e.code, "message": e.message, "retry": e.retry}, "message": e.message}))
        }
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
        assert_eq!((s, v["ok"].clone(), v["seq"].clone()), (200, json!(true), json!(7)));
        let (s, v) = command_answer(Err(WireError::forbidden("no")), 7);
        assert_eq!((s, v["error"]["code"].clone()), (403, json!("forbidden")));
    }
}
