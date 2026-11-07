//! The store: one SQLite file (WAL, `synchronous=NORMAL`, STRICT tables, foreign keys on) holding every
//! row wisp keeps, plus the change feed that sync, history and plugin subscriptions all read (ADR-0004,
//! plan §4.1). One writer thread owns the only read-write connection and runs every write closure in
//! one transaction; reads go to a pool of read-only connections and never wait for a write.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, RwLock};

use rusqlite::{Connection, OpenFlags};
use wisp_kernel::Clock;

use crate::changes::ChangeRow;
use crate::entity::{EntityDef, Kind};
use crate::error::{Result, StoreError, invalid};
use crate::migrate::{self, MigrateReport, Migration};
use crate::reads::Reader;
use crate::schema::{KERNEL_MIGRATIONS, KERNEL_OWNER, PLUGIN, SETTING};
use crate::search::SearchIndex;
use crate::thread::WriterThread;

/// Where the database lives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Location {
    Path(PathBuf),
    /// tests: no WAL, no snapshots, every blob inline, reads share the writer's connection
    Memory,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Retention {
    pub change_ms: i64,
    pub change_rows: i64,
    pub mutation_ms: i64,
}

const DAY: i64 = 24 * 60 * 60 * 1000;
/// Change rows: 7 days or 1M rows, whichever keeps fewer. Mutation records: 24 h (plan §4.1).
pub const DEFAULT_RETENTION: Retention = Retention { change_ms: 7 * DAY, change_rows: 1_000_000, mutation_ms: DAY };

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PruneResult {
    pub changes: u64,
    pub mutations: u64,
}

pub type EpochFn = Arc<dyn Fn() -> String + Send + Sync>;
pub(crate) type CommitFn = Arc<dyn Fn(&Arc<[ChangeRow]>) + Send + Sync>;
pub(crate) type EpochListener = Arc<dyn Fn(&str) + Send + Sync>;

pub struct StoreOptions {
    pub location: Location,
    pub clock: Arc<dyn Clock>,
    /// where `backups/` and `blobs/` go; the database file's folder by default
    pub home: Option<PathBuf>,
    pub retention: Retention,
    /// read-only connections in the pool (file stores only)
    pub readers: usize,
    /// makes a fresh epoch (a new database, `rotate_epoch`); tests inject a fixed one
    pub epoch: EpochFn,
}

impl std::fmt::Debug for StoreOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StoreOptions").field("location", &self.location).field("home", &self.home).field("readers", &self.readers).finish_non_exhaustive()
    }
}

impl StoreOptions {
    pub fn new(location: Location, clock: Arc<dyn Clock>) -> Self {
        Self { location, clock, home: None, retention: DEFAULT_RETENTION, readers: 4, epoch: Arc::new(wisp_kernel::ids::uuid7) }
    }
}

/// What every handle shares: the writer, the reader pool, the registries and the listeners.
pub(crate) struct Shared {
    pub writer: Mutex<Connection>,
    pub readers: Vec<Mutex<Connection>>,
    next_reader: AtomicUsize,
    pub home: Option<PathBuf>,
    pub memory: bool,
    pub clock: Arc<dyn Clock>,
    pub retention: Retention,
    pub make_epoch: EpochFn,
    pub epoch: RwLock<String>,
    kinds: RwLock<HashMap<&'static str, Arc<Kind>>>,
    pub search: RwLock<HashMap<&'static str, SearchIndex>>,
    pub listeners: RwLock<Vec<(u64, CommitFn)>>,
    pub epoch_listeners: RwLock<Vec<(u64, EpochListener)>>,
    pub next_id: AtomicU64,
}

pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Shared {
    pub fn kind(&self, name: &str) -> Result<Arc<Kind>> {
        self.kinds.read().unwrap_or_else(PoisonError::into_inner).get(name).cloned().ok_or_else(|| invalid(format!("unknown entity kind {name}: its owner must define it first")))
    }
}

/// A handle on the store; cheap to clone. The writer thread stops when the last handle is dropped.
#[derive(Clone)]
pub struct Store {
    pub(crate) shared: Arc<Shared>,
    pub(crate) thread: Arc<WriterThread>,
}

impl std::fmt::Debug for Store {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Store").field("home", &self.shared.home).field("memory", &self.shared.memory).finish_non_exhaustive()
    }
}

fn configure(db: &Connection, memory: bool) -> Result<()> {
    if !memory {
        db.pragma_update(None, "journal_mode", "WAL")?;
    }
    db.execute_batch("PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY;")?;
    db.set_prepared_statement_cache_capacity(256);
    Ok(())
}

fn open_reader(path: &Path) -> Result<Connection> {
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX | OpenFlags::SQLITE_OPEN_URI)?;
    db.execute_batch("PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY;")?;
    db.set_prepared_statement_cache_capacity(256);
    Ok(db)
}

