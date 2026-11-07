//! A run's own work, turn by turn (v1 web/js/compare-metrics.js workOf): the stored counters aren't
//! always each turn's. Claude's `costUsd` before `stats.totals` and Codex's tokens without it are the
//! conversation's running total, so a turn is the difference with the one before it. A copied turn (a
//! fork's first turns, a shared task's) ran elsewhere: it moves the counters, but isn't counted.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use wisp_budget_api::Share;

use crate::receipt::{StatsLike, Tokens, turn_tokens};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Kind {
    pub kind: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Edit {
    pub before: String,
    pub after: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Change {
    pub edits: Vec<Edit>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Block {
    #[serde(rename = "type")]
    pub kind: String,
    pub passed: Option<Value>,
    pub failed: Option<Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Presentation {
    pub blocks: Vec<Block>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ToolSet {
    pub hash: Option<String>,
    pub list: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Details {
    pub tools: Option<ToolSet>,
}

/// A turn as stored (v1 field names), for the pure readers here. Everything is optional.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TurnLike {
    pub id: Option<String>,
    pub agent: Option<String>,
    pub account: Option<String>,
    pub model: Option<String>,
    pub status: Option<String>,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub stats: Option<StatsLike>,
    pub by: Option<String>,
    pub forked: bool,
    pub shared: bool,
    pub plan: Option<Vec<Share>>,
    pub activity: Vec<Kind>,
    pub trimmed: Option<u32>,
    pub changes: Vec<Change>,
    pub presentation: Option<Presentation>,
    pub details: Option<Details>,
    /// v2: other plugins' slots; budget's shares are under `wisp.budget.plan`
    pub ext: Option<BTreeMap<String, Value>>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RunLike {
    pub id: Option<String>,
    pub title: Option<String>,
    pub agent: Option<String>,
    pub account: Option<String>,
    pub state: Option<String>,
    pub parent_id: Option<String>,
    pub created_at: Option<i64>,
    pub turns: Vec<TurnLike>,
}

impl TurnLike {
    pub fn status(&self) -> &str {
        self.status.as_deref().unwrap_or_default()
    }
    pub fn stats(&self) -> StatsLike {
        self.stats.clone().unwrap_or_default()
    }
}

/// A turn's shares: v1's `turn.plan`, or what wisp.budget keeps in the turn's ext slot.
pub fn turn_plan(t: &TurnLike) -> Vec<Share> {
    if let Some(p) = &t.plan {
        return p.clone();
    }
    let Some(plan) = t.ext.as_ref().and_then(|e| e.get("wisp.budget")).and_then(|m| m.get("plan")).and_then(Value::as_array) else { return Vec::new() };
    plan.iter().filter_map(|v| serde_json::from_value::<Share>(v.clone()).ok()).collect()
}

pub fn copied(t: &TurnLike) -> bool {
    t.forked || t.shared
}

/// The run's own turns (not copied ones), with their index in `turns`.
pub fn own(s: &RunLike) -> Vec<(usize, &TurnLike)> {
    s.turns.iter().enumerate().filter(|(_, t)| !copied(t)).collect()
}

/// Differences of totals leave float dust.
#[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]
pub fn tidy(x: f64) -> f64 {
    (x * 1e7).round() / 1e7
}

fn num(x: Option<f64>) -> Option<f64> {
    x.filter(|v| v.is_finite())
}

/// A Claude turn's own cost. `counter`: what it stood at after the turn before.
fn own_cost(agent: &str, st: &StatsLike, counter: &mut BTreeMap<String, f64>) -> Option<f64> {
    if agent != "claude" {
        return num(st.cost_usd);
    }
    if let Some(totals) = &st.totals {
        if let Some(total) = num(totals.cost_usd) {
            counter.insert(agent.to_owned(), total);
        }
        return num(st.cost_usd);
    }
    let now = num(st.cost_usd)?;
    let was = counter.get(agent).copied().unwrap_or(0.0);
    counter.insert(agent.to_owned(), now);
    Some(tidy(if now >= was { now - was } else { now })) // less than before: the counters started over
}

fn own_tokens(agent: &str, st: &StatsLike, counter: &mut BTreeMap<String, Tokens>) -> Tokens {
    let tokens = turn_tokens(st);
    if agent != "codex" {
        return tokens;
    }
    if let Some(totals) = &st.totals {
        counter.insert(agent.to_owned(), turn_tokens(totals));
        return tokens;
    }
    if tokens.read == 0.0 && tokens.output == 0.0 {
        return tokens; // never got to report: the counter stands
    }
    let was = counter.get(agent).copied().unwrap_or_default();
    counter.insert(agent.to_owned(), tokens);
    if tokens.read < was.read || tokens.output < was.output {
        return tokens;
    }
    Tokens { read: tokens.read - was.read, cached: (tokens.cached - was.cached).max(0.0), output: tokens.output - was.output }
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Work {
    pub cost: Option<f64>,
    pub tokens: Tokens,
}

/// Each turn's own work, by its index in `session.turns`. A copy or a baseline moves the counters,
/// so the turn after differences correctly, but isn't in it.
pub fn work_of(s: &RunLike) -> BTreeMap<usize, Work> {
    let mut out = BTreeMap::new();
    let (mut costs, mut tokens) = (BTreeMap::new(), BTreeMap::new());
    for (i, t) in s.turns.iter().enumerate() {
        let agent = t.agent.as_deref().filter(|a| !a.is_empty()).or(s.agent.as_deref()).unwrap_or_default();
        let st = t.stats();
        let w = Work { cost: own_cost(agent, &st, &mut costs), tokens: own_tokens(agent, &st, &mut tokens) };
        if !copied(t) && !st.baseline {
            out.insert(i, w);
        }
    }
    out
}

/// Runs oldest first (stable for equal times).
pub fn by_age<T: Clone>(list: &[T], created: impl Fn(&T) -> i64) -> Vec<T> {
    let mut v = list.to_vec();
    v.sort_by_key(|x| created(x));
    v
}

/// 0 → "A".
pub fn letter(i: usize) -> String {
    char::from_u32(65 + u32::try_from(i).unwrap_or(0)).map(String::from).unwrap_or_default()
}

/// "A", "A and B", "A, B and C".
pub fn listed(xs: &[String]) -> String {
    match xs {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}
