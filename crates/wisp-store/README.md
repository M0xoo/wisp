# wisp-store

wisp's one SQLite store (ADR-0004, plan §4): rusqlite with bundled SQLite, WAL, `synchronous=NORMAL`,
STRICT tables, foreign keys on, cached prepared statements. One writer thread owns the only read-write
connection; reads use a pool of read-only connections and never wait for a write.

Plugin crates code against this API. It only grows: a change to a signature goes through the
`change-a-contract` skill.

## Open

```rust
use std::sync::Arc;
use wisp_store::{Location, Store, StoreOptions, SystemClock, ManualClock};

let store = Store::open(Location::Path(home.join("wisp.db")), Arc::new(SystemClock))?;
let test = Store::open(Location::Memory, Arc::new(ManualClock::new(0)))?; // tests: no WAL, blobs inline

let mut o = StoreOptions::new(location, clock); // home, retention, readers (4), epoch generator
let store = Store::open_with(o)?;
```

`Store` is `Clone` (an `Arc`). Opening runs the kernel migrations and registers the built-in kinds
`setting` and `plugin` (topic `config`). `close()` stops the writer once its queue drains; later
writes fail with `StoreError::Closed`.

**Kernel tables**: `meta(key, value)` (epoch, `schema:<owner>`, `search:<kind>`, owners' keys),
`change(seq AUTOINCREMENT, topic, more, entity, id, op, patch JSON, at)` with `change_topic(topic, seq)`,
`mutation(client_id, mid, status, result, seq, at)`, `blob`, `blob_ref`, `setting(key, value, locked_by)`,
`plugin(id, version, enabled, config, grants)`, `search_doc`.

## Migrations (per owner, forward-only)

```rust
const MIGRATIONS: &[Migration] = &[
    Migration::sql(1, "CREATE TABLE crew_member (id TEXT PRIMARY KEY, name TEXT) STRICT"),
    Migration::func(2, backfill),                       // fn(&rusqlite::Connection) -> Result<()>
    Migration::sql(3, "…table rebuild…").with_foreign_keys_off(), // FK-checked before commit
];
let report: MigrateReport = store.migrate("crew", MIGRATIONS)?; // {from, to, snapshot}
store.schema_version("crew")?;
```

Version `n` is entry `n`. Each step runs in its own transaction. Before upgrading an owner that already
has data, a `VACUUM INTO <home>/backups/<owner>-v<from>-<now>.db` copy is taken, and the 3 newest copies
are kept per owner. A database newer than the code is refused with `Conflict` and a message that names
the backups folder. Call `migrate` at startup or in plugin setup: it blocks until done.

## Entities

```rust
fn topics(r: &Row) -> Vec<Topic> { vec!["list".into(), format!("session:{}", r["id"].as_str().unwrap_or(""))] }

pub const SESSION: EntityDef = EntityDef {
    kind: "session", table: "runtime_session", key: "id",
    columns: &[("id", Col::Text), ("title", Col::Text), ("archived", Col::Bool), ("updated_at", Col::Int), ("extra", Col::Text)],
    json_columns: &["extra"],
    parent: None,          // event logs: Some("session_id"), one change row per parent per append
    seq: None,             // event logs: Some("seq"), what `window` pages by
    topics,                // the first topic is the change row's `topic`
};
store.define_entity(SESSION)?; // the same definition twice is fine, a different one under the name is refused
```

A `Row` is a `serde_json::Map`. JSON columns hold any JSON, `Bool` columns are `true`/`false`, and whole
numbers bind as integers (`3.0` too). `row!({...})`, `to_row(&T)` and `from_row::<T>(row)` convert.
`Id` is text or integer (`"42"` matches an integer key).

## Writes: the one write path

```rust
let out = store.write(|w| {
    w.upsert("session", row!({"id": "a", "title": "x"}))?;        // insert, or update only the given columns
    w.patch("session", "a", &[PatchOp::replace(&["title"], json!("y"))])?; // RFC 6902, into JSON columns too
    w.del("session", "a")?;                                         // -> bool
    w.append("event", rows)?;                                       // -> stored rows (int keys filled in)
    Ok(42)
}).await?;
store.write_blocking(|w| …)?; // startup, imports, tests; refused on the writer thread
```

- One closure is one `BEGIN IMMEDIATE … COMMIT` on the writer thread. Each op writes a change row in the
  same transaction: `upsert` of a new row puts the full row, `upsert`/`patch` of an existing row puts the
  RFC 6902 diff of old → new (column order, arrays that only grew as `add …/-`), `del` puts null, and
  `append` puts the new rows. A no-op write records nothing.
- A failed op **dooms** the transaction. The closure may catch the error, but it rolls back anyway, so a
  row can never commit without its change row. An `Err` or a panic rolls back and publishes nothing.
- Inside a closure, read through `w` (`w.get`, `w.query`, `w.count`, `w.head_seq`, `w.get_meta`): it sees
  its own uncommitted rows. `store.get` inside a closure is refused.
- `w.set_meta(key, Some(v) | None)` is for owners' bookkeeping. `epoch`, `schema:*` and `search:*` are refused.
- Constraint failures map to `Conflict` and STRICT type refusals to `Invalid`.

**Listeners.** `store.on_commit(|changes: &Arc<[ChangeRow]>| …) -> Subscription` (dropping it
unsubscribes). A listener runs on the writer thread right after the commit and before the writer's caller
gets its result. Commit order is publish order, and a rolled-back transaction is never heard. Keep
listeners quick: hand the rows to a channel. A panicking listener is logged and the others still run.

**Mutations (plan §4.5).** `store.record_mutation(client_id, mid, |w| …).await -> MutationResult {result,
seq, replayed}`, or `w.mutation(…)` inside a larger write. The (client, mid) record commits with its
effects. A retry returns the recorded result and `seq` (the head at commit) without running again.

## Reads

```rust
store.get("session", "a")?;                                    // Option<Row>
store.query("session", &Query::new().select(&["id", "title"]).eq("archived", false).desc("updated_at").limit(200))?;
store.query_json("session", &q)?;  // the same rows as JSON text, for list snapshots (see benches)
store.count("session", &Query::new().cond("updated_at", Cond::Gte(json!(5))))?;
store.window("event", "session-id", before_seq, 100)?;         // newest first, seq < before
store.changes_since(seq, Some(&["list", "session:a"]), 1000)?; // oldest first, ≤ 10,000 per call
store.changed_since("list", cursor)?;  // Some(Delta {rows, deleted, head}) | None past retention
store.head_seq()?; store.oldest_seq()?; store.can_resume(cursor)?;
store.read(|r| { r.get(…)?; r.query(…) })?;                   // several reads in one consistent view
store.read_async(|r| …).await?;                                // on tokio's blocking pool
```

`Cond` is `Eq`, `Ne`, `In`, `IsNull`, `NotNull`, `Gt`, `Gte`, `Lt`, `Lte` or `Like`. Column names are checked
against the kind and values are always bound. Pass a projection (`select`) for lists: decoding whole rows
is the expensive part.

## Search (FTS5)

`store.define_search("session", &["title", "extra"])?` creates or rebuilds the index (it rebuilds when
the column list changed) and indexes existing rows. The writer keeps it in step inside each transaction.
`store.search(text, Some(&["session"]), 50)? -> Vec<SearchHit {kind, id, score}>`: every word must match,
the last as a prefix. User text is quoted, so it is never read as FTS syntax. `to_match` is the quoting.

## Blobs (CAS)

`store.put_blob(bytes, Some((kind, id))).await -> BlobInfo {hash: "blake3:…", size, codec, inline}` hashes
and compresses on the blocking pool, then records the row. `w.put_blob(&bytes, Some(("turn", "t1")))`
does the same inside a write. zstd is used unless it doesn't shrink the data (`Codec::Raw`). Blobs that
are ≤ 64 KB compressed stay inline; bigger ones go to `<home>/blobs/ab/cdef…` (temp + fsync + rename).
Refs: `w.blob_ref`, `w.blob_unref`, `w.blob_unref_owner`. Reads: `store.blob(hash)`, `r.blob_refs`,
`r.blob_exists`. `store.gc_blobs().await -> GcResult` removes unreferenced rows, then their files, then
orphan files older than 10 minutes.

## Retention and epoch

`store.prune().await -> PruneResult {changes, mutations}`: change rows past 7 days or beyond the newest
1M, and mutation records past 24 h (`Retention` in `StoreOptions`). Seqs are never reused. Age pruning
drops the oldest run of rows older than the limit. `store.epoch()`, `store.rotate_epoch().await`
(on restore or import) and `store.on_epoch(…)`.

## Coalescer (streaming)

```rust
let c = Coalescer::new(&store, CoalescerOptions::default()); // 250 ms, on_error
c.append("event", rows)?; c.patch("session", id, ops)?;      // buffered
c.step().await;   // end of a harness step: commit now
c.close().await;  // flush and refuse more
```

Everything buffered commits in one transaction, 250 ms after the first write at most (timed by the
store's injected clock), or on `step`. Patches to one row merge into one net diff, and appends merge per
parent. If the batch is refused, each write commits alone and the refused ones go to `on_error`. The
timer needs a tokio runtime; a dropped coalescer still flushes on its timer.

## Files that stay files, and v1 import

`JsonFile::<T>::new(path)`: `read() -> Option<T>` (corrupt JSON fails, never reads as empty); `write(&v)`
(temp + fsync + rename, mode 0600); `save(&v).await -> bool` (`false` when a newer write landed first);
`clean_temps(now_ms)`.

`import_files(&store, ImportOptions::new("runtime.sessions", dir), handler).await -> ImportReport
{imported, unchanged, failed, stopped}`. The handler is `Arc<dyn Fn(&ImportFile, &mut Writer) -> Result<()>>`
(the file is already read). It runs one transaction per file, and the file's (mtime, size) mark commits
in the same transaction. The import resumes where it stopped (a `CancellationToken`) and re-imports files
v1 changed. A failed file is recorded and skipped until it changes. Temp files never match; the pattern
is `*.json` by default.

## Errors

`StoreError` has `Invalid`, `NotFound`, `Conflict`, `Closed`, `Internal`, `Sqlite`, `Io`, `Json`, and
`Wire(WireError)`, so a plugin's own error passes through a closure unchanged. `From<StoreError> for
WireError` maps codes at the edge, and `err.code()` gives the kernel `Code`.

## Tests and benches

`cargo test -p wisp-store`: 78 tests, covering the 64 TypeScript reference behaviours plus a real
process crash mid-transaction, the change-feed replay property (25 seeds × 40 transactions), and diff
then apply round trips. Benches:
`cargo test -p wisp-store --release --test bench -- --ignored --nocapture --test-threads=1`
(`g1_5k_sessions_2m_events`, `write_amplification_2mb_session_in_5000_events`, `list_profile`).
