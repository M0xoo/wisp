//! The one write path (ADR-0004): every entity op writes its table row and its change row in the
//! caller's transaction. The change patch is the RFC 6902 diff between the decoded old and new rows, so
//! what clients apply is exactly what the table now holds, not what the caller asked for.
//!
//! An op that fails dooms its transaction: the closure may catch the error, but the transaction rolls
//! back anyway, so a half-done op can never commit (a row without its change row).

use std::sync::Arc;

use rusqlite::types::Value as Sql;
use rusqlite::{Connection, params, params_from_iter};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::changes::{self, ChangeOp, ChangeRow};
use crate::entity::{Id, Kind, Row, Shape, Topic, is_topic};
use crate::error::{Result, StoreError, invalid};
use crate::json_patch::{PatchOp, apply, deep_equal, diff_into};
use crate::query::Query;
use crate::reads;
use crate::store::Shared;

/// What `Writer::mutation` returns.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
pub struct MutationResult<T> {
    pub result: T,
    /// the head of the change feed when the mutation committed: the ack's seq
    pub seq: i64,
    /// true when this (client, mid) ran before and the recorded result was returned
    pub replayed: bool,
}

/// The handle a write closure gets: one open transaction on the writer thread.
pub struct Writer<'a> {
    pub(crate) db: &'a Connection,
    pub(crate) shared: &'a Arc<Shared>,
    pub(crate) pending: Vec<ChangeRow>,
    /// the transaction's time: every change row it writes carries it
    pub(crate) now: i64,
    pub(crate) doomed: Option<String>,
}

impl std::fmt::Debug for Writer<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Writer")
            .field("pending", &self.pending.len())
            .field("doomed", &self.doomed)
            .finish_non_exhaustive()
    }
}

const STORE_META: [&str; 3] = ["epoch", "schema:", "search:"];