impl Store {
    /// Opens (or creates) the store and brings the kernel tables up to date.
    pub fn open(location: Location, clock: Arc<dyn Clock>) -> Result<Self> {
        Self::open_with(StoreOptions::new(location, clock))
    }

    pub fn open_with(opts: StoreOptions) -> Result<Self> {
        let (writer, path) = match &opts.location {
            Location::Memory => (Connection::open_in_memory()?, None),
            Location::Path(p) => {
                if let Some(dir) = p.parent().filter(|d| !d.as_os_str().is_empty()) {
                    std::fs::create_dir_all(dir)?;
                }
                (Connection::open(p)?, Some(p.clone()))
            }
        };
        let memory = path.is_none();
        configure(&writer, memory)?;
        let home = opts.home.clone().or_else(|| path.as_ref().and_then(|p| std::path::absolute(p).ok()).and_then(|p| p.parent().map(Path::to_path_buf)));
        migrate::run(&writer, home.as_deref(), opts.clock.now_ms(), KERNEL_OWNER, KERNEL_MIGRATIONS)?;
        let readers = match &path {
            Some(p) => (0..opts.readers.max(1)).map(|_| open_reader(p).map(Mutex::new)).collect::<Result<Vec<_>>>()?,
            None => Vec::new(),
        };
        let shared = Arc::new(Shared {
            writer: Mutex::new(writer),
            readers,
            next_reader: AtomicUsize::new(0),
            home,
            memory,
            clock: opts.clock,
            retention: opts.retention,
            make_epoch: opts.epoch,
            epoch: RwLock::new(String::new()),
            kinds: RwLock::new(HashMap::new()),
            search: RwLock::new(HashMap::new()),
            listeners: RwLock::new(Vec::new()),
            epoch_listeners: RwLock::new(Vec::new()),
            next_id: AtomicU64::new(1),
        });
        let thread = Arc::new(WriterThread::start(shared.clone())?);
        let store = Self { shared, thread };
        store.define_entity(SETTING)?;
        store.define_entity(PLUGIN)?;
        store.init_epoch()?;
        Ok(store)
    }

    fn init_epoch(&self) -> Result<()> {
        let had = self.read(|r| r.get_meta("epoch"))?;
        let epoch = match had {
            Some(e) => e,
            None => {
                let fresh = (self.shared.make_epoch)();
                let e = fresh.clone();
                self.thread.run_raw(move |db| crate::writer::write_meta(db, "epoch", Some(&e)))?;
                fresh
            }
        };
        *self.shared.epoch.write().unwrap_or_else(PoisonError::into_inner) = epoch;
        Ok(())
    }

    pub fn home(&self) -> Option<&Path> {
        self.shared.home.as_deref()
    }

    pub fn epoch(&self) -> String {
        self.shared.epoch.read().unwrap_or_else(PoisonError::into_inner).clone()
    }

    pub fn clock(&self) -> &Arc<dyn Clock> {
        &self.shared.clock
    }

    // ---------- schema ----------

    /// Runs an owner's forward-only migrations (startup and plugin setup; it blocks until done).
    pub fn migrate(&self, owner: &str, list: &[Migration]) -> Result<MigrateReport> {
        let (owner, home, now, list) = (owner.to_owned(), self.shared.home.clone(), self.shared.clock.now_ms(), list.to_vec());
        self.thread.run_raw(move |db| migrate::run(db, home.as_deref(), now, &owner, &list))
    }

    pub fn schema_version(&self, owner: &str) -> Result<u32> {
        let owner = owner.to_owned();
        self.thread.run_raw(move |db| migrate::schema_version(db, &owner))
    }

    /// Registers an owner's entity kind. The same definition twice is fine; another one under a taken
    /// kind name is refused.
    pub fn define_entity(&self, def: EntityDef) -> Result<()> {
        let kind = Kind::compile(def)?;
        let mut kinds = self.shared.kinds.write().unwrap_or_else(PoisonError::into_inner);
        if let Some(had) = kinds.get(def.kind) {
            let same = had.def.table == def.table && had.def.key == def.key && had.def.columns == def.columns && had.def.json_columns == def.json_columns && had.def.parent == def.parent;
            if !same {
                return Err(invalid(format!("entity kind {} is already registered", def.kind)));
            }
        }
        kinds.insert(def.kind, Arc::new(kind));
        Ok(())
    }

    // ---------- reads ----------

