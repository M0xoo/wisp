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
        f.debug_struct("StoreOptions")
            .field("location", &self.location)
            .field("home", &self.home)
            .field("readers", &self.readers)
            .finish_non_exhaustive()
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
    /// the event log's dedupe keys and append count (ADR-0044)
    pub log: crate::events::LogState,
}

pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Shared {
    pub fn kind(&self, name: &str) -> Result<Arc<Kind>> {
        self.kinds
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .get(name)
            .cloned()
            .ok_or_else(|| invalid(format!("unknown entity kind {name}: its owner must define it first")))
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
    let db =
        Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX | OpenFlags::SQLITE_OPEN_URI)?;
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
        let home = opts
            .home
            .clone()
            .or_else(|| path.as_ref().and_then(|p| std::path::absolute(p).ok()).and_then(|p| p.parent().map(Path::to_path_buf)));
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
            log: crate::events::LogState::default(),
        });
        let thread = Arc::new(WriterThread::start(shared.clone())?);
        let store = Self { shared, thread };
        store.define_entity(SETTING)?;
        store.define_entity(PLUGIN)?;
        store.init_epoch()?;
        store.init_events()?;
        Ok(store)
    }

    fn init_epoch(&self) -> Result<()> {
        let had = self.read(|r| r.get_meta("epoch"))?;
        let epoch = if let Some(e) = had {
            e
        } else {
            let fresh = (self.shared.make_epoch)();
            let e = fresh.clone();
            self.thread.run_raw(move |db| crate::writer::write_meta(db, "epoch", Some(&e)))?;
            fresh
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
            let same = had.def.table == def.table
                && had.def.key == def.key
                && had.def.columns == def.columns
                && had.def.json_columns == def.json_columns
                && had.def.parent == def.parent;
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

    /// Stops the writer thread once queued writes finish; later writes fail with `Closed`.
    pub fn close(&self) {
        self.thread.stop();
    }
}