impl Writer<'_> {
    /// Inserts, or updates the columns given (others keep their values). The key is required.
    pub fn upsert(&mut self, kind: &str, row: Row) -> Result<Row> {
        self.guard(move |w| w.upsert_inner(kind, &row))
    }
    /// Applies RFC 6902 ops to the row (JSON columns are paths too) and records the net diff.
    pub fn patch(&mut self, kind: &str, id: impl Into<Id>, ops: &[PatchOp]) -> Result<Row> {
        let id = id.into();
        self.guard(|w| w.patch_inner(kind, &id, ops))
    }
    /// true when there was a row to delete
    pub fn del(&mut self, kind: &str, id: impl Into<Id>) -> Result<bool> {
        let id = id.into();
        self.guard(|w| w.del_inner(kind, &id))
    }
    /// Inserts event-log rows (an INTEGER key left out is filled in); one change row per parent.
    pub fn append(&mut self, kind: &str, rows: Vec<Row>) -> Result<Vec<Row>> {
        self.guard(move |w| w.append_inner(kind, &rows))
    }

    pub fn get(&self, kind: &str, id: impl Into<Id>) -> Result<Option<Row>> {
        reads::get_row(self.db, &*self.shared.kind(kind)?, &id.into())
    }
    pub fn query(&self, kind: &str, q: &Query) -> Result<Vec<Row>> {
        reads::query(self.db, &*self.shared.kind(kind)?, q)
    }
    pub fn count(&self, kind: &str, q: &Query) -> Result<u64> {
        reads::count(self.db, &*self.shared.kind(kind)?, q)
    }
    pub fn head_seq(&self) -> Result<i64> {
        changes::head_seq(self.db)
    }
    /// the transaction's clock reading (ms since the epoch)
    pub fn now(&self) -> i64 {
        self.now
    }
    pub fn get_meta(&self, key: &str) -> Result<Option<String>> {
        reads::get_meta(self.db, key)
    }
    /// Owners' bookkeeping (import progress, …). Keys the store manages itself are refused.
    pub fn set_meta(&mut self, key: &str, value: Option<&str>) -> Result<()> {
        if STORE_META.iter().any(|p| key.starts_with(p)) {
            return Err(invalid(format!("meta key {key} belongs to the store")));
        }
        self.guard(|w| write_meta(w.db, key, value))
    }

    /// Runs a client's mutation once (plan §4.5). The (client, mid) record commits with its effects, so a
    /// retry over a flaky tunnel gets the first result back instead of running it again.
    pub fn mutation<T, F>(&mut self, client_id: &str, mid: &str, f: F) -> Result<MutationResult<T>>
    where
        T: Serialize + DeserializeOwned,
        F: FnOnce(&mut Self) -> Result<T>,
    {
        let had: Option<(Option<String>, i64)> = {
            let mut st = self.db.prepare_cached(
                "SELECT result, seq FROM mutation WHERE client_id = ? AND mid = ?",
            )?;
            let mut rows = st.query([client_id, mid])?;
            rows.next()?
                .map(|r| Ok::<_, rusqlite::Error>((r.get(0)?, r.get(1)?)))
                .transpose()?
        };
        if let Some((raw, seq)) = had {
            let result = serde_json::from_str(raw.as_deref().unwrap_or("null"))?;
            return Ok(MutationResult {
                result,
                seq,
                replayed: true,
            });
        }
        let result = f(self).inspect_err(|e| self.doom(e))?;
        self.guard(|w| {
            let seq = changes::head_seq(w.db)?;
            let stored = serde_json::to_string(&result)?;
            w.db.prepare_cached("INSERT INTO mutation (client_id, mid, status, result, seq, at) VALUES (?, ?, 'ok', ?, ?, ?)")?.execute(params![client_id, mid, stored, seq, w.now])?;
            Ok(MutationResult { result, seq, replayed: false })
        })
    }

    pub(crate) fn guard<T>(&mut self, f: impl FnOnce(&mut Self) -> Result<T>) -> Result<T> {
        if let Some(first) = &self.doomed {
            return Err(StoreError::Internal(format!(
                "this transaction already failed ({first}); it will roll back"
            )));
        }
        f(self).inspect_err(|e| self.doom(e))
    }

    fn doom(&mut self, e: &StoreError) {
        self.doomed.get_or_insert_with(|| e.to_string());
    }

    fn upsert_inner(&mut self, kind: &str, row: &Row) -> Result<Row> {
        let k = self.shared.kind(kind)?;
        let id = k.id_value(row)?;
        let (mask, vals) = k.encode(row)?;
        let old = reads::get_row(self.db, &k, &id)?;
        if let Some(old) = old.as_ref().filter(|o| {
            row.iter()
                .all(|(c, v)| o.get(c).is_some_and(|ov| deep_equal(ov, v)))
        }) {
            return Ok(old.clone()); // nothing to write, nothing to tell
        }
        let next = self.returning(&k, &k.sql(Shape::Upsert, mask), vals, row)?;
        let sid = k.id_of(&next)?;
        match old {
            Some(old) => {
                let ops = row_diff(&k, &old, &next);
                self.record(
                    &k,
                    ChangeOp::Patch,
                    sid.clone(),
                    ops,
                    topics_of(&k, &[&old, &next])?,
                )?;
            }
            None => self.record(
                &k,
                ChangeOp::Upsert,
                sid.clone(),
                Value::Object(next.clone()),
                topics_of(&k, &[&next])?,
            )?,
        }
        crate::search::reindex(self.db, self.shared, &k, &sid, Some(&next))?;
        Ok(next)
    }

    fn patch_inner(&mut self, kind: &str, id: &Id, ops: &[PatchOp]) -> Result<Row> {
        let k = self.shared.kind(kind)?;
        let old = reads::get_row(self.db, &k, id)?
            .ok_or_else(|| StoreError::NotFound(format!("{kind} {id} does not exist")))?;
        let next = apply(&Value::Object(old.clone()), ops)
            .map_err(|e| invalid(format!("{kind} {id}: {e}")))?;
        let Value::Object(want) = next else {
            return Err(invalid(format!(
                "{kind} {id}: a patch must leave an object"
            )));
        };
        for c in want.keys() {
            k.col(c)?;
        }
        if !deep_equal(
            want.get(k.def.key).unwrap_or(&Value::Null),
            old.get(k.def.key).unwrap_or(&Value::Null),
        ) {
            return Err(invalid(format!(
                "{kind} {id}: a patch cannot change {}",
                k.def.key
            )));
        }
        let mut mask = 0u64;
        let mut vals = Vec::new();
        for (i, (c, _)) in k.def.columns.iter().enumerate() {
            let v = want.get(*c).unwrap_or(&Value::Null);
            if !deep_equal(v, old.get(*c).unwrap_or(&Value::Null)) {
                mask |= 1 << i;
                vals.push(k.encode_value(i, v)?);
            }
        }
        if mask == 0 {
            return Ok(old);
        }
        vals.push(k.key_param(id));
        let stored = self.returning(&k, &k.sql(Shape::Update, mask), vals, &want)?;
        let sid = k.id_of(&stored)?;
        let ops = row_diff(&k, &old, &stored);
        self.record(
            &k,
            ChangeOp::Patch,
            sid.clone(),
            ops,
            topics_of(&k, &[&old, &stored])?,
        )?;
        crate::search::reindex(self.db, self.shared, &k, &sid, Some(&stored))?;
        Ok(stored)
    }

    fn del_inner(&mut self, kind: &str, id: &Id) -> Result<bool> {
        let k = self.shared.kind(kind)?;
        let Some(old) = reads::get_row(self.db, &k, id)? else {
            return Ok(false);
        };
        self.db
            .prepare_cached(&k.del_sql)?
            .execute([k.key_param(id)])?;
        let sid = k.id_of(&old)?;
        self.record(
            &k,
            ChangeOp::Del,
            sid.clone(),
            Value::Null,
            topics_of(&k, &[&old])?,
        )?;
        crate::search::reindex(self.db, self.shared, &k, &sid, None)?;
        Ok(true)
    }

    fn append_inner(&mut self, kind: &str, rows: &[Row]) -> Result<Vec<Row>> {
        let k = self.shared.kind(kind)?;
        let mut stored = Vec::with_capacity(rows.len());
        // Appends are grouped under their parent (a session's events), so one change row carries a batch.
        let mut groups: Vec<(String, Vec<usize>)> = Vec::new();
        for row in rows {
            let (mask, vals) = k.encode(row)?;
            let next = self.returning(&k, &k.sql(Shape::Insert, mask), vals, row)?;
            let group = match k.parent_pos {
                Some(p) => {
                    crate::entity::text_of(next.get(k.def.columns[p].0).unwrap_or(&Value::Null))
                }
                None => k.id_of(&next)?,
            };
            match groups.iter_mut().find(|(g, _)| *g == group) {
                Some((_, list)) => list.push(stored.len()),
                None => groups.push((group, vec![stored.len()])),
            }
            crate::search::reindex(self.db, self.shared, &k, &k.id_of(&next)?, Some(&next))?;
            stored.push(next);
        }
        for (group, idx) in groups {
            let list: Vec<&Row> = idx.iter().map(|&i| &stored[i]).collect();
            let topics = topics_of(&k, &list)?;
            let patch = Value::Array(list.into_iter().map(|r| Value::Object(r.clone())).collect());
            self.record(&k, ChangeOp::Append, group, patch, topics)?;
        }
        Ok(stored)
    }

    fn returning(&self, k: &Kind, sql: &str, vals: Vec<Sql>, given: &Row) -> Result<Row> {
        let mut st = self.db.prepare_cached(sql)?;
        let mut rows = st.query(params_from_iter(vals))?;
        let r = rows.next()?.ok_or_else(|| {
            StoreError::Internal(format!("{}: the write returned no row", k.name()))
        })?;
        k.decode_returning(r, given)
    }

    fn record(
        &mut self,
        k: &Kind,
        op: ChangeOp,
        id: String,
        patch: Value,
        mut topics: Vec<Topic>,
    ) -> Result<()> {
        if op == ChangeOp::Patch && patch.as_array().is_some_and(Vec::is_empty) {
            return Ok(());
        }
        let topic = topics.remove(0); // topics_of never returns an empty list
        topics.sort(); // the order the feed reads them back in
        let text = if patch.is_null() {
            None
        } else {
            Some(serde_json::to_string(&patch)?)
        };
        let more = if topics.is_empty() {
            None
        } else {
            Some(topics.join(" "))
        };
        self.db
            .prepare_cached(
                "INSERT INTO change (topic, more, entity, id, op, patch, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            )?
            .execute(params![topic, more, k.name(), id, op.as_str(), text, self.now])?;
        let seq = self.db.last_insert_rowid();
        let mut st = self
            .db
            .prepare_cached("INSERT INTO change_topic (topic, seq) VALUES (?, ?)")?;
        for t in std::iter::once(&topic).chain(&topics) {
            st.execute(params![t, seq])?;
        }
        let mut all = Vec::with_capacity(topics.len() + 1);
        all.push(topic.clone());
        all.extend(topics);
        self.pending.push(ChangeRow {
            seq,
            topic,
            topics: all,
            entity: k.name().to_owned(),
            id,
            op,
            patch,
            at: self.now,
        });
        Ok(())
    }
}

