//! Durable events (ADR-0044): one log, two speeds. An `Event` with `DURABLE = true` is appended to the
//! store's `event` table and delivered to durable subscriptions from a cursor, so a restart, a lag or a
//! plugin switched off loses nothing. The in-process path is unchanged and comes first.
//!
//! - **Append:** in the emitting command's own transaction when it writes (`take` / `InTx`, called by the
//!   store around each `write` made while a command runs), else in one transaction when it returns Ok. A
//!   rolled-back write takes its events with it. A repeated `(type, key)` within 24 h is recorded once (the
//!   log answers `None` for it), and isn't published either.
//! - **Deliver:** a durable subscription (`Setup::on_durable`) has a stable name and a cursor in
//!   `event_cursor`. Its worker takes `cursor + 1` from the ring of recent events, or reads the table when
//!   it's behind (start, lag, after being off). Seqs are contiguous (one writer), so it never skips one.
//! - **Effectively once:** the handler runs inside a scope that rides its cursor on the store writes it
//!   makes (`InTx::cursor`): a crash before the commit replays it, after it doesn't. A handler that writes
//!   nothing has its cursor set when it returns.
//! - **Retries:** 3 tries; then the event is parked for that subscription (with why) and the cursor moves on.
//!   `retry` delivers a parked one again.
//! - **Gaps:** a cursor that fell off the retention window gets `Durable::Gap` once (re-read current state).
//! - **Causation:** a handler's call carries the event's seq as its `cause`; events it emits record it, and
//!   their chain depth (`Call::cause_depth`) lets triggers cut loops.
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError, Weak};

use futures::FutureExt as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::call::{CallInner, RootTx};
use crate::events::{EventEnvelope, Logged, Payload, Pending};
use crate::host::Ctx;
use crate::perm::glob;
use crate::state::KernelState;
use crate::{BoxFuture, Call, Caller, Event, Result, WireError};

/// How many recent durable events the kernel keeps in memory for live delivery.
pub const RING: usize = 8192;
const ATTEMPTS: u32 = 3;
/// A subscription's cursor is saved at least every this many deliveries (and whenever it catches up).
const SAVE_EVERY: u32 = 256;
/// The type a subscription's gap is delivered as.
pub const GAP: &str = "event.gap";

/// A durable event on its way into the log.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NewEvent {
    pub ty: String,
    pub plugin: String,
    pub subject: Option<String>,
    pub key: Option<String>,
    pub cause: Option<u64>,
    pub root: String,
    pub at: i64,
    pub data: Value,
}

/// A durable event as the log keeps it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StoredEvent {
    pub seq: u64,
    #[serde(flatten)]
    pub event: NewEvent,
}

/// An event a subscription gave up on (3 failed tries), kept to retry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Parked {
    pub plugin: String,
    pub name: String,
    pub seq: u64,
    pub why: String,
    pub at: i64,
}

/// The durable log (the store implements it; `App::service` provides it). Without one, durable events
/// behave as ephemeral ones: delivered in process, not kept.
pub trait EventLog: Send + Sync + 'static {
    /// Appends `rows` in one transaction: each one's seq, or `None` for a `(type, key)` seen within 24 h.
    fn append(&self, rows: Vec<NewEvent>) -> BoxFuture<'static, Result<Vec<Option<u64>>>>;
    /// Up to `limit` events after `after`, in order.
    fn read(&self, after: u64, limit: usize) -> BoxFuture<'static, Result<Vec<StoredEvent>>>;
    fn get(&self, seq: u64) -> BoxFuture<'static, Result<Option<StoredEvent>>>;
    /// (first, last) seq kept; (0, 0) when there's none.
    fn bounds(&self) -> BoxFuture<'static, Result<(u64, u64)>>;
    fn cursor(&self, plugin: &str, name: &str) -> BoxFuture<'static, Result<Option<u64>>>;
    fn set_cursor(&self, plugin: &str, name: &str, seq: u64) -> BoxFuture<'static, Result<()>>;
    fn park(&self, p: Parked) -> BoxFuture<'static, Result<()>>;
    fn parked(&self) -> BoxFuture<'static, Result<Vec<Parked>>>;
    fn unpark(&self, plugin: &str, name: &str, seq: u64) -> BoxFuture<'static, Result<bool>>;
}

