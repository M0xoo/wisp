//! Entity kinds: how a decoded row (what the change feed and every client see, a JSON object) maps to
//! a table row (what SQLite holds). Owners declare their kinds; the store never guesses a table's shape.

use std::collections::HashMap;
use std::fmt::{self, Write as _};
use std::sync::{Arc, Mutex};

use rusqlite::types::{Value as Sql, ValueRef};
use serde_json::{Map, Number, Value};

use crate::error::{Result, StoreError, invalid};
pub use crate::row::Id;
pub(crate) use crate::row::{is_topic, text_of};

/// One decoded row: column → value (JSON columns parsed, bool columns as booleans).
pub type Row = Map<String, Value>;
/// A sync topic (`list`, `config`, `session:<id>`, `plugin:<id>:<name>`, …), as `@wisp/protocol` has it.
pub type Topic = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Col {
    Text,
    Int,
    Real,
    /// INTEGER 0/1 in the table, `true`/`false` in the row
    Bool,
}

/// An entity kind, declared once by its owner (usually as a `const`) and registered with
/// `Store::define_entity`. The table comes from the owner's migrations.
#[derive(Clone, Copy)]
pub struct EntityDef {
    /// the wire name (`session`, `turn`, `event`); unique per store
    pub kind: &'static str,
    /// owner-prefixed for plugins (`crew_member`)
    pub table: &'static str,
    /// the primary-key column; its value is the change row's `id`
    pub key: &'static str,
    /// every column the store reads and writes, in the order rows and diffs use
    pub columns: &'static [(&'static str, Col)],
    /// text columns that hold JSON
    pub json_columns: &'static [&'static str],
    /// for an event log: the column a batch of appends is grouped under (`session_id`), one change per group
    pub parent: Option<&'static str>,
    /// for an event log: the per-parent order column `window` pages by (`seq`)
    pub seq: Option<&'static str>,
    /// the topics a change to this row is published on; the first is the change row's `topic`
    pub topics: fn(&Row) -> Vec<Topic>,
}

impl fmt::Debug for EntityDef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EntityDef")
            .field("kind", &self.kind)
            .field("table", &self.table)
            .field("key", &self.key)
            .finish_non_exhaustive()
    }
}

fn ident(s: &str) -> bool {
    let mut b = s.bytes();
    b.next()
        .is_some_and(|c| c.is_ascii_lowercase() || c == b'_')
        && b.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
}

fn kind_name(s: &str) -> bool {
    let mut b = s.bytes();
    b.next().is_some_and(|c| c.is_ascii_lowercase())
        && b.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"._-".contains(&c))
}

/// The three statements the writer builds per column set.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum Shape {
    Insert,
    Upsert,
    /// `UPDATE … SET <mask cols> WHERE key = ?`
    Update,
}

/// How a column decodes; an array indexed by column position, since decode is hot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum How {
    Plain,
    Json,
    Bool,
}

/// The compiled form of an `EntityDef`: column positions and the SQL made once per kind.
pub(crate) struct Kind {
    pub def: EntityDef,
    pub how: Vec<How>,
    pub key_pos: usize,
    pub parent_pos: Option<usize>,
    pub select_list: String,
    pub get_sql: String,
    pub del_sql: String,
    /// INSERT/UPSERT/UPDATE … RETURNING per set of present columns (a bit mask)
    sql_cache: Mutex<HashMap<(Shape, u64), Arc<str>>>,
}

impl fmt::Debug for Kind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Kind")
            .field("kind", &self.def.kind)
            .finish_non_exhaustive()
    }
}

