//! Events (plan §6.11.2 rule 6): published after the emitting command commits, delivered asynchronously
//! and in order, one queue per subscribing plugin so a slow one only delays itself. At least once: a
//! handler that fails (or panics) gets the same envelope again, up to 3 tries (dedupe by `seq`). Past
//! 10k queued a plugin is `lagging`: its queue stops growing and it catches up from the change feed.
use std::any::Any;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock, Weak};

use futures::FutureExt;
use serde::ser::SerializeStruct;
use serde_json::Value;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::host::Ctx;
use crate::perm::glob;
use crate::state::{KernelState, Work};
use crate::{BoxFuture, Event, Result};

pub const QUEUE_CAP: usize = 10_000;
const ATTEMPTS: u32 = 3;

/// An event's payload: the typed value when it was emitted in-process (no JSON for in-process
/// subscribers of the same type), JSON on demand.
pub(crate) trait AnyEvent: Any + Send + Sync {
    fn json(&self) -> Value;
    fn any(&self) -> &dyn Any;
}

impl<E: Event> AnyEvent for E {
    fn json(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
    fn any(&self) -> &dyn Any {
        self
    }
}

#[derive(Clone)]
pub(crate) enum Payload {
    Typed(Arc<dyn AnyEvent>),
    Json(Arc<Value>),
}

impl std::fmt::Debug for Payload {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self { Self::Typed(_) => "Typed", Self::Json(_) => "Json" })
    }
}

/// An event waiting for its command to commit.
#[derive(Debug, Clone)]
pub(crate) struct Pending {
    pub(crate) ty: String,
    pub(crate) plugin: Arc<str>,
    pub(crate) data: Payload,
}

/// A published event as subscribers see it.
#[derive(Debug, Clone)]
pub struct EventEnvelope {
    /// the kernel's publish order, for deduplication
    pub seq: u64,
    pub ty: String,
    /// the plugin that emitted it
    pub plugin: String,
    pub at: i64,
    /// the root call it came from
    pub root: String,
    /// the store's change cursor when the store published it on commit
    pub cursor: Option<u64>,
    data: Payload,
}

impl EventEnvelope {
    pub fn data(&self) -> Value {
        match &self.data {
            Payload::Typed(t) => t.json(),
            Payload::Json(v) => (**v).clone(),
        }
    }
    /// The payload as `E`: a clone when it was emitted as `E` in this process, else parsed.
    pub fn get<E: Event>(&self) -> Option<E> {
        match &self.data {
            Payload::Typed(t) => t.any().downcast_ref::<E>().cloned().or_else(|| serde_json::from_value(t.json()).ok()),
            Payload::Json(v) => serde_json::from_value((**v).clone()).ok(),
        }
    }
}

impl serde::Serialize for EventEnvelope {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        let mut st = s.serialize_struct("EventEnvelope", 7)?;
        st.serialize_field("seq", &self.seq)?;
        st.serialize_field("type", &self.ty)?;
        st.serialize_field("plugin", &self.plugin)?;
        st.serialize_field("at", &self.at)?;
        st.serialize_field("root", &self.root)?;
        st.serialize_field("cursor", &self.cursor)?;
        st.serialize_field("data", &self.data())?;
        st.end()
    }
}

pub(crate) type SubFn = Arc<dyn Fn(Ctx, Arc<EventEnvelope>) -> BoxFuture<'static, Result<()>> + Send + Sync>;

#[derive(Clone)]
pub(crate) struct Sub {
    pub(crate) pattern: String,
    pub(crate) f: SubFn,
    pub(crate) ctx: Ctx,
}

struct Queue {
    owner: Arc<str>,
    subs: RwLock<Vec<Sub>>,
    items: Mutex<VecDeque<Arc<EventEnvelope>>>,
    wake: Notify,
    lagging: Mutex<Option<u64>>,
    stop: CancellationToken,
}

/// Which queues want a type: exact types in a map, patterns (`x.*`, `*`) in a list. Rebuilt on
/// (un)subscribe, read as a snapshot on publish.
#[derive(Default)]
struct Index {
    exact: HashMap<String, Vec<Arc<Queue>>>,
    patterns: Vec<(String, Arc<Queue>)>,
}

pub(crate) struct Bus {
    seq: AtomicU64,
    queues: Mutex<HashMap<Arc<str>, Arc<Queue>>>,
    index: RwLock<Arc<Index>>,
    work: Arc<Work>,
}

impl Bus {
    pub(crate) fn new(work: Arc<Work>) -> Self {
        Self { seq: AtomicU64::new(0), queues: Mutex::default(), index: RwLock::default(), work }
    }

    fn reindex(&self, queues: &HashMap<Arc<str>, Arc<Queue>>) {
        let mut ix = Index::default();
        for q in queues.values() {
            let subs = q.subs.read().map(|s| s.iter().map(|x| x.pattern.clone()).collect::<Vec<_>>()).unwrap_or_default();
            let mut seen: Vec<String> = Vec::new();
            for p in subs.into_iter().filter(|p| !seen.contains(p)) {
                seen.push(p.clone());
                if p.contains('*') { ix.patterns.push((p, q.clone())) } else { ix.exact.entry(p).or_default().push(q.clone()) }
            }
        }
        if let Ok(mut w) = self.index.write() {
            *w = Arc::new(ix);
        }
    }

