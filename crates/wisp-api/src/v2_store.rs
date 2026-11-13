//! The v2 stream on wisp-store (ADR-0004, ADR-0005): what `Snapshots` reads, and the commit feed.
//!
//! - A resume (`since`) is `Reader::changed_since(topic, since)`: the rows changed after the cursor, as
//!   they are now, plus the ones deleted. When retention dropped part of that range it falls back to a
//!   full snapshot, which the client takes in place of its rows.
//! - A full snapshot is `Reader::query_json` on each kind a [`TopicSource`] names for the topic (the
//!   JSON text the store wrote, parsed once). A topic no source names is read from the change feed
//!   (`changed_since(topic, 0)`) while it still holds every change; past that it reads empty.
//! - [`feed`] hands every committed transaction's change rows to `Driver::committed`, one wire change
//!   per topic a row is on, from the store's writer thread (a channel send: it never blocks).
//!
//! Every read runs on the store's reader pool (`read_async`), never on the runtime's workers.
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Map, Value};
use wisp_kernel::BoxFuture;
use wisp_protocol::{Change, PatchOp, Row, Topic};
use wisp_store::{ChangeOp, Delta, Query, Reader, Store, Subscription};
use wisp_sync::{ChangeRow, Gone};

use crate::egress::{self, NoViews, ViewSource};
use crate::v2::{Driver, Read, Snapshots};

/// The kinds a topic's full snapshot reads: `matches` picks the topics, `query` the rows (the topic
/// is passed in, so `session:<id>` can filter by its id).
#[derive(Clone, Copy)]
pub struct TopicSource {
    pub kind: &'static str,
    /// the kind's key column (`EntityDef::key`): a row's `id` on the wire
    pub key: &'static str,
    pub matches: fn(&str) -> bool,
    pub query: fn(&str) -> Query,
}

impl std::fmt::Debug for TopicSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TopicSource")
            .field("kind", &self.kind)
            .finish_non_exhaustive()
    }
}

/// An event log a topic pages back through (`window`): `session:<id>` → the kind's rows under `<id>`.
#[derive(Debug, Clone, Copy)]
pub struct WindowSource {
    pub prefix: &'static str,
    pub kind: &'static str,
}

/// `Snapshots` over a store. The feed's head is kept from the commits it hears, so answering a
/// command never reads the database on the runtime.
#[derive(Clone)]
pub struct StoreSnapshots {
    store: Store,
    sources: Arc<[TopicSource]>,
    windows: Arc<[WindowSource]>,
    head: Arc<AtomicU64>,
    _heard: Arc<Subscription>,
    /// each row's owner's `kernel.egress` view, before it leaves (ADR-0050)
    views: Arc<dyn ViewSource>,
}

impl std::fmt::Debug for StoreSnapshots {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StoreSnapshots").field("head", &self.head).finish_non_exhaustive()
    }
}

impl StoreSnapshots {
    /// At startup: reads the head once, then follows the commits.
    pub fn new(store: Store, sources: Vec<TopicSource>, windows: Vec<WindowSource>) -> Self {
        let head = Arc::new(AtomicU64::new(store.read(head_of).map_or(0, seq)));
        let h = head.clone();
        let heard = store.on_commit(move |rows| {
            if let Some(top) = rows.iter().map(|c| seq(c.seq)).max() {
                h.fetch_max(top, Ordering::Relaxed);
            }
        });
        Self {
            store,
            sources: sources.into(),
            windows: windows.into(),
            head,
            _heard: Arc::new(heard),
            views: Arc::new(NoViews),
        }
    }

    /// Rows leave through `views` (the kernel's `kernel.egress` contributions). Additive (2026-11-13).
    #[must_use]
    pub fn with_views(mut self, views: Arc<dyn ViewSource>) -> Self {
        self.views = views;
        self
    }
}

// named fns, not `Reader::head_seq`: a method path isn't general over the reader's lifetime
fn head_of(r: &Reader<'_>) -> wisp_store::Result<i64> {
    r.head_seq()
}

fn oldest_of(r: &Reader<'_>) -> wisp_store::Result<i64> {
    r.oldest_seq()
}

fn seq(v: i64) -> u64 {
    u64::try_from(v).unwrap_or(0)
}

