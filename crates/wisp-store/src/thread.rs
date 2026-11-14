//! The writer thread: the only code that writes. Jobs run in arrival order, each write closure in one
//! `BEGIN IMMEDIATE … COMMIT`; listeners hear a commit on this thread before the caller gets its result,
//! so commit order is publish order and an awaited write has always been heard.

use std::cell::Cell;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::{JoinHandle, ThreadId};

use rusqlite::Connection;
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::changes::ChangeRow;
use crate::error::{Result, StoreError, invalid};
use crate::store::{CommitFn, Shared, Store, lock};
use crate::writer::{MutationResult, Writer};

type Job = Box<dyn FnOnce(&Arc<Shared>) + Send>;

thread_local! {
    static ON_WRITER: Cell<bool> = const { Cell::new(false) };
    static IN_WRITE: Cell<bool> = const { Cell::new(false) };
}

pub(crate) struct WriterThread {
    tx: Mutex<Option<mpsc::Sender<Job>>>,
    handle: Mutex<Option<JoinHandle<()>>>,
    id: ThreadId,
}

impl std::fmt::Debug for WriterThread {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WriterThread").field("id", &self.id).finish_non_exhaustive()
    }
}

/// Inside a write closure, reads go through the `Writer` (they see its uncommitted rows, and the store's
/// own read path could wait on the writer it is running on).
pub(crate) fn refuse_inside_write() -> Result<()> {
    if IN_WRITE.get() { Err(invalid("inside a write closure, read through the Writer (w.get, w.query)")) } else { Ok(()) }
}

pub(crate) fn call_listener(f: impl FnOnce()) {
    if catch_unwind(AssertUnwindSafe(f)).is_err() {
        tracing::error!("a store listener panicked; the others still ran");
    }
}

impl WriterThread {
    pub fn start(shared: Arc<Shared>) -> Result<Self> {
        let (tx, rx) = mpsc::channel::<Job>();
        let handle = std::thread::Builder::new().name("wisp-store-writer".into()).spawn(move || {
            ON_WRITER.set(true);
            while let Ok(job) = rx.recv() {
                job(&shared);
            }
        })?;
        let id = handle.thread().id();
        Ok(Self { tx: Mutex::new(Some(tx)), handle: Mutex::new(Some(handle)), id })
    }

    fn submit(&self, job: Job) -> Result<()> {
        let tx = self.tx.lock().unwrap_or_else(PoisonError::into_inner);
        tx.as_ref().ok_or(StoreError::Closed)?.send(job).map_err(|_| StoreError::Closed)
    }

    fn blocking<T: Send + 'static>(&self, work: impl FnOnce(&Arc<Shared>) -> Result<T> + Send + 'static) -> Result<T> {
        if ON_WRITER.get() {
            return Err(invalid("a blocking store call on the writer thread would wait for itself: hand the work to a task"));
        }
        let (tx, rx) = mpsc::sync_channel(1);
        self.submit(Box::new(move |s| {
            let _ = tx.send(work(s));
        }))?;
        rx.recv().map_err(|_| StoreError::Closed)?
    }

    pub(crate) async fn queued<T: Send + 'static>(&self, work: impl FnOnce(&Arc<Shared>) -> Result<T> + Send + 'static) -> Result<T> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.submit(Box::new(move |s| {
            let _ = tx.send(work(s));
        }))?;
        rx.await.map_err(|_| StoreError::Closed)?
    }

    /// The writer connection outside a transaction (migrations, meta, prune), blocking the caller.
    pub fn run_raw<T: Send + 'static>(&self, f: impl FnOnce(&Connection) -> Result<T> + Send + 'static) -> Result<T> {
        self.blocking(move |s| f(&lock(&s.writer)))
    }

    pub async fn run_raw_async<T: Send + 'static>(&self, f: impl FnOnce(&Connection) -> Result<T> + Send + 'static) -> Result<T> {
        self.queued(move |s| f(&lock(&s.writer))).await
    }

    pub fn stop(&self) {
        self.tx.lock().unwrap_or_else(PoisonError::into_inner).take();
        if std::thread::current().id() == self.id {
            return; // the last handle dropped on the writer thread itself: it ends after this job
        }
        if let Some(h) = self.handle.lock().unwrap_or_else(PoisonError::into_inner).take() {
            let _ = h.join();
        }
    }
}