impl Kind {
    pub fn compile(def: EntityDef) -> Result<Self> {
        let k = def.kind;
        if !kind_name(k) {
            return Err(invalid(format!("bad entity kind: {k}")));
        }
        if !ident(def.table) {
            return Err(invalid(format!("{k}: bad table name {}", def.table)));
        }
        if def.columns.is_empty() || def.columns.len() > 64 {
            return Err(invalid(format!("{k}: an entity has 1 to 64 columns")));
        }
        let mut how = Vec::with_capacity(def.columns.len());
        for (i, (c, t)) in def.columns.iter().enumerate() {
            if !ident(c) || def.columns[..i].iter().any(|(d, _)| d == c) {
                return Err(invalid(format!("{k}: bad or repeated column name {c}")));
            }
            let json = def.json_columns.contains(c);
            if json && *t != Col::Text {
                return Err(invalid(format!("{k}.{c}: a json column must be text")));
            }
            how.push(if json {
                How::Json
            } else if *t == Col::Bool {
                How::Bool
            } else {
                How::Plain
            });
        }
        let pos = |c: &str| def.columns.iter().position(|(d, _)| *d == c);
        let key_pos =
            pos(def.key).ok_or_else(|| invalid(format!("{k}: key {} is not a column", def.key)))?;
        for c in def.json_columns {
            pos(c).ok_or_else(|| invalid(format!("{k}: json column {c} is not a column")))?;
        }
        let parent_pos = match def.parent {
            Some(p) => {
                Some(pos(p).ok_or_else(|| invalid(format!("{k}: parent {p} is not a column")))?)
            }
            None => None,
        };
        if let Some(s) = def.seq {
            pos(s).ok_or_else(|| invalid(format!("{k}: seq {s} is not a column")))?;
        }
        let select_list = def
            .columns
            .iter()
            .map(|(c, _)| format!("\"{c}\""))
            .collect::<Vec<_>>()
            .join(", ");
        let get_sql = format!(
            "SELECT {select_list} FROM \"{}\" WHERE \"{}\" = ?",
            def.table, def.key
        );
        let del_sql = format!("DELETE FROM \"{}\" WHERE \"{}\" = ?", def.table, def.key);
        Ok(Self {
            def,
            how,
            key_pos,
            parent_pos,
            select_list,
            get_sql,
            del_sql,
            sql_cache: Mutex::new(HashMap::new()),
        })
    }

