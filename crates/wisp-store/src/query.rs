//! Queries over one entity kind: a projection, conditions, an order and a page. Column names are checked
//! against the kind and values are always bound, so nothing a client sends becomes SQL text.

use rusqlite::types::Value as Sql;
use serde_json::Value;

use crate::entity::Kind;
use crate::error::{Result, invalid};

#[derive(Debug, Clone, PartialEq)]
pub enum Cond {
    Eq(Value),
    Ne(Value),
    In(Vec<Value>),
    IsNull,
    NotNull,
    Gt(Value),
    Gte(Value),
    Lt(Value),
    Lte(Value),
    /// SQL LIKE (`%`, `_`), on a text column
    Like(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dir {
    Asc,
    Desc,
}

/// `Query::new().select(&["id", "title"]).eq("archived", false).desc("updated_at").limit(200)`
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Query {
    /// a projection: only these columns are read and decoded (a list needs a few, not all)
    pub select: Vec<String>,
    pub conds: Vec<(String, Cond)>,
    pub order: Vec<(String, Dir)>,
    pub limit: Option<u64>,
    pub offset: Option<u64>,
}

impl Query {
    pub fn new() -> Self {
        Self::default()
    }
    #[must_use]
    pub fn select(mut self, cols: &[&str]) -> Self {
        self.select = cols.iter().map(|c| (*c).to_owned()).collect();
        self
    }
    #[must_use]
    pub fn cond(mut self, col: &str, c: Cond) -> Self {
        self.conds.push((col.to_owned(), c));
        self
    }
    /// `col = v`; a `null` value means `IS NULL`
    #[must_use]
    pub fn eq(self, col: &str, v: impl Into<Value>) -> Self {
        let v = v.into();
        self.cond(col, if v.is_null() { Cond::IsNull } else { Cond::Eq(v) })
    }
    #[must_use]
    pub fn any_of(self, col: &str, vs: Vec<Value>) -> Self {
        self.cond(col, Cond::In(vs))
    }
    #[must_use]
    pub fn asc(mut self, col: &str) -> Self {
        self.order.push((col.to_owned(), Dir::Asc));
        self
    }
    #[must_use]
    pub fn desc(mut self, col: &str) -> Self {
        self.order.push((col.to_owned(), Dir::Desc));
        self
    }
    #[must_use]
    pub fn limit(mut self, n: u64) -> Self {
        self.limit = Some(n);
        self
    }
    #[must_use]
    pub fn offset(mut self, n: u64) -> Self {
        self.offset = Some(n);
        self
    }
}

/// The compiled query: SQL, bound values, and which kind columns the result holds, in order.
pub(crate) struct Compiled {
    pub sql: String,
    pub params: Vec<Sql>,
    pub cols: Vec<usize>,
}

pub(crate) fn compile(k: &Kind, q: &Query, count: bool) -> Result<Compiled> {
    let cols = if q.select.is_empty() { k.all_cols() } else { q.select.iter().map(|c| k.col(c)).collect::<Result<_>>()? };
    let list = if q.select.is_empty() {
        k.select_list.clone()
    } else {
        cols.iter().map(|&i| format!("\"{}\"", k.def.columns[i].0)).collect::<Vec<_>>().join(", ")
    };
    let mut sql =
        if count { format!("SELECT count(*) FROM \"{}\"", k.def.table) } else { format!("SELECT {list} FROM \"{}\"", k.def.table) };
    let mut params = Vec::new();
    let mut wh = Vec::with_capacity(q.conds.len());
    for (col, c) in &q.conds {
        wh.push(condition(k, k.col(col)?, c, &mut params)?);
    }
    if !wh.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&wh.join(" AND "));
    }
    if !count && !q.order.is_empty() {
        let order = q
            .order
            .iter()
            .map(|(c, d)| Ok(format!("\"{}\" {}", k.def.columns[k.col(c)?].0, if *d == Dir::Desc { "DESC" } else { "ASC" })))
            .collect::<Result<Vec<_>>>()?;
        sql.push_str(" ORDER BY ");
        sql.push_str(&order.join(", "));
    }
    if !count {
        page(&mut sql, &mut params, q)?;
    }
    Ok(Compiled { sql, params, cols })
}

fn page(sql: &mut String, params: &mut Vec<Sql>, q: &Query) -> Result<()> {
    let n = |v: u64| i64::try_from(v).map(Sql::Integer).map_err(|_| invalid("limit and offset must fit in 63 bits"));
    match (q.limit, q.offset) {
        (Some(l), off) => {
            sql.push_str(" LIMIT ?");
            params.push(n(l)?);
            if let Some(o) = off {
                sql.push_str(" OFFSET ?");
                params.push(n(o)?);
            }
            Ok(())
        }
        (None, Some(_)) => Err(invalid("offset needs a limit")),
        (None, None) => Ok(()),
    }
}

fn condition(k: &Kind, i: usize, c: &Cond, params: &mut Vec<Sql>) -> Result<String> {
    let name = k.def.columns[i].0;
    let mut bind = |v: &Value| -> Result<&'static str> {
        params.push(k.encode_value(i, v)?);
        Ok("?")
    };
    let cmp = |op: &str, mark: &str| format!("\"{name}\" {op} {mark}");
    Ok(match c {
        Cond::Eq(Value::Null) | Cond::IsNull => format!("\"{name}\" IS NULL"),
        Cond::Ne(Value::Null) | Cond::NotNull => format!("\"{name}\" IS NOT NULL"),
        Cond::Eq(v) => cmp("=", bind(v)?),
        Cond::Ne(v) => cmp("!=", bind(v)?),
        Cond::Gt(v) => cmp(">", bind(v)?),
        Cond::Gte(v) => cmp(">=", bind(v)?),
        Cond::Lt(v) => cmp("<", bind(v)?),
        Cond::Lte(v) => cmp("<=", bind(v)?),
        Cond::Like(s) => {
            params.push(Sql::Text(s.clone()));
            cmp("LIKE", "?")
        }
        Cond::In(vs) if vs.is_empty() => "0".to_owned(),
        Cond::In(vs) => {
            let marks = vs.iter().map(&mut bind).collect::<Result<Vec<_>>>()?.join(", ");
            format!("\"{name}\" IN ({marks})")
        }
    })
}