/// The diff of two decoded rows, column by column in declared order (not map order), so a patch lists
/// its ops the way the TypeScript twin does.
fn row_diff(k: &Kind, old: &Row, new: &Row) -> Value {
    let mut ops = Vec::new();
    let mut path = String::new();
    for (c, _) in k.def.columns {
        path.clear();
        path.push('/');
        path.push_str(&crate::json_patch::escape_pointer(c));
        diff_into(
            old.get(*c).unwrap_or(&Value::Null),
            new.get(*c).unwrap_or(&Value::Null),
            &mut path,
            &mut ops,
        );
    }
    serde_json::to_value(ops).unwrap_or(Value::Null)
}

fn topics_of(k: &Kind, rows: &[&Row]) -> Result<Vec<Topic>> {
    let mut out: Vec<Topic> = Vec::new();
    for r in rows {
        for t in (k.def.topics)(r) {
            if !out.contains(&t) {
                out.push(t);
            }
        }
    }
    if out.is_empty() {
        return Err(invalid(format!(
            "{}: every row must be on at least one topic",
            k.name()
        )));
    }
    if let Some(bad) = out.iter().find(|t| !is_topic(t)) {
        return Err(invalid(format!("{}: bad topic {bad}", k.name())));
    }
    Ok(out)
}

pub(crate) fn write_meta(db: &Connection, key: &str, value: Option<&str>) -> Result<()> {
    match value {
        None => db.prepare_cached("DELETE FROM meta WHERE key = ?")?.execute([key])?,
        Some(v) => db.prepare_cached("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")?.execute([key, v])?,
    };
    Ok(())
}
