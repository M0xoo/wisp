//! Where an account's window went this period (v1 budget.js:684-752): the tasks that used most of it,
//! how much wisp traced to a task at all (the rest ran outside wisp, or before it measured), and how
//! much went to each kind of subagent.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use wisp_budget_api::Share;

use crate::receipt::{subagent_output, turn_output};
use crate::windows::same_period;
use crate::work::{RunLike, TurnLike, turn_plan};

/// A turn's part of a window's move, added to what it already has there (v1 `addShare`).
pub fn add_share(plan: &mut Vec<Share>, share: &Share) {
    if share.used.is_nan() || share.used <= 0.0 {
        return;
    }
    match plan.iter_mut().find(|x| x.agent == share.agent && x.account == share.account && x.window == share.window && same_period(x.resets_at, share.resets_at)) {
        Some(e) => e.used = (e.used + share.used).min(1.0),
        None => plan.push(Share { used: share.used.min(1.0), ..share.clone() }),
    }
}

/// A task's share of each kind of window, summed over its turns (v1 `planOf`); None when it has none.
pub fn plan_of(s: &RunLike) -> Option<BTreeMap<String, f64>> {
    let mut out: BTreeMap<String, f64> = BTreeMap::new();
    for t in &s.turns {
        for p in turn_plan(t) {
            *out.entry(p.window).or_insert(0.0) += p.used;
        }
    }
    (!out.is_empty()).then_some(out)
}

fn used_on(t: &TurnLike, agent: &str, account: &str, window: &str, resets_at: Option<i64>) -> f64 {
    turn_plan(t).iter().filter(|p| p.agent == agent && p.account == account && p.window == window && same_period(p.resets_at, resets_at)).map(|p| p.used).sum()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TaskUse {
    pub id: String,
    pub title: String,
    pub used: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Where {
    pub tasks: Vec<TaskUse>,
    pub more: usize,
    pub traced: f64,
}

/// The tasks that used most of this period of the window, a subagent's share on its lead (one with no
/// lead left counts on its own). None when nothing is traced.
pub fn where_it_went(sessions: &[RunLike], agent: &str, account: &str, window: &str, resets_at: Option<i64>, limit: usize) -> Option<Where> {
    let title = |id: &str| sessions.iter().find(|s| s.id.as_deref() == Some(id)).map(|s| s.title.clone().filter(|t| !t.is_empty()).unwrap_or_else(|| "Untitled".to_owned()));
    let mut by: Vec<TaskUse> = Vec::new();
    for s in sessions {
        let own = s.id.clone().unwrap_or_default();
        let id = s.parent_id.clone().filter(|p| title(p).is_some()).unwrap_or(own);
        let used: f64 = s.turns.iter().map(|t| used_on(t, agent, account, window, resets_at)).sum();
        if used.is_nan() || used <= 0.0 {
            continue;
        }
        match by.iter_mut().find(|x| x.id == id) {
            Some(e) => e.used += used,
            None => by.push(TaskUse { title: title(&id).unwrap_or_else(|| "Untitled".to_owned()), id, used }),
        }
    }
    if by.is_empty() {
        return None;
    }
    by.sort_by(|a, b| b.used.total_cmp(&a.used));
    let traced = by.iter().map(|x| x.used).sum();
    let more = by.len().saturating_sub(limit);
    by.truncate(limit);
    Some(Where { tasks: by, more, traced })
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SubagentUse {
    #[serde(rename = "type")]
    pub kind: String,
    pub calls: f64,
    pub model: String,
    pub output: f64,
    pub used: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instead: Option<String>,
}

/// Each subagent type's calls, output and share of the window, a turn's share split by the part of
/// the turn's output that type wrote. Top `limit` by share; None when no traced turn ran a subagent.
pub fn where_subagents(sessions: &[RunLike], agent: &str, account: &str, window: &str, resets_at: Option<i64>, limit: usize) -> Option<Vec<SubagentUse>> {
    let mut by: Vec<(SubagentUse, Vec<(String, f64)>)> = Vec::new();
    for t in sessions.iter().flat_map(|s| s.turns.iter()) {
        let st = t.stats();
        if st.subagents.is_empty() {
            continue;
        }
        let used = used_on(t, agent, account, window, resets_at);
        if used.is_nan() || used <= 0.0 {
            continue;
        }
        let total = turn_output(&st);
        for x in &st.subagents {
            let i = by.iter().position(|(e, _)| e.kind == x.kind).unwrap_or_else(|| {
                by.push((SubagentUse { kind: x.kind.clone(), calls: 0.0, model: String::new(), output: 0.0, used: 0.0, instead: None }, Vec::new()));
                by.len() - 1
            });
            let (e, models) = &mut by[i];
            let output = subagent_output(&st, x);
            e.calls += x.calls.unwrap_or(0.0);
            e.output += output;
            e.used += if total > 0.0 { used * output / total } else { 0.0 };
            if let Some(m) = x.model.as_ref().filter(|m| !m.is_empty()) {
                match models.iter_mut().find(|(n, _)| n == m) {
                    Some((_, w)) => *w += output + 1.0,
                    None => models.push((m.clone(), output + 1.0)),
                }
            }
            if x.instead.is_some() {
                e.instead.clone_from(&x.instead);
            }
        }
    }
    if by.is_empty() {
        return None;
    }
    let mut out: Vec<SubagentUse> = by
        .into_iter()
        .map(|(mut e, mut models)| {
            models.sort_by(|a, b| b.1.total_cmp(&a.1));
            e.model = models.first().map(|(m, _)| m.clone()).unwrap_or_default();
            e
        })
        .collect();
    out.sort_by(|a, b| b.used.total_cmp(&a.used).then(b.output.total_cmp(&a.output)));
    out.truncate(limit);
    Some(out)
}
