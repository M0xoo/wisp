//! Reads over one connection, shared by `Reader` (a pooled read-only connection in one read
//! transaction) and `Writer` (which reads its own uncommitted rows).

use std::fmt::Write as _;
use std::sync::Arc;

use rusqlite::types::Value as Sql;
use rusqlite::{Connection, OptionalExtension, params_from_iter};

use crate::changes::{self, ChangeRow, Delta};
use crate::entity::{Id, Kind, Row};
use crate::error::{Result, invalid};
use crate::query::{Query, compile};
use crate::store::Shared;

pub(crate) fn get_row(db: &Connection, k: &Kind, id: &Id) -> Result<Option<Row>> {
    let mut st = db.prepare_cached(&k.get_sql)?;
    let mut rows = st.query([k.key_param(id)])?;
    match rows.next()? {
        Some(r) => Ok(Some(k.decode_row(r, &k.all_cols())?)),
        None => Ok(None),
    }
}

pub(crate) fn query(db: &Connection, k: &Kind, q: &Query) -> Result<Vec<Row>> {
    let c = compile(k, q, false)?;
    let mut st = db.prepare_cached(&c.sql)?;
    let mut rows = st.query(params_from_iter(c.params))?;
    let mut out = Vec::new();
    while let Some(r) = rows.next()? {
        out.push(k.decode_row(r, &c.cols)?);
    }
    Ok(out)
}

pub(crate) fn count(db: &Connection, k: &Kind, q: &Query) -> Result<u64> {
    let c = compile(k, q, true)?;
    let n: i64 = db.prepare_cached(&c.sql)?.query_row(params_from_iter(c.params), |r| r.get(0))?;
    Ok(u64::try_from(n).unwrap_or(0))
}

/// A page of an event log, newest first: the `limit` rows of `parent` whose seq is below `before`.
pub(crate) fn window(db: &Connection, k: &Kind, parent: &str, before: Option<i64>, limit: u32) -> Result<Vec<Row>> {
    let (Some(p), Some(seq)) = (k.def.parent, k.def.seq) else {
        return Err(invalid(format!("{}: window needs an event log (parent and seq columns)", k.name())));
    };
    if limit == 0 || limit > changes::MAX_LIMIT {
        return Err(invalid(format!("window: limit must be 1…{}", changes::MAX_LIMIT)));
    }
    let mut params = vec![Sql::Text(parent.to_owned())];
    let mut sql = format!("SELECT {} FROM \"{}\" WHERE \"{p}\" = ?", k.select_list, k.def.table);
    if let Some(b) = before {
        let _ = write!(sql, " AND \"{seq}\" < ?");
        params.push(Sql::Integer(b));
    }
    let _ = write!(sql, " ORDER BY \"{seq}\" DESC LIMIT ?");
    params.push(Sql::Integer(i64::from(limit)));
    let mut st = db.prepare_cached(&sql)?;
    let mut rows = st.query(params_from_iter(params))?;
    let cols = k.all_cols();
    let mut out = Vec::with_capacity(limit as usize);
    while let Some(r) = rows.next()? {
        out.push(k.decode_row(r, &cols)?);
    }
    Ok(out)
}

pub(crate) fn get_meta(db: &Connection, key: &str) -> Result<Option<String>> {
    Ok(db.prepare_cached("SELECT value FROM meta WHERE key = ?")?.query_row([key], |r| r.get(0)).optional()?)
}

/// A consistent view of the store: every read through one `Reader` sees the same committed state.
/// Get one with `Store::read`; it is a pooled read-only connection inside a read transaction.
pub struct Reader<'a> {
    pub(crate) db: &'a Connection,
    pub(crate) shared: &'a Arc<Shared>,
}

impl std::fmt::Debug for Reader<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Reader")
    }
}