fn id_text(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

fn wire_rows(
    rows: Vec<(String, Map<String, Value>)>,
    key_of: impl Fn(&str) -> Option<&'static str>,
) -> Vec<Row> {
    rows.into_iter()
        .map(|(e, v)| {
            let id = key_of(&e).map_or_else(|| id_text(v.get("id")), |k| id_text(v.get(k)));
            Row {
                e,
                id,
                v: Value::Object(v),
            }
        })
        .collect()
}

fn delta_read(d: Delta, full: bool, key_of: impl Fn(&str) -> Option<&'static str>) -> Read {
    Read {
        seq: seq(d.head),
        rows: wire_rows(d.rows, key_of),
        full,
        deleted: d
            .deleted
            .into_iter()
            .map(|(e, id)| Gone { e, id })
            .collect(),
    }
}

/// Every source's rows for `topic`, from the JSON the store writes.
fn full_rows(
    r: &Reader<'_>,
    sources: &[TopicSource],
    topic: &str,
) -> wisp_store::Result<Option<Vec<Row>>> {
    let mine: Vec<&TopicSource> = sources.iter().filter(|s| (s.matches)(topic)).collect();
    if mine.is_empty() {
        return Ok(None);
    }
    let mut out = Vec::new();
    for s in mine {
        // a plugin's kind that isn't defined yet (it hasn't started, or it's off) has no rows to show
        if !r.defines(s.kind) {
            continue;
        }
        let text = r.query_json(s.kind, &(s.query)(topic))?;
        let rows: Vec<Map<String, Value>> = serde_json::from_str(&text)
            .map_err(|e| wisp_store::StoreError::Internal(format!("{}: {e}", s.kind)))?;
        out.extend(rows.into_iter().map(|v| Row {
            e: s.kind.to_owned(),
            id: id_text(v.get(s.key)),
            v: Value::Object(v),
        }));
    }
    Ok(Some(out))
}

fn read_topic(
    r: &Reader<'_>,
    sources: &[TopicSource],
    topic: &str,
    since: Option<u64>,
) -> wisp_store::Result<Read> {
    let key_of = |e: &str| sources.iter().find(|s| s.kind == e).map(|s| s.key);
    if let Some(since) = since
        && let Some(d) = r.changed_since(topic, i64::try_from(since).unwrap_or(i64::MAX))?
    {
        return Ok(delta_read(d, false, key_of));
    }
    // a first look, or a cursor retention already dropped: the whole topic
    let head = r.head_seq()?;
    if let Some(rows) = full_rows(r, sources, topic)? {
        return Ok(Read {
            seq: seq(head),
            rows,
            full: true,
            deleted: Vec::new(),
        });
    }
    if let Some(d) = r.changed_since(topic, 0)? {
        return Ok(delta_read(d, true, key_of));
    }
    tracing::warn!(
        topic,
        "no snapshot source and the change feed was pruned: the topic reads empty"
    );
    Ok(Read {
        seq: seq(head),
        full: true,
        ..Read::default()
    })
}

impl Snapshots for StoreSnapshots {
    fn epoch(&self) -> String {
        self.store.epoch()
    }
    fn head_seq(&self) -> u64 {
        self.head.load(Ordering::Relaxed)
    }
    /// Read once, when the stream starts (retention moves it later through `Driver::retained`).
    fn oldest_seq(&self) -> u64 {
        self.store.read(oldest_of).map_or(0, seq)
    }
    fn snapshot(&self, topic: &Topic, since: Option<u64>) -> BoxFuture<'static, Read> {
        let (store, sources, topic) = (
            self.store.clone(),
            self.sources.clone(),
            topic.as_str().to_owned(),
        );
        let views = self.views.clone();
        Box::pin(async move {
            let t = topic.clone();
            let mut read = store
                .read_async(move |r| read_topic(r, &sources, &t, since))
                .await
                .unwrap_or_else(|e| {
                    tracing::warn!(topic, "snapshot failed: {e}");
                    Read {
                        full: since.is_none(),
                        ..Read::default()
                    }
                });
            egress::rows(&views.views(), &mut read.rows);
            read
        })
    }
    fn window(
        &self,
        topic: &Topic,
        before_seq: u64,
        limit: u32,
    ) -> BoxFuture<'static, (Vec<Row>, bool)> {
        let t = topic.as_str();
        let found = self.windows.iter().find_map(|w| {
            t.strip_prefix(w.prefix)
                .map(|parent| (w.kind, parent.to_owned()))
        });
        let (store, views) = (self.store.clone(), self.views.clone());
        Box::pin(async move {
            let Some((kind, parent)) = found else {
                return (Vec::new(), true);
            };
            let before = (before_seq > 0).then(|| i64::try_from(before_seq).unwrap_or(i64::MAX));
            let rows = store
                .read_async(move |r| r.window(kind, &parent, before, limit))
                .await
                .unwrap_or_default();
            let done = rows.len() < limit as usize;
            let mut rows: Vec<Row> = rows
                .into_iter()
                .map(|v| Row {
                    e: kind.to_owned(),
                    id: id_text(v.get("id")),
                    v: Value::Object(v),
                })
                .collect();
            egress::rows(&views.views(), &mut rows);
            (rows, done)
        })
    }
}

/// A committed change as the stream carries it: one per topic the row is on.
pub fn to_wire(c: &wisp_store::ChangeRow) -> Vec<ChangeRow> {
    let change = match c.op {
        ChangeOp::Upsert => Change::Upsert { v: c.patch.clone() },
        ChangeOp::Patch => match serde_json::from_value::<Vec<PatchOp>>(c.patch.clone()) {
            Ok(ops) => Change::Patch { ops },
            Err(e) => {
                tracing::warn!(
                    entity = c.entity,
                    "a change row's patch isn't RFC 6902: {e}"
                );
                return Vec::new();
            }
        },
        ChangeOp::Del => Change::Del,
        ChangeOp::Append => Change::Append {
            v: c.patch.as_array().cloned().unwrap_or_default(),
        },
    };
    c.topics
        .iter()
        .filter_map(|t| Topic::parse(t))
        .map(|topic| ChangeRow {
            seq: seq(c.seq),
            topic,
            entity: c.entity.clone(),
            id: c.id.clone(),
            change: change.clone(),
            at: seq(c.at),
        })
        .collect()
}

/// Streams every commit to `driver`. Keep the subscription: dropping it stops the feed.
pub fn feed(store: &Store, driver: Arc<Driver>) -> Subscription {
    feed_viewed(store, driver, Arc::new(NoViews))
}

/// [`feed`], each change through its owner's `kernel.egress` view first (ADR-0050). Additive (2026-11-13).
pub fn feed_viewed(store: &Store, driver: Arc<Driver>, views: Arc<dyn ViewSource>) -> Subscription {
    store.on_commit(move |rows| {
        let mut wire: Vec<ChangeRow> = rows.iter().flat_map(to_wire).collect();
        if !wire.is_empty() {
            let vs = views.views();
            for c in &mut wire {
                egress::change(&vs, c);
            }
            driver.committed(wire);
        }
    })
}
