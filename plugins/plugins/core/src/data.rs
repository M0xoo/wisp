//! A spell's data sources, fetched by wisp on its behalf (spell code never fetches anything), as v1
//! server/spells-data.js did: `{ wisp: '/sessions' }` is a read-only GET of wisp's own API (an
//! allowlist), `{ gh: [...] }` a read-only GitHub CLI command in the home folder or the task's. Each
//! answer is cached for the source's `refresh` seconds. This plans and caches; the host fetches.
use std::collections::VecDeque;

use serde_json::Value;

use crate::rules::{fill_template, gh_problem, wisp_path_problem};

pub const MAX_BYTES: usize = 1024 * 1024;
pub const TIMEOUT_MS: u64 = 20_000;
const CACHE_MAX: usize = 500;

/// The task a card shows: its folder, and its summary, whose fields fill `{templates}`.
#[derive(Debug, Clone, Default)]
pub struct DataTask {
    pub id: String,
    pub cwd: String,
    pub summary: Value,
}

/// What to fetch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Fetch {
    /// a GET of wisp's own API, without the /api prefix
    Wisp(String),
    Gh { args: Vec<String>, cwd: String },
}

/// The fetch for a source, and its cache key; Err: the source isn't allowed.
pub fn plan(spell: &str, name: &str, source: &Value, task: Option<&DataTask>, home: &str) -> Result<(Fetch, String), String> {
    let empty = Value::Null;
    let summary = task.map_or(&empty, |t| &t.summary);
    let per_task_cwd = source.get("cwd").and_then(Value::as_str) == Some("task");
    let templated = |s: &str| s.contains('{');
    let gh: Option<Vec<String>> = source.get("gh").and_then(Value::as_array).map(|a| a.iter().map(|x| fill_template(x.as_str().unwrap_or(""), summary)).collect());
    let wisp = source.get("wisp").and_then(Value::as_str);
    let per_task = task.is_some() && (per_task_cwd || source.get("gh").and_then(Value::as_array).is_some_and(|a| a.iter().any(|x| x.as_str().is_some_and(templated))) || wisp.is_some_and(templated));
    let key = format!("{spell}:{name}:{}", if per_task { task.map_or("", |t| t.id.as_str()) } else { "" });
    let fetch = if let Some(w) = wisp {
        let path = fill_template(w, summary);
        if let Some(e) = wisp_path_problem(Some(&Value::from(path.as_str()))) {
            return Err(e);
        }
        Fetch::Wisp(path.strip_prefix("/api").filter(|r| r.starts_with('/')).unwrap_or(&path).to_owned())
    } else {
        let args = gh.unwrap_or_default();
        if let Some(e) = gh_problem(Some(&Value::from(args.clone()))) {
            return Err(e);
        }
        let cwd = match task {
            Some(t) if per_task_cwd => t.cwd.clone(),
            _ => home.to_owned(),
        };
        Fetch::Gh { args, cwd }
    };
    Ok((fetch, key))
}

/// A gh command's answer: JSON when it is, else its text.
pub fn gh_value(stdout: &str) -> Value {
    serde_json::from_str(stdout).unwrap_or_else(|_| Value::from(stdout))
}

/// Answers by key, each for its source's `refresh`; the oldest goes past CACHE_MAX.
#[derive(Debug, Default)]
pub struct Cache {
    items: VecDeque<(String, i64, Value)>,
}

impl Cache {
    pub fn get(&self, key: &str, now: i64, refresh_s: f64) -> Option<&Value> {
        // refresh is at most 3600 s, so the product fits easily
        #[allow(clippy::cast_possible_truncation)]
        let ttl = (refresh_s * 1000.0) as i64;
        self.items.iter().find(|(k, at, _)| k == key && now - at < ttl).map(|(_, _, v)| v)
    }

    pub fn put(&mut self, key: String, now: i64, value: Value) {
        self.items.retain(|(k, _, _)| *k != key);
        self.items.push_back((key, now, value));
        if self.items.len() > CACHE_MAX {
            self.items.pop_front();
        }
    }

    pub fn clear(&mut self) {
        self.items.clear();
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }
}

/// A source's refresh, in seconds (60 when unset).
pub fn refresh_of(source: &Value) -> f64 {
    source.get("refresh").and_then(Value::as_f64).filter(|r| *r > 0.0).unwrap_or(60.0)
}