/// The log as a kernel service.
#[derive(Clone)]
pub struct EventLogService(pub Arc<dyn EventLog>);

impl std::fmt::Debug for EventLogService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("EventLogService")
    }
}


/// A durable subscription's delivery.
#[derive(Debug, Clone)]
pub enum Durable<E> {
    Event {
        event: E,
        /// its seq in the log (dedupe with it)
        seq: u64,
        key: Option<String>,
        envelope: Arc<EventEnvelope>,
    },
    /// The cursor fell off the retention window: events `from..=to` are gone; re-read current state.
    Gap { from: u64, to: u64 },
}

// --- the scope a command or handler runs in -------------------------------------------------------------

/// Where a handler's cursor goes once a write commits.
#[derive(Debug)]
pub(crate) struct CursorMark {
    plugin: String,
    name: String,
    seq: u64,
    written: AtomicBool,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct Scope {
    pub(crate) tx: Option<Arc<RootTx>>,
    pub(crate) cursor: Option<Arc<CursorMark>>,
}

tokio::task_local! {
    static SCOPE: Scope;
}

pub(crate) fn current() -> Scope {
    SCOPE.try_with(Clone::clone).unwrap_or_default()
}

/// Runs `fut` with this scope (the command's root, the handler's cursor).
pub(crate) async fn scoped<T>(s: Scope, fut: impl Future<Output = T>) -> T {
    SCOPE.scope(s, fut).await
}

/// What one store write carries along: the command's durable events emitted so far and not yet in the
/// log, and the cursor of the handler it runs in. Taken just before the write, settled after it.
#[derive(Debug)]
pub struct InTx {
    tx: Option<Arc<RootTx>>,
    idx: Vec<usize>,
    rows: Vec<NewEvent>,
    cursor: Option<Arc<CursorMark>>,
    kernel: Weak<KernelState>,
}

/// For the store, around each write: None when nothing rides on it (no durable event, no handler cursor).
pub fn take() -> Option<InTx> {
    let s = current();
    let (idx, rows, kernel) = match &s.tx {
        Some(tx) => {
            let mut ev = tx.events.lock().unwrap_or_else(PoisonError::into_inner);
            let mut idx = Vec::new();
            let mut rows = Vec::new();
            for (i, p) in ev.iter_mut().enumerate() {
                if p.durable && p.written == Logged::Not && !p.taken {
                    p.taken = true;
                    idx.push(i);
                    rows.push(p.row());
                }
            }
            (idx, rows, tx.kernel.clone())
        }
        None => (Vec::new(), Vec::new(), Weak::new()),
    };
    let cursor = s.cursor.filter(|c| !c.written.load(Ordering::SeqCst));
    if rows.is_empty() && cursor.is_none() {
        return None;
    }
    Some(InTx { tx: s.tx, idx, rows, cursor, kernel })
}

impl InTx {
    pub fn rows(&self) -> &[NewEvent] {
        &self.rows
    }
    /// (plugin, subscription, seq) to set in `event_cursor` in the same transaction.
    pub fn cursor(&self) -> Option<(&str, &str, u64)> {
        self.cursor.as_ref().map(|c| (c.plugin.as_str(), c.name.as_str(), c.seq))
    }
    /// The write committed: each row's seq (`None`: a repeat within 24 h).
    pub fn committed(self, seqs: &[Option<u64>]) {
        if let Some(c) = &self.cursor {
            c.written.store(true, Ordering::SeqCst);
        }
        let Some(tx) = &self.tx else { return };
        let mut fresh = Vec::new();
        {
            let mut ev = tx.events.lock().unwrap_or_else(PoisonError::into_inner);
            for (n, i) in self.idx.iter().enumerate() {
                if let Some(p) = ev.get_mut(*i) {
                    p.written = seqs.get(n).copied().flatten().map_or(Logged::Repeat, Logged::At);
                    p.taken = false;
                    if let Logged::At(seq) = p.written {
                        fresh.push((seq, p.clone()));
                    }
                }
            }
        }
        // durable subscribers see it now (it's in the log); in-process ones when the command returns
        if let Some(k) = self.kernel.upgrade() {
            for (seq, p) in fresh {
                k.bus.remember(&k, seq, &p);
            }
        }
    }
    /// The write rolled back: its events wait for the next write (or the command's end), its cursor too.
    pub fn rolled_back(self) {
        let Some(tx) = &self.tx else { return };
        let mut ev = tx.events.lock().unwrap_or_else(PoisonError::into_inner);
        for i in &self.idx {
            if let Some(p) = ev.get_mut(*i) {
                p.taken = false;
            }
        }
    }
}

impl Pending {
    pub(crate) fn row(&self) -> NewEvent {
        NewEvent {
            ty: self.ty.clone(),
            plugin: self.plugin.to_string(),
            subject: self.subject.clone(),
            key: self.key.clone(),
            cause: self.cause,
            root: self.root.clone(),
            at: self.at,
            data: match &self.data {
                Payload::Typed(t) => t.json(),
                Payload::Json(v) => (**v).clone(),
            },
        }
    }
}

/// The durable events of a root command still not in the log go in now, in one transaction (the command
/// returned Ok and made no write after emitting them).
pub(crate) async fn append_rest(k: &Arc<KernelState>, tx: &Arc<RootTx>) {
    let Some(log) = k.event_log() else { return };
    let (idx, rows): (Vec<usize>, Vec<NewEvent>) = {
        let ev = tx.events.lock().unwrap_or_else(PoisonError::into_inner);
        ev.iter().enumerate().filter(|(_, p)| p.durable && p.written == Logged::Not).map(|(i, p)| (i, p.row())).unzip()
    };
    if rows.is_empty() {
        return;
    }
    match log.0.append(rows).await {
        Ok(seqs) => {
            let mut fresh = Vec::new();
            {
                let mut ev = tx.events.lock().unwrap_or_else(PoisonError::into_inner);
                for (n, i) in idx.iter().enumerate() {
                    if let Some(p) = ev.get_mut(*i) {
                        p.written = seqs.get(n).copied().flatten().map_or(Logged::Repeat, Logged::At);
                        if let Logged::At(seq) = p.written {
                            fresh.push((seq, p.clone()));
                        }
                    }
                }
            }
            for (seq, p) in fresh {
                k.bus.remember(k, seq, &p);
            }
        }
        Err(e) => {
            tracing::warn!("durable events not kept: {}", e.message);
            k.diag.record(k.now_ms(), "wisp.kernel", "event", "internal", format!("durable events not kept: {}", e.message), Vec::new());
        }
    }
}

// --- the ring and the subscriptions ---------------------------------------------------------------------

pub(crate) type DurableFn = Arc<dyn Fn(Ctx, Call, Arc<EventEnvelope>) -> BoxFuture<'static, Result<()>> + Send + Sync>;

pub(crate) struct DSub {
    pub(crate) name: String,
    pub(crate) pattern: String,
    pub(crate) f: DurableFn,
    pub(crate) ctx: Ctx,
}

pub(crate) struct Ring {
    items: Mutex<BTreeMap<u64, Arc<EventEnvelope>>>,
    head: watch::Sender<u64>,
    workers: Mutex<HashMap<String, Vec<CancellationToken>>>,
    /// each worker's "counted as busy" flag: the head moving makes idle ones busy (in `Work`) under this
    /// lock, so `Kernel::idle` never resolves between an event and its delivery
    busy: Mutex<Vec<Arc<AtomicBool>>>,
    work: Arc<crate::state::Work>,
}

impl Ring {
    pub(crate) fn new(work: Arc<crate::state::Work>) -> Self {
        Self { items: Mutex::default(), head: watch::channel(0).0, workers: Mutex::default(), busy: Mutex::default(), work }
    }
    fn wake_all(&self, flags: &[Arc<AtomicBool>]) {
        for f in flags {
            if !f.swap(true, Ordering::SeqCst) {
                self.work.add(1);
            }
        }
    }
    /// The head goes up to `to` (if it's higher), and idle workers count as busy.
    fn raise(&self, to: u64) {
        let flags = self.busy.lock().unwrap_or_else(PoisonError::into_inner);
        let up = self.head.send_if_modified(|h| {
            let up = to > *h;
            if up {
                *h = to;
            }
            up
        });
        if up {
            self.wake_all(&flags);
        }
    }
    /// A worker caught up at `cursor` goes idle, unless the head moved meanwhile. → whether it did.
    fn rest(&self, flag: &AtomicBool, cursor: u64) -> bool {
        let _g = self.busy.lock().unwrap_or_else(PoisonError::into_inner);
        if self.head() > cursor {
            return false;
        }
        if flag.swap(false, Ordering::SeqCst) {
            self.work.done(1);
        }
        true
    }
}

impl Ring {
    pub(crate) fn insert(&self, env: Arc<EventEnvelope>) {
        let Some(seq) = env.durable_seq else { return };
        {
            let mut m = self.items.lock().unwrap_or_else(PoisonError::into_inner);
            m.insert(seq, env);
            while m.len() > RING {
                m.pop_first();
            }
        }
        self.raise(seq);
    }
    fn first_after(&self, seq: u64) -> Option<u64> {
        self.items.lock().unwrap_or_else(PoisonError::into_inner).range(seq + 1..).next().map(|(s, _)| *s)
    }
    fn get(&self, seq: u64) -> Option<Arc<EventEnvelope>> {
        self.items.lock().unwrap_or_else(PoisonError::into_inner).get(&seq).cloned()
    }
    pub(crate) fn head_watch(&self) -> watch::Receiver<u64> {
        self.head.subscribe()
    }
    pub(crate) fn head(&self) -> u64 {
        *self.head.borrow()
    }
    pub(crate) fn raise_head(&self, to: u64) {
        self.raise(to);
    }
    pub(crate) fn stop_owner(&self, owner: &str) {
        for t in self.workers.lock().unwrap_or_else(PoisonError::into_inner).remove(owner).unwrap_or_default() {
            t.cancel();
        }
    }
}

fn envelope_of(s: &StoredEvent, depth: u32) -> Arc<EventEnvelope> {
    Arc::new(EventEnvelope {
        seq: 0,
        ty: s.event.ty.clone(),
        plugin: s.event.plugin.clone(),
        at: s.event.at,
        root: s.event.root.clone(),
        cursor: None,
        durable_seq: Some(s.seq),
        subject: s.event.subject.clone(),
        key: s.event.key.clone(),
        cause: s.event.cause,
        depth,
        data: Payload::Json(Arc::new(s.event.data.clone())),
    })
}

/// How deep `seq`'s chain of causes goes (0: nothing caused it), at most 8.
pub(crate) async fn depth_of(log: &EventLogService, mut cause: Option<u64>) -> u32 {
    let mut d = 0;
    while let Some(c) = cause {
        if d >= 8 {
            break;
        }
        d += 1;
        cause = log.0.get(c).await.ok().flatten().and_then(|e| e.event.cause);
    }
    d
}

/// Starts a durable subscription's worker.
pub(crate) fn start(k: &Arc<KernelState>, ctx: &Ctx, sub: DSub) {
    let stop = ctx.scope().child_token();
    k.bus
        .ring
        .workers
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .entry(ctx.plugin().to_owned())
        .or_default()
        .push(stop.clone());
    let flag = Arc::new(AtomicBool::new(true));
    k.bus.ring.busy.lock().unwrap_or_else(PoisonError::into_inner).push(flag.clone());
    k.work.add(1);
    let w = Arc::downgrade(k);
    let work = k.work.clone();
    // a new subscription starts here: what's emitted after it registers is its
    let from = k.bus.ring.head();
    tokio::spawn(async move {
        worker(w.clone(), sub, stop, flag.clone(), from).await;
        // gone: out of the busy list (under its lock), and settled if it was counted
        if let Some(k) = w.upgrade() {
            k.bus.ring.busy.lock().unwrap_or_else(PoisonError::into_inner).retain(|f| !Arc::ptr_eq(f, &flag));
        }
        if flag.swap(false, Ordering::SeqCst) {
            work.done(1);
        }
    });
}

async fn worker(k: Weak<KernelState>, sub: DSub, stop: CancellationToken, flag: Arc<AtomicBool>, from: u64) {
    let Some(kk) = k.upgrade() else { return };
    let owner = sub.ctx.plugin().to_owned();
    let log = kk.event_log();
    let mut head_rx = kk.bus.ring.head.subscribe();
    let stored = match &log {
        Some(l) => l.0.cursor(&owner, &sub.name).await.ok().flatten(),
        None => None,
    };
    // a new subscription starts from now; a known one from where it stopped
    let mut cursor = stored.unwrap_or(from);
    let mut persisted = stored;
    drop(kk);
    let mut batch: VecDeque<Arc<EventEnvelope>> = VecDeque::new();
    let mut unsaved = 0u32;
    // the work counter counts this worker as busy only while it's behind
    loop {
        if stop.is_cancelled() {
            return;
        }
        let Some(kk) = k.upgrade() else { return };
        let head = kk.bus.ring.head();
        if cursor >= head {
            if let (Some(l), true) = (&log, persisted != Some(cursor)) {
                let _ = l.0.set_cursor(&owner, &sub.name, cursor).await;
                persisted = Some(cursor);
                unsaved = 0;
            }
            if !kk.bus.ring.rest(&flag, cursor) {
                continue;
            }
            drop(kk);
            let woke = tokio::select! {
                () = stop.cancelled() => false,
                r = head_rx.changed() => r.is_ok(),
            };
            // busy again (the head's raise may have counted it already)
            if !flag.swap(true, Ordering::SeqCst)
                && let Some(k) = k.upgrade()
            {
                k.work.add(1);
            }
            if !woke {
                return;
            }
            continue;
        }
        let next = cursor + 1;
        let env = if let Some(e) = batch.front().filter(|e| e.durable_seq == Some(next)).cloned() {
            batch.pop_front();
            Some(e)
        } else if let Some(e) = kk.bus.ring.get(next) {
            Some(e)
        } else if let Some(l) = &log {
            batch.clear();
            let rows = l.0.read(cursor, 256).await.unwrap_or_default();
            match rows.first() {
                Some(first) if first.seq > next => {
                    // fell off the end of the retention window
                    let to = first.seq - 1;
                    kk.diag.record(kk.now_ms(), &owner, "event", "gap", format!("{}: events {next}..={to} are gone (retention)", sub.name), Vec::new());
                    let gap = gap_envelope(next, to);
                    deliver(&kk, &sub, log.as_ref(), &gap, &stop).await;
                    cursor = to;
                    continue;
                }
                Some(_) => {
                    for r in &rows {
                        let d = if r.event.cause.is_some() { depth_of(l, r.event.cause).await } else { 0 };
                        batch.push_back(envelope_of(r, d));
                    }
                    continue;
                }
                // nothing kept past the cursor (retention took it all)
                None => {
                    cursor = head;
                    continue;
                }
            }
        } else {
            // no log: what the ring no longer has is gone
            cursor = kk.bus.ring.first_after(cursor).map_or(head, |s| s - 1);
            continue;
        };
        let Some(env) = env else { continue };
        if matches(&sub.pattern, &env.ty) {
            deliver(&kk, &sub, log.as_ref(), &env, &stop).await;
            unsaved += 1;
        }
        cursor = next;
        if unsaved >= SAVE_EVERY
            && let Some(l) = &log
        {
            let _ = l.0.set_cursor(&owner, &sub.name, cursor).await;
            persisted = Some(cursor);
            unsaved = 0;
        }
    }
}

/// `a|b*`: any of the alternatives.
pub(crate) fn matches(pattern: &str, ty: &str) -> bool {
    pattern.split('|').any(|p| glob(p, ty))
}

fn gap_envelope(from: u64, to: u64) -> Arc<EventEnvelope> {
    Arc::new(EventEnvelope {
        seq: 0,
        ty: GAP.into(),
        plugin: "wisp.kernel".into(),
        at: 0,
        root: String::new(),
        cursor: None,
        durable_seq: Some(to),
        subject: None,
        key: None,
        cause: None,
        depth: 0,
        data: Payload::Json(Arc::new(serde_json::json!({ "from": from, "to": to }))),
    })
}

/// One event to one subscription: 3 tries in its cursor scope, then parked with why.
async fn deliver(k: &Arc<KernelState>, sub: &DSub, log: Option<&EventLogService>, env: &Arc<EventEnvelope>, stop: &CancellationToken) {
    let owner = sub.ctx.plugin().to_owned();
    let seq = env.durable_seq.unwrap_or(0);
    let mut why = String::new();
    for _ in 0..ATTEMPTS {
        if stop.is_cancelled() {
            return;
        }
        let mark = Arc::new(CursorMark { plugin: owner.clone(), name: sub.name.clone(), seq, written: AtomicBool::new(false) });
        let mut inner = CallInner::detached(k, Caller::plugin(&owner), Some(Arc::from(owner.as_str())), stop.child_token());
        inner.cause = Some(seq);
        inner.cause_depth = env.depth + 1;
        let call = inner.into_call();
        let fut = std::panic::AssertUnwindSafe(scoped(Scope { tx: None, cursor: Some(mark.clone()) }, (sub.f)(sub.ctx.clone(), call, env.clone()))).catch_unwind();
        let r = tokio::select! {
            () = stop.cancelled() => return,
            r = fut => r,
        };
        match r {
            // a handler that wrote nothing has its cursor saved by the worker (every 256, and when caught up):
            // it changed nothing a replay could repeat, and handlers stay idempotent (the envelope has seq)
            Ok(Ok(())) => return,
            Ok(Err(e)) => why = e.message,
            Err(_) => why = "the subscriber panicked".into(),
        }
        // its write committed with the cursor: the effect happened, and running it again would repeat it
        if mark.written.load(Ordering::SeqCst) {
            k.diag.record(k.now_ms(), &owner, "event", "internal", format!("{} {} (seq {seq}) failed after its write: {why}", sub.name, env.ty), Vec::new());
            return;
        }
    }
    tracing::warn!(plugin = %owner, sub = %sub.name, seq, "durable subscriber failed {ATTEMPTS} times, parked: {why}");
    k.diag.record(k.now_ms(), &owner, "event", "parked", format!("{} {} (seq {seq}): {why}", sub.name, env.ty), Vec::new());
    if let Some(l) = log {
        let _ = l.0.park(Parked { plugin: owner.clone(), name: sub.name.clone(), seq, why, at: k.now_ms() }).await;
        let _ = l.0.set_cursor(&owner, &sub.name, seq).await;
    }
}

/// `wisp events retry <seq>`: a parked event delivered again to the subscription that parked it.
pub(crate) async fn retry(k: &Arc<KernelState>, seq: u64) -> Result<usize> {
    let log = k.event_log().ok_or_else(|| WireError::unavailable("no event log"))?;
    let parked: Vec<Parked> = log.0.parked().await?.into_iter().filter(|p| p.seq == seq).collect();
    if parked.is_empty() {
        return Err(WireError::not_found(format!("event {seq} isn't parked")));
    }
    let ev = log.0.get(seq).await?.ok_or_else(|| WireError::not_found(format!("event {seq} isn't kept any more")))?;
    let env = envelope_of(&ev, depth_of(&log, ev.event.cause).await);
    let mut n = 0;
    for p in parked {
        let subs = k.bus.durables.lock().unwrap_or_else(PoisonError::into_inner).get(&(p.plugin.clone(), p.name.clone())).cloned();
        let Some(sub) = subs else { continue };
        log.0.unpark(&p.plugin, &p.name, seq).await?;
        deliver(k, &sub, Some(&log), &env, &sub.ctx.scope().child_token()).await;
        n += 1;
    }
    Ok(n)
}

impl Clone for DSub {
    fn clone(&self) -> Self {
        Self { name: self.name.clone(), pattern: self.pattern.clone(), f: self.f.clone(), ctx: self.ctx.clone() }
    }
}

/// The typed form of a durable delivery.
pub(crate) fn typed<E: Event>(env: &Arc<EventEnvelope>) -> Option<Durable<E>> {
    if env.ty == GAP {
        let d = env.data();
        return Some(Durable::Gap { from: d["from"].as_u64().unwrap_or(0), to: d["to"].as_u64().unwrap_or(0) });
    }
    env.get::<E>().map(|event| Durable::Event { event, seq: env.durable_seq.unwrap_or(0), key: env.key.clone(), envelope: env.clone() })
}