impl Drop for WriterThread {
    fn drop(&mut self) {
        self.stop();
    }
}

/// One write closure in one transaction, on the writer thread.
pub(crate) fn transact<T>(s: &Arc<Shared>, f: impl FnOnce(&mut Writer<'_>) -> Result<T>) -> Result<T> {
    let _span = tracing::debug_span!("store.write").entered();
    let db = lock(&s.writer);
    db.prepare_cached("BEGIN IMMEDIATE")?.execute([])?; // cached: parsed once, not per transaction
    IN_WRITE.set(true);
    let mut w = Writer { db: &db, shared: s, pending: Vec::new(), now: s.clock.now_ms(), doomed: None };
    let out = catch_unwind(AssertUnwindSafe(|| f(&mut w)));
    IN_WRITE.set(false);
    let (pending, doomed) = (std::mem::take(&mut w.pending), w.doomed.take());
    let out = match out {
        Ok(Ok(v)) => match doomed {
            None => db.prepare_cached("COMMIT").and_then(|mut st| st.execute([])).map(|_| v).map_err(StoreError::from),
            Some(first) => {
                Err(StoreError::Internal(format!("a write op failed ({first}) and the closure went on; the whole transaction rolled back")))
            }
        },
        Ok(Err(e)) => Err(e),
        Err(_) => Err(StoreError::Internal("a write closure panicked; its transaction rolled back".into())),
    };
    if out.is_err() {
        if !db.is_autocommit() {
            db.execute_batch("ROLLBACK")?;
        }
        return out;
    }
    drop(db);
    if !pending.is_empty() {
        publish(s, &Arc::from(pending));
    }
    out
}

fn publish(s: &Shared, changes: &Arc<[ChangeRow]>) {
    let listeners: Vec<CommitFn> = s.listeners.read().unwrap_or_else(PoisonError::into_inner).iter().map(|(_, f)| f.clone()).collect();
    for f in listeners {
        call_listener(|| f(changes));
    }
}

impl Store {
    /// Runs `f` on the writer thread in one transaction and records a change row per op. An error, a
    /// failed op or a panic rolls everything back and publishes nothing.
    pub async fn write<T, F>(&self, f: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Writer<'_>) -> Result<T> + Send + 'static,
    {
        // a command's durable events (and a durable handler's cursor) ride on its writes (ADR-0044)
        if let Some(intx) = wisp_kernel::durable::take() {
            return self.write_durable(intx, f).await;
        }
        self.thread.queued(move |s| transact(s, f)).await
    }

    /// `write`, submitted now and not waited for: the writer thread runs writes in the order they were
    /// submitted, so a later `write` that is awaited finds this one committed. For callers that must
    /// not block or await (the kernel's settings backend). Additive (2026-11-08).
    pub fn write_detached<F>(&self, f: F)
    where
        F: FnOnce(&mut Writer<'_>) -> Result<()> + Send + 'static,
    {
        let _ = self.thread.submit(Box::new(move |s| {
            if let Err(e) = transact(s, f) {
                tracing::warn!(error = %e, "a detached write failed");
            }
        }));
    }

    /// `write` for startup, imports and tests: blocks the calling thread until it commits. Refused on the
    /// writer thread (inside a listener), where it would wait for itself.
    pub fn write_blocking<T, F>(&self, f: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Writer<'_>) -> Result<T> + Send + 'static,
    {
        self.thread.blocking(move |s| transact(s, f))
    }

    /// A client's mutation, run once per (client, mid) in its own transaction (`Writer::mutation`).
    pub async fn record_mutation<T, F>(&self, client_id: &str, mid: &str, f: F) -> Result<MutationResult<T>>
    where
        T: Serialize + DeserializeOwned + Send + 'static,
        F: FnOnce(&mut Writer<'_>) -> Result<T> + Send + 'static,
    {
        let (client_id, mid) = (client_id.to_owned(), mid.to_owned());
        self.write(move |w| w.mutation(&client_id, &mid, f)).await
    }
}