impl Reader<'_> {
    pub fn get(&self, kind: &str, id: impl Into<Id>) -> Result<Option<Row>> {
        get_row(self.db, &*self.shared.kind(kind)?, &id.into())
    }
    /// Rows of a kind; with `select`, only those columns are read and returned.
    /// Whether `kind` is defined yet (a plugin defines its kinds when it starts).
    pub fn defines(&self, kind: &str) -> bool {
        self.shared.kind(kind).is_ok()
    }
    pub fn query(&self, kind: &str, q: &Query) -> Result<Vec<Row>> {
        query(self.db, &*self.shared.kind(kind)?, q)
    }
    pub fn count(&self, kind: &str, q: &Query) -> Result<u64> {
        count(self.db, &*self.shared.kind(kind)?, q)
    }
    /// `query` as JSON text (an array of objects, keys in projection order), for a list snapshot that
    /// goes onto the wire as it is: no `Row` maps are built and JSON columns are copied, not parsed.
    pub fn query_json(&self, kind: &str, q: &Query) -> Result<String> {
        crate::json_out::query_json(self.db, &*self.shared.kind(kind)?, q)
    }
    /// Newest first: the client sends `before` = the oldest event seq it holds (none for the latest page).
    pub fn window(&self, kind: &str, parent: &str, before: Option<i64>, limit: u32) -> Result<Vec<Row>> {
        window(self.db, &*self.shared.kind(kind)?, parent, before, limit)
    }
    /// Committed changes after `seq`, oldest first; only those on `topics` when given (≤ 10,000 per call).
    pub fn changes_since(&self, seq: i64, topics: Option<&[&str]>, limit: u32) -> Result<Vec<ChangeRow>> {
        changes::read(self.db, seq, topics, limit)
    }
    /// The rows on `topic` changed after `since`, as they are now; `None` when retention dropped part of
    /// that range (the client takes a snapshot).
    pub fn changed_since(&self, topic: &str, since: i64) -> Result<Option<Delta>> {
        changes::changed_since(self.db, &|k| self.shared.kind(k).ok(), topic, since)
    }
    /// The newest seq ever written (0 for none). Survives retention: seqs are never reused.
    pub fn head_seq(&self) -> Result<i64> {
        changes::head_seq(self.db)
    }
    /// The oldest seq still kept, or head + 1 when retention left none.
    pub fn oldest_seq(&self) -> Result<i64> {
        changes::oldest_seq(self.db)
    }
    pub fn can_resume(&self, cursor: i64) -> Result<bool> {
        changes::can_resume(self.db, cursor)
    }
    pub fn get_meta(&self, key: &str) -> Result<Option<String>> {
        get_meta(self.db, key)
    }
    pub fn search(&self, text: &str, kinds: Option<&[&str]>, limit: u32) -> Result<Vec<crate::search::SearchHit>> {
        crate::search::search(self.db, self.shared, text, kinds, limit)
    }
    pub fn blob(&self, hash: &str) -> Result<Option<Vec<u8>>> {
        crate::blob::get(self.db, self.shared.home.as_deref(), hash)
    }
    pub fn blob_exists(&self, hash: &str) -> Result<bool> {
        crate::blob::exists(self.db, hash)
    }
    pub fn blob_refs(&self, hash: &str) -> Result<u64> {
        crate::blob::refs(self.db, hash)
    }
}

/// One-call reads: each runs in its own read transaction (`Store::read` for several in one view).
impl crate::store::Store {
    pub fn get(&self, kind: &str, id: impl Into<Id>) -> Result<Option<Row>> {
        let id = id.into();
        self.read(|r| r.get(kind, id))
    }
    pub fn query(&self, kind: &str, q: &Query) -> Result<Vec<Row>> {
        self.read(|r| r.query(kind, q))
    }
    pub fn count(&self, kind: &str, q: &Query) -> Result<u64> {
        self.read(|r| r.count(kind, q))
    }
    pub fn query_json(&self, kind: &str, q: &Query) -> Result<String> {
        self.read(|r| r.query_json(kind, q))
    }
    pub fn window(&self, kind: &str, parent: &str, before: Option<i64>, limit: u32) -> Result<Vec<Row>> {
        self.read(|r| r.window(kind, parent, before, limit))
    }
    pub fn changes_since(&self, seq: i64, topics: Option<&[&str]>, limit: u32) -> Result<Vec<ChangeRow>> {
        self.read(|r| r.changes_since(seq, topics, limit))
    }
    pub fn changed_since(&self, topic: &str, since: i64) -> Result<Option<Delta>> {
        self.read(|r| r.changed_since(topic, since))
    }
    // the closures stay: `Reader::head_seq` as a path is not general over the reader's lifetime
    #[allow(clippy::redundant_closure_for_method_calls)]
    pub fn head_seq(&self) -> Result<i64> {
        self.read(|r| r.head_seq())
    }
    #[allow(clippy::redundant_closure_for_method_calls)]
    pub fn oldest_seq(&self) -> Result<i64> {
        self.read(|r| r.oldest_seq())
    }
    pub fn can_resume(&self, cursor: i64) -> Result<bool> {
        self.read(|r| r.can_resume(cursor))
    }
    pub fn get_meta(&self, key: &str) -> Result<Option<String>> {
        self.read(|r| r.get_meta(key))
    }
    pub fn search(&self, text: &str, kinds: Option<&[&str]>, limit: u32) -> Result<Vec<crate::search::SearchHit>> {
        self.read(|r| r.search(text, kinds, limit))
    }
    /// Owners' bookkeeping outside an entity write (`Writer::set_meta` inside one).
    pub async fn set_meta(&self, key: &str, value: Option<&str>) -> Result<()> {
        let (key, value) = (key.to_owned(), value.map(str::to_owned));
        self.write(move |w| w.set_meta(&key, value.as_deref())).await
    }
}