    /// Runs `f` with a consistent read view (one read transaction on a pooled connection). Fast and
    /// synchronous: call it from a blocking context, or use `read_async` from async code.
    pub fn read<T>(&self, f: impl FnOnce(&Reader<'_>) -> Result<T>) -> Result<T> {
        crate::thread::refuse_inside_write()?;
        if self.shared.memory {
            let db = lock(&self.shared.writer);
            return f(&Reader { db: &db, shared: &self.shared });
        }
        let db = self.reader();
        db.execute_batch("BEGIN DEFERRED")?;
        let out = f(&Reader { db: &db, shared: &self.shared });
        db.execute_batch("COMMIT")?;
        out
    }

    /// `read` on tokio's blocking pool, so an async handler never blocks its worker on SQLite.
    pub async fn read_async<T, F>(&self, f: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&Reader<'_>) -> Result<T> + Send + 'static,
    {
        let store = self.clone();
        tokio::task::spawn_blocking(move || store.read(f)).await.map_err(|e| StoreError::Internal(format!("a read panicked: {e}")))?
    }

    fn reader(&self) -> MutexGuard<'_, Connection> {
        let pool = &self.shared.readers;
        let start = self.shared.next_reader.fetch_add(1, Ordering::Relaxed);
        for i in 0..pool.len() {
            if let Ok(db) = pool[(start + i) % pool.len()].try_lock() {
                return db;
            }
        }
        lock(&pool[start % pool.len()])
    }

    // ---------- listeners ----------

    /// Hears every committed transaction's change rows, in commit order, on the writer thread right after
    /// the commit (never for a rolled-back one). Keep it quick: hand the rows to a channel. Dropping the
    /// returned guard unsubscribes.
    pub fn on_commit(&self, f: impl Fn(&Arc<[ChangeRow]>) + Send + Sync + 'static) -> Subscription {
        let id = self.shared.next_id.fetch_add(1, Ordering::Relaxed);
        self.shared.listeners.write().unwrap_or_else(PoisonError::into_inner).push((id, Arc::new(f)));
        Subscription { shared: Arc::downgrade(&self.shared), id }
    }

    /// Hears a new epoch (after a restore or an import).
    pub fn on_epoch(&self, f: impl Fn(&str) + Send + Sync + 'static) -> Subscription {
        let id = self.shared.next_id.fetch_add(1, Ordering::Relaxed);
        self.shared.epoch_listeners.write().unwrap_or_else(PoisonError::into_inner).push((id, Arc::new(f)));
        Subscription { shared: Arc::downgrade(&self.shared), id }
    }

    // ---------- epoch, retention ----------

    /// A fresh epoch, after a restore or an import: every client's cursor from before is distrusted.
    pub async fn rotate_epoch(&self) -> Result<String> {
        let epoch = (self.shared.make_epoch)();
        let e = epoch.clone();
        self.thread.run_raw_async(move |db| crate::writer::write_meta(db, "epoch", Some(&e))).await?;
        *self.shared.epoch.write().unwrap_or_else(PoisonError::into_inner) = epoch.clone();
        let listeners: Vec<EpochListener> = self.shared.epoch_listeners.read().unwrap_or_else(PoisonError::into_inner).iter().map(|(_, f)| f.clone()).collect();
        for f in listeners {
            crate::thread::call_listener(|| f(&epoch));
        }
        Ok(epoch)
    }

    /// Change rows: older than `change_ms` or beyond the newest `change_rows`. Mutation records: older than
    /// `mutation_ms`. Run it on a timer (hourly is plenty).
    pub async fn prune(&self) -> Result<PruneResult> {
        let (r, now) = (self.shared.retention, self.shared.clock.now_ms());
        self.thread.run_raw_async(move |db| prune(db, r, now)).await
    }

    /// Stops the writer thread once queued writes finish; later writes fail with `Closed`.
    pub fn close(&self) {
        self.thread.stop();
    }
}

fn prune(db: &Connection, r: Retention, now: i64) -> Result<PruneResult> {
    db.execute_batch("BEGIN IMMEDIATE")?;
    let run = || -> Result<PruneResult> {
        let head = crate::changes::head_seq(db)?;
        let by_count = db.execute("DELETE FROM change WHERE seq <= ?", [head - r.change_rows])?;
        let by_age = db.execute("DELETE FROM change WHERE at < ?", [now - r.change_ms])?;
        let mutations = db.execute("DELETE FROM mutation WHERE at < ?", [now - r.mutation_ms])?;
        Ok(PruneResult { changes: (by_count + by_age) as u64, mutations: mutations as u64 })
    };
    match run() {
        Ok(out) => {
            db.execute_batch("COMMIT")?;
            Ok(out)
        }
        Err(e) => {
            db.execute_batch("ROLLBACK")?;
            Err(e)
        }
    }
}

/// Unsubscribes its listener when dropped.
#[must_use = "dropping a Subscription unsubscribes at once"]
pub struct Subscription {
    shared: std::sync::Weak<Shared>,
    id: u64,
}

impl std::fmt::Debug for Subscription {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Subscription").field("id", &self.id).finish()
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        if let Some(s) = self.shared.upgrade() {
            s.listeners.write().unwrap_or_else(PoisonError::into_inner).retain(|(id, _)| *id != self.id);
            s.epoch_listeners.write().unwrap_or_else(PoisonError::into_inner).retain(|(id, _)| *id != self.id);
        }
    }
}