    pub fn name(&self) -> &'static str {
        self.def.kind
    }

    pub fn col(&self, name: &str) -> Result<usize> {
        self.def
            .columns
            .iter()
            .position(|(c, _)| *c == name)
            .ok_or_else(|| invalid(format!("{}: unknown column {name}", self.def.kind)))
    }

    pub fn key_param(&self, id: &Id) -> Sql {
        match (id, self.def.columns[self.key_pos].1) {
            (Id::Text(s), Col::Int) => s
                .parse::<i64>()
                .map_or_else(|_| Sql::Text(s.clone()), Sql::Integer),
            (Id::Text(s), _) => Sql::Text(s.clone()),
            (Id::Int(n), Col::Text) => Sql::Text(n.to_string()),
            (Id::Int(n), _) => Sql::Integer(*n),
        }
    }

    /// The change row's `id` for a decoded row.
    pub fn id_of(&self, row: &Row) -> Result<String> {
        match row.get(self.def.key) {
            None | Some(Value::Null) => Err(invalid(format!(
                "{}: row has no {}",
                self.def.kind, self.def.key
            ))),
            Some(v) => Ok(text_of(v)),
        }
    }

    /// Columns present in `row` (a mask) and their bound values, in declared order. Unknown columns fail.
    pub fn encode(&self, row: &Row) -> Result<(u64, Vec<Sql>)> {
        if let Some(bad) = row.keys().find(|c| self.col(c).is_err()) {
            return Err(invalid(format!("{}: unknown column {bad}", self.def.kind)));
        }
        let mut mask = 0u64;
        let mut vals = Vec::with_capacity(row.len());
        for (i, (c, _)) in self.def.columns.iter().enumerate() {
            if let Some(v) = row.get(*c) {
                mask |= 1 << i;
                vals.push(self.encode_value(i, v)?);
            }
        }
        Ok((mask, vals))
    }

    pub fn encode_value(&self, i: usize, v: &Value) -> Result<Sql> {
        let (name, col) = self.def.columns[i];
        let bad = |want: &str| {
            invalid(format!(
                "{}.{name}: expected {want}, got {v}",
                self.def.kind
            ))
        };
        Ok(match (self.how[i], col, v) {
            (_, _, Value::Null) => Sql::Null,
            (How::Json, _, v) => Sql::Text(serde_json::to_string(v)?),
            (How::Bool, _, Value::Bool(b)) => Sql::Integer(i64::from(*b)),
            (How::Bool, ..) => return Err(bad("a boolean")),
            (_, Col::Text, Value::String(s)) => Sql::Text(s.clone()),
            (_, Col::Int, Value::Number(n)) => {
                Sql::Integer(int_of(n).ok_or_else(|| bad("an integer"))?)
            }
            (_, Col::Real, Value::Number(n)) => {
                Sql::Real(n.as_f64().ok_or_else(|| bad("a number"))?)
            }
            (_, Col::Text, _) => return Err(bad("a string")),
            _ => return Err(bad("a number")),
        })
    }

    /// One stored value as clients see it.
    pub fn decode_value(&self, i: usize, v: ValueRef<'_>) -> Result<Value> {
        Ok(match (self.how[i], v) {
            (_, ValueRef::Null) => Value::Null,
            (How::Json, ValueRef::Text(t)) => serde_json::from_slice(t)?,
            (How::Bool, ValueRef::Integer(n)) => Value::Bool(n != 0),
            (_, ValueRef::Integer(n)) => Value::from(n),
            (_, ValueRef::Real(f)) => Number::from_f64(f).map_or(Value::Null, Value::Number),
            (_, ValueRef::Text(t)) => Value::String(String::from_utf8_lossy(t).into_owned()),
            (_, ValueRef::Blob(_)) => {
                return Err(StoreError::Internal(format!(
                    "{}: blob columns are not supported",
                    self.def.kind
                )));
            }
        })
    }

    /// Decodes a statement row whose columns are `cols` (positions in this kind), in that order.
    pub fn decode_row(&self, r: &rusqlite::Row<'_>, cols: &[usize]) -> Result<Row> {
        let mut out = Row::new();
        for (at, &i) in cols.iter().enumerate() {
            out.insert(
                self.def.columns[i].0.to_owned(),
                self.decode_value(i, r.get_ref(at)?)?,
            );
        }
        Ok(out)
    }

    pub fn all_cols(&self) -> Vec<usize> {
        (0..self.def.columns.len()).collect()
    }

    /// The statement for `shape` over the columns in `mask`, built once and cached; every one ends in
    /// `RETURNING` every column, so the writer sees exactly what the table now holds.
    pub fn sql(&self, shape: Shape, mask: u64) -> Arc<str> {
        let mut cache = self
            .sql_cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        cache
            .entry((shape, mask))
            .or_insert_with(|| Arc::from(self.build(shape, mask)))
            .clone()
    }

    fn build(&self, shape: Shape, mask: u64) -> String {
        let (table, key) = (self.def.table, self.def.key);
        let present: Vec<&str> = self
            .def
            .columns
            .iter()
            .enumerate()
            .filter(|(i, _)| mask & (1 << i) != 0)
            .map(|(_, (c, _))| *c)
            .collect();
        let set = |cols: &[&str]| {
            cols.iter()
                .map(|c| format!("\"{c}\" = excluded.\"{c}\""))
                .collect::<Vec<_>>()
                .join(", ")
        };
        let mut sql = match shape {
            Shape::Update => format!(
                "UPDATE \"{table}\" SET {} WHERE \"{key}\" = ?",
                present
                    .iter()
                    .map(|c| format!("\"{c}\" = ?"))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            Shape::Insert | Shape::Upsert => {
                let cols = present
                    .iter()
                    .map(|c| format!("\"{c}\""))
                    .collect::<Vec<_>>()
                    .join(", ");
                format!(
                    "INSERT INTO \"{table}\" ({cols}) VALUES ({})",
                    vec!["?"; present.len()].join(", ")
                )
            }
        };
        if shape == Shape::Upsert {
            let others: Vec<&str> = present.iter().copied().filter(|c| *c != key).collect();
            let set = if others.is_empty() {
                set(&[key])
            } else {
                set(&others)
            };
            let _ = write!(sql, " ON CONFLICT (\"{key}\") DO UPDATE SET {set}");
        }
        let _ = write!(sql, " RETURNING {}", self.select_list);
        sql
    }

    /// Decodes a `RETURNING` row of every column, reusing the JSON values the caller gave instead of
    /// parsing what was just serialised (event bodies are the hot path).
    pub fn decode_returning(&self, r: &rusqlite::Row<'_>, given: &Row) -> Result<Row> {
        let mut out = Row::new();
        for (i, (c, _)) in self.def.columns.iter().enumerate() {
            let v = match (self.how[i], given.get(*c)) {
                (How::Json, Some(v)) => v.clone(),
                _ => self.decode_value(i, r.get_ref(i)?)?,
            };
            out.insert((*c).to_owned(), v);
        }
        Ok(out)
    }

    /// The `Id` a row's key value binds as.
    pub fn id_value(&self, row: &Row) -> Result<Id> {
        match row.get(self.def.key) {
            Some(Value::Number(n)) => n
                .as_i64()
                .map(Id::Int)
                .ok_or_else(|| invalid(format!("{}: bad key {n}", self.def.kind))),
            Some(Value::String(s)) => Ok(Id::Text(s.clone())),
            _ => Err(invalid(format!(
                "{}: row has no {}",
                self.def.kind, self.def.key
            ))),
        }
    }
}

/// JSON numbers that are whole (`3`, `3.0`) bind as integers; JavaScript clients send both.
fn int_of(n: &Number) -> Option<i64> {
    #[allow(clippy::cast_possible_truncation, clippy::float_cmp)] // checked: integral and in range
    n.as_i64().or_else(|| {
        n.as_f64()
            .filter(|f| f.fract() == 0.0 && f.abs() < 9.0e15)
            .map(|f| f as i64)
    })
}
