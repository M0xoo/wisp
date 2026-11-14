//! A task's usage on its list row (v1 #785, TRY-16): `tokens`, `context`, `plan`, `planOn` and `agents` (its own; `agents`:
//! the harness's own subagents in its turns, by type), and on a
//! lead `subUsage` (its wisp subagents) and `usage` (the two summed: what the task's details line says).
//!
//! Each task's turns are folded once per turn (wisp-runtime-core `task_usage`), kept here per task, and refolded on a
//! write: a task's first write after a start reads its turns once, later ones read none. A subagent whose numbers
//! moved refreshes its lead's row (off its own lock, so a lead waiting on it can't deadlock).

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, PoisonError};

use serde_json::{Value, json};
use wisp_runtime_api::SessionId;
use wisp_runtime_api::model::{Session, Summary, Turn};
use wisp_runtime_core::task_usage::{Own, SubUsage, TurnUsage, own_of, plan_key, sub_usage, turn_usage, with_subs};

use crate::error::Result;
use crate::runtime::Runtime;

/// Each task's turns' parts, by index; filled on a task's first write after a start.
#[derive(Debug, Default)]
pub(crate) struct UsageCache(Mutex<HashMap<String, BTreeMap<u32, TurnUsage>>>);

impl UsageCache {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, BTreeMap<u32, TurnUsage>>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
    pub(crate) fn forget(&self, id: &str) {
        self.lock().remove(id);
    }
    /// Every task's parts: an import rewrote turns behind `persist`.
    pub(crate) fn clear(&self) {
        self.lock().clear();
    }
}

const FIELDS: [&str; 7] = ["tokens", "context", "plan", "planOn", "agents", "subUsage", "usage"];

/// A row's own numbers, as `fields` put them.
pub(crate) fn own_of_row(r: &Summary) -> Own {
    let mut v = serde_json::Map::new();
    for k in ["tokens", "context", "plan", "planOn"] {
        if let Some(x) = r.fields.get(k) {
            v.insert(k.to_owned(), x.clone());
        }
    }
    v.entry("tokens").or_insert(json!(0));
    serde_json::from_value(Value::Object(v)).unwrap_or_default()
}

pub(crate) fn put(out: &mut BTreeMap<String, Value>, own: &Own, subs: &[SubUsage]) {
    for k in FIELDS {
        out.remove(k);
    }
    if own.tokens > 0 {
        out.insert("tokens".into(), own.tokens.into());
    }
    if let Ok(Value::Object(m)) = serde_json::to_value(own) {
        for k in ["context", "plan", "planOn", "agents"] {
            if let Some(x) = m.get(k) {
                out.insert(k.into(), x.clone());
            }
        }
    }
    if !subs.is_empty() {
        out.insert("subUsage".into(), serde_json::to_value(subs).unwrap_or_default());
    }
    let total = with_subs(own, subs);
    if total.tokens > 0 || !total.plan.is_empty() {
        out.insert("usage".into(), serde_json::to_value(total).unwrap_or_default());
    }
}

impl Runtime {
    /// Puts the task's usage on its row; `turns`: the ones this write saves.
    pub(crate) async fn usage_into(&self, s: &Session, turns: &[Turn], row: &mut Summary) -> Result<()> {
        let id = s.id.as_str();
        let known = self.usage.lock().contains_key(id);
        let all = if known { Vec::new() } else { self.repo.turns(id, None, None).await? };
        let own = {
            let mut cache = self.usage.lock();
            let parts = cache.entry(id.to_owned()).or_default();
            for t in all.iter().chain(turns) {
                parts.insert(t.idx, turn_usage(t));
            }
            own_of(&parts.values().cloned().collect::<Vec<_>>())
        };
        let subs = if s.parent_id.is_some() { Vec::new() } else { self.subs_of(s, &own) };
        put(&mut row.fields, &own, &subs);
        Ok(())
    }

    /// A lead's wisp subagents, from their rows: the members it delegated to (`ext["wisp.runtime"].children`: name →
    /// task, v1 `s.children`), looked up by id, never a scan of the list. A sandbox member (`machine|task`) runs
    /// elsewhere: its numbers aren't here.
    fn subs_of(&self, s: &Session, own: &Own) -> Vec<SubUsage> {
        let on = plan_key(&s.agent, s.account.as_deref());
        let Some(children) = s.ext_of("wisp.runtime").get("children").and_then(Value::as_object) else { return Vec::new() };
        let list = self.lock_list();
        let mut seen = std::collections::HashSet::new();
        children
            .iter()
            .filter_map(|(name, id)| Some((name, id.as_str()?)))
            .filter(|(_, id)| seen.insert(*id))
            .filter_map(|(name, id)| {
                let r = list.get(id).filter(|r| r.parent_id.as_ref() == Some(&s.id))?;
                sub_usage(own, &on, (r.id.as_str(), name, &r.title, &r.agent), &own_of_row(r))
            })
            .collect()
    }

    /// A lead's row says its subagents' numbers again (off the subagent's lock: a lead waiting on it can't deadlock).
    pub(crate) fn refresh_lead(self: &Arc<Self>, lead: SessionId) {
        let rt = Arc::clone(self);
        self.host.spawn(Box::pin(async move {
            if let Err(e) = rt.edit(lead.as_str(), |_| Ok(())).await {
                tracing::debug!(error = %e, "a lead's usage wasn't refreshed");
            }
        }));
    }

    /// After a subagent's row was written: its lead's row says its numbers again when they moved.
    pub(crate) fn lead_follows(self: &Arc<Self>, before: Option<&Summary>, after: &Summary) {
        let Some(lead) = after.parent_id.clone() else { return };
        if before.is_some_and(|b| own_of_row(b) == own_of_row(after)) {
            return;
        }
        self.refresh_lead(lead);
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn a_rows_own_numbers_read_back_as_they_were_put_v1_785() {
        let own = Own {
            tokens: 1050,
            plan: BTreeMap::from([("seven_day".to_owned(), 0.04)]),
            plan_on: ["claude default".to_owned()].into(),
            ..Own::default()
        };
        let mut row = Summary::default();
        put(&mut row.fields, &own, &[]);
        assert_eq!(own_of_row(&row), own);
        assert_eq!(row.fields["usage"], json!({ "tokens": 1050, "plan": { "seven_day": 0.04 } }));
        // nothing measured: no fields, and stale ones go
        put(&mut row.fields, &Own::default(), &[]);
        assert!(FIELDS.iter().all(|k| !row.fields.contains_key(*k)));
    }
}
