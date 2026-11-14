//! Rows straight to JSON text, for list snapshots that go onto the wire as they are: no `Row` maps, no
//! per-value allocations, and JSON columns copied verbatim instead of parsed and re-serialised (the
//! G1 list query spent 3× more time building `Row`s than SQLite spent reading them).

use std::io::Write as _;

use rusqlite::types::ValueRef;
use rusqlite::{Connection, params_from_iter};

use crate::entity::{How, Kind};
use crate::error::{Result, StoreError};
use crate::query::{Query, compile};

pub(crate) fn query_json(db: &Connection, k: &Kind, q: &Query) -> Result<String> {
    let c = compile(k, q, false)?;
    // `{"id":` then `,"title":` …: each key written once per row from a ready-made prefix
    let keys: Vec<Vec<u8>> = c
        .cols
        .iter()
        .enumerate()
        .map(|(n, &i)| {
            let mut key = vec![if n == 0 { b'{' } else { b',' }];
            serde_json::to_writer(&mut key, k.def.columns[i].0)?;
            key.push(b':');
            Ok(key)
        })
        .collect::<Result<_>>()?;
    let mut st = db.prepare_cached(&c.sql)?;
    let mut rows = st.query(params_from_iter(c.params))?;
    let mut out = Vec::with_capacity(16 * 1024);
    out.push(b'[');
    let mut first = true;
    while let Some(r) = rows.next()? {
        if !first {
            out.push(b',');
        }
        first = false;
        for (n, &i) in c.cols.iter().enumerate() {
            out.extend_from_slice(&keys[n]);
            value(&mut out, k.how[i], r.get_ref(n)?)?;
        }
        if c.cols.is_empty() {
            out.push(b'{');
        }
        out.push(b'}');
    }
    out.push(b']');
    String::from_utf8(out).map_err(|e| StoreError::Internal(format!("{}: a stored value is not UTF-8: {e}", k.name())))
}

fn value(out: &mut Vec<u8>, how: How, v: ValueRef<'_>) -> Result<()> {
    match (how, v) {
        (_, ValueRef::Null) => out.extend_from_slice(b"null"),
        // written by the store as serde_json text, so already valid JSON
        (How::Json, ValueRef::Text(t)) => out.extend_from_slice(t),
        (How::Bool, ValueRef::Integer(n)) => {
            out.extend_from_slice(if n == 0 { b"false" } else { b"true" });
        }
        (_, ValueRef::Integer(n)) => serde_json::to_writer(&mut *out, &n)?, // itoa, not fmt
        (_, ValueRef::Real(f)) => match serde_json::Number::from_f64(f) {
            Some(num) => write!(out, "{num}")?,
            None => out.extend_from_slice(b"null"),
        },
        (_, ValueRef::Text(t)) => serde_json::to_writer(&mut *out, &String::from_utf8_lossy(t))?,
        (_, ValueRef::Blob(_)) => {
            return Err(StoreError::Internal("blob columns are not supported".into()));
        }
    }
    Ok(())
}