    /// Adds a subscription for `owner`; its queue and worker start on the first one.
    pub(crate) fn subscribe(&self, k: &Arc<KernelState>, owner: &Arc<str>, sub: Sub, scope: &CancellationToken) {
        let Ok(mut qs) = self.queues.lock() else { return };
        let q = qs.entry(owner.clone()).or_insert_with(|| {
            let q = Arc::new(Queue { owner: owner.clone(), subs: RwLock::default(), items: Mutex::default(), wake: Notify::new(), lagging: Mutex::default(), stop: scope.child_token() });
            tokio::spawn(worker(q.clone(), Arc::downgrade(k), self.work.clone()));
            q
        });
        if let Ok(mut s) = q.subs.write() {
            s.push(sub);
        }
        self.reindex(&qs);
    }

    /// Drops `owner`'s queue: its subscriptions and whatever was still queued for it.
    pub(crate) fn drop_owner(&self, owner: &str) -> usize {
        let Ok(mut qs) = self.queues.lock() else { return 0 };
        let Some(q) = qs.remove(owner) else { return 0 };
        q.stop.cancel();
        let n = q.subs.read().map(|s| s.len()).unwrap_or(0);
        let queued = q.items.lock().map(|mut i| std::mem::take(&mut *i).len()).unwrap_or(0);
        self.work.done(queued);
        self.reindex(&qs);
        n
    }

    pub(crate) fn subscriptions(&self, owner: &str) -> usize {
        self.queues.lock().ok().and_then(|qs| qs.get(owner).map(|q| q.subs.read().map(|s| s.len()).unwrap_or(0))).unwrap_or(0)
    }

    pub(crate) fn lagging(&self, owner: &str) -> Option<u64> {
        let qs = self.queues.lock().ok()?;
        let q = qs.get(owner)?;
        *q.lagging.lock().ok()?
    }

    pub(crate) fn caught_up(&self, owner: &str) {
        if let Some(q) = self.queues.lock().ok().and_then(|qs| qs.get(owner).cloned())
            && let Ok(mut l) = q.lagging.lock()
        {
            *l = None;
        }
    }

    /// Publishes one committed event to every queue that wants it. Returns its envelope.
    pub(crate) fn publish(&self, k: &KernelState, root: &str, cursor: Option<u64>, p: Pending) -> Arc<EventEnvelope> {
        let seq = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
        let env = Arc::new(EventEnvelope { seq, ty: p.ty, plugin: p.plugin.to_string(), at: k.now_ms(), root: root.to_owned(), cursor, data: p.data });
        let ix = self.index.read().map(|i| i.clone()).unwrap_or_default();
        if let Some(qs) = ix.exact.get(&env.ty) {
            for q in qs {
                self.enqueue(k, q, &env);
            }
        }
        for (pat, q) in &ix.patterns {
            // a queue matched exactly already has it
            if glob(pat, &env.ty) && !ix.exact.get(&env.ty).is_some_and(|l| l.iter().any(|x| Arc::ptr_eq(x, q))) {
                self.enqueue(k, q, &env);
            }
        }
        env
    }

    fn enqueue(&self, k: &KernelState, q: &Arc<Queue>, env: &Arc<EventEnvelope>) {
        let Ok(mut items) = q.items.lock() else { return };
        if items.len() >= QUEUE_CAP {
            drop(items);
            if let Ok(mut l) = q.lagging.lock()
                && l.is_none()
            {
                *l = Some(env.seq);
                tracing::warn!(plugin = %q.owner, seq = env.seq, "event queue full: lagging, catches up from the change feed");
                k.diag.record(k.now_ms(), &q.owner, "event", "lagging", format!("{} queued events: missed from seq {}", QUEUE_CAP, env.seq), Vec::new());
            }
            return;
        }
        items.push_back(env.clone());
        drop(items);
        self.work.add(1);
        q.wake.notify_one();
    }
}

async fn worker(q: Arc<Queue>, k: Weak<KernelState>, work: Arc<Work>) {
    loop {
        let next = q.items.lock().ok().and_then(|mut i| i.front().cloned());
        let Some(env) = next else {
            tokio::select! {
                () = q.stop.cancelled() => return,
                () = q.wake.notified() => continue,
            }
        };
        let subs: Vec<Sub> = q.subs.read().map(|s| s.iter().filter(|x| glob(&x.pattern, &env.ty)).cloned().collect()).unwrap_or_default();
        for s in subs {
            deliver(&q, &k, &s, &env).await;
        }
        let popped = q.items.lock().ok().and_then(|mut i| i.pop_front()).is_some();
        if popped {
            work.done(1);
        }
    }
}

async fn deliver(q: &Queue, k: &Weak<KernelState>, s: &Sub, env: &Arc<EventEnvelope>) {
    for attempt in 1..=ATTEMPTS {
        if q.stop.is_cancelled() {
            return;
        }
        let fut = std::panic::AssertUnwindSafe((s.f)(s.ctx.clone(), env.clone())).catch_unwind();
        let why = tokio::select! {
            () = q.stop.cancelled() => return,
            r = fut => match r {
                Ok(Ok(())) => return,
                Ok(Err(e)) => e.message,
                Err(_) => "the subscriber panicked".to_owned(),
            },
        };
        if attempt == ATTEMPTS
            && let Some(k) = k.upgrade()
        {
            tracing::warn!(plugin = %q.owner, ty = %env.ty, seq = env.seq, "subscriber failed {ATTEMPTS} times: {why}");
            k.diag.record(k.now_ms(), &q.owner, "event", "internal", format!("{} (seq {}): {why}", env.ty, env.seq), Vec::new());
        }
    }
}
