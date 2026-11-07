//! Full-text search (FTS5) for entity kinds that ask for it. The writer keeps the index in the same
//! transaction as the row. FTS5 rowids come from `search_doc`, not the entity table: an implicit rowid may
//! be renumbered by VACUUM, which would point hits at the wrong rows.

use std::sync::{Arc, PoisonError};

use rusqlite::types::Value as Sql;
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::entity::{Kind, Row};
use crate::error::{Result, invalid};
use crate::store::{Shared, Store};

#[derive(Debug, Clone)]
pub(crate) struct SearchIndex {
    pub kind: &'static str,
    pub columns: Vec<String>,
    pub table: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SearchHit {
    pub kind: String,
    pub id: String,
    /// bm25: lower is better
    pub score: f64,
}

impl Store {
    /// Indexes `columns` of a kind (JSON columns as their text). Creates the index, or rebuilds it when the
    /// column list changed; rows that existed before are indexed. Runs at setup and blocks until done.
    pub fn define_search(&self, kind: &str, columns: &[&str]) -> Result<()> {
        let k = self.shared.kind(kind)?;
        if columns.is_empty() {
            return Err(invalid(format!("{kind}: search needs at least one column")));
        }
        for c in columns {
            k.col(c)?;
        }
        let ix = SearchIndex { kind: k.name(), columns: columns.iter().map(|c| (*c).to_owned()).collect(), table: format!("fts_{}", k.def.table) };
        let name = ix.kind;
        // Registered on the writer thread, inside the build's transaction: no write can slip in between.
        let out = self.write_blocking(move |w| {
            build(w.db, &k, &ix)?;
            w.shared.search.write().unwrap_or_else(PoisonError::into_inner).insert(ix.kind, ix);
            Ok(())
        });
        if out.is_err() {
            self.shared.search.write().unwrap_or_else(PoisonError::into_inner).remove(name);
        }
        out
    }
}

fn build(db: &Connection, k: &Kind, ix: &SearchIndex) -> Result<()> {
    let sig = ix.columns.join(",");
    let key = format!("search:{}", ix.kind);
    let was: Option<String> = db.query_row("SELECT value FROM meta WHERE key = ?", [&key], |r| r.get(0)).optional()?;
    if was.as_deref() == Some(sig.as_str()) {
        return Ok(());
    }
    let cols = ix.columns.iter().map(|c| format!("\"{c}\"")).collect::<Vec<_>>().join(", ");
    // contentless + contentless_delete: the text stays in the entity table only, and rows can still be
    // removed by rowid (SQLite ≥ 3.43, which the bundled build has).
    db.execute_batch(&format!("DROP TABLE IF EXISTS \"{0}\"; CREATE VIRTUAL TABLE \"{0}\" USING fts5({cols}, content='', contentless_delete=1);", ix.table))?;
    db.execute("DELETE FROM search_doc WHERE kind = ?", [ix.kind])?;
    let rows: Vec<Row> = crate::reads::query(db, k, &crate::query::Query::new())?;
    for row in &rows {
        index(db, ix, k, &k.id_of(row)?, Some(row))?;
    }
    db.execute("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [key, sig])?;
    Ok(())
}

pub(crate) fn reindex(db: &Connection, shared: &Shared, k: &Kind, id: &str, row: Option<&Row>) -> Result<()> {
    let ix = shared.search.read().unwrap_or_else(PoisonError::into_inner).get(k.name()).cloned();
    match ix {
        Some(ix) => index(db, &ix, k, id, row),
        None => Ok(()),
    }
}

/// Puts a row's text in the index, or takes it out (`row` None).
fn index(db: &Connection, ix: &SearchIndex, _k: &Kind, id: &str, row: Option<&Row>) -> Result<()> {
    let rid: Option<i64> = db.prepare_cached("SELECT rid FROM search_doc WHERE kind = ? AND id = ?")?.query_row([ix.kind, id], |r| r.get(0)).optional()?;
    if let Some(rid) = rid {
        db.prepare_cached(&format!("DELETE FROM \"{}\" WHERE rowid = ?", ix.table))?.execute([rid])?;
    }
    let Some(row) = row else {
        if let Some(rid) = rid {
            db.prepare_cached("DELETE FROM search_doc WHERE rid = ?")?.execute([rid])?;
        }
        return Ok(());
    };
    let doc = match rid {
        Some(r) => r,
        None => {
            db.prepare_cached("INSERT INTO search_doc (kind, id) VALUES (?, ?)")?.execute(params![ix.kind, id])?;
            db.last_insert_rowid()
        }
    };
    let mut vals = vec![Sql::Integer(doc)];
    vals.extend(ix.columns.iter().map(|c| text_of(row.get(c))));
    let cols = ix.columns.iter().map(|c| format!("\"{c}\"")).collect::<Vec<_>>().join(", ");
    let marks = vec!["?"; ix.columns.len()].join(", ");
    db.prepare_cached(&format!("INSERT INTO \"{}\" (rowid, {cols}) VALUES (?, {marks})", ix.table))?.execute(params_from_iter(vals))?;
    Ok(())
}

fn text_of(v: Option<&Value>) -> Sql {
    match v {
        None | Some(Value::Null) => Sql::Null,
        Some(Value::String(s)) => Sql::Text(s.clone()),
        Some(other) => Sql::Text(other.to_string()),
    }
}

pub(crate) fn search(db: &Connection, shared: &Arc<Shared>, text: &str, kinds: Option<&[&str]>, limit: u32) -> Result<Vec<SearchHit>> {
    let m = to_match(text);
    if m.is_empty() || limit == 0 {
        return Ok(Vec::new());
    }
    let all = shared.search.read().unwrap_or_else(PoisonError::into_inner).clone();
    let picked: Vec<SearchIndex> = match kinds {
        Some(ks) => ks.iter().map(|k| all.get(k).cloned().ok_or_else(|| invalid(format!("{k} has no search index")))).collect::<Result<_>>()?,
        None => all.into_values().collect(),
    };
    let mut hits = Vec::new();
    for ix in picked {
        let t = &ix.table;
        let sql = format!("SELECT d.id, bm25(\"{t}\") AS score FROM \"{t}\" f JOIN search_doc d ON d.rid = f.rowid WHERE \"{t}\" MATCH ? ORDER BY score LIMIT ?");
        let mut st = db.prepare_cached(&sql)?;
        let mut rows = st.query(params![m, limit])?;
        while let Some(r) = rows.next()? {
            hits.push(SearchHit { kind: ix.kind.to_owned(), id: r.get(0)?, score: r.get(1)? });
        }
    }
    hits.sort_by(|a, b| a.score.total_cmp(&b.score));
    hits.truncate(limit as usize);
    Ok(hits)
}

/// What a person types, as an FTS5 query: every word must appear, the last one as a prefix (search as you
/// type). Each word is quoted, so `-`, `:`, `"` or `AND` are text, never query syntax.
pub fn to_match(text: &str) -> String {
    let words: Vec<&str> = text.split_whitespace().filter(|w| w.chars().any(char::is_alphanumeric)).collect();
    let last = words.len().saturating_sub(1);
    words.iter().enumerate().map(|(i, w)| format!("\"{}\"{}", w.replace('"', "\"\""), if i == last { "*" } else { "" })).collect::<Vec<_>>().join(" ")
}
