//! wisp.ship's slot on a task (`ext["wisp.ship"]`): what it ships and follows, kept on the session so a
//! restart picks it up again, the fields it adds to the task's list row (`pr`, `also`, `prs`, `toShip`,
//! `shipping`, `conflictFix`: the shapes Ship it's UI reads), and how a session's facts (its worktree,
//! archived, a subagent's) start or update the task it tracks. Pure.

use std::collections::BTreeMap;

use serde_json::{Value, json};
use wisp_ship_api::{ShipRepo, ShipTask, Worktree};

/// What ship reads of a session: its folder, its worktree (`ext["wisp.worktrees"]`), whether it's
/// archived, and whether it's a subagent's (its lead ships).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Facts {
    pub session: String,
    pub cwd: String,
    pub worktree: Option<Worktree>,
    pub archived: bool,
    pub child: bool,
    pub updated_at: i64,
}

/// The worktree slot as ship reads it: one with a path (a task in place has none).
pub fn worktree_of(slot: &Value) -> Option<Worktree> {
    serde_json::from_value::<Worktree>(slot.clone()).ok().filter(|w| !w.path.is_empty() && !w.branch.is_empty())
}

/// The repo's name: the main checkout's last folder (v1 `projectName(root)`).
pub fn repo_name(w: &Worktree) -> String {
    let root = if w.root.is_empty() { &w.path } else { &w.root };
    root.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().unwrap_or_default().to_owned()
}

/// The slot to write: the task as ship keeps it, and its own PR at the top (`pr`, what review reads).
pub fn ext_of(task: &ShipTask) -> Value {
    let mut v = serde_json::to_value(task).unwrap_or(Value::Null);
    if let Some(o) = v.as_object_mut() {
        o.remove("session");
        o.insert("pr".into(), task.pr().map_or(Value::Null, |p| json!(p)));
    }
    v
}

/// Two slots say the same but for when GitHub was last asked (`checkedAt`): a PR poll that found nothing
/// new isn't written (the poll's clock lives in memory; after a restart it just asks sooner).
pub fn same_news(a: &Value, b: &Value) -> bool {
    fn strip(v: &Value) -> Value {
        match v {
            Value::Object(o) => {
                Value::Object(o.iter().filter(|(k, _)| k.as_str() != "checkedAt").map(|(k, v)| (k.clone(), strip(v))).collect())
            }
            Value::Array(a) => Value::Array(a.iter().map(strip).collect()),
            other => other.clone(),
        }
    }
    strip(a) == strip(b)
}

/// The slot's own PR is open with a head the slot before didn't have: time to ask for a review.
pub fn new_head(was: Option<&Value>, now: &Value) -> bool {
    let head =
        |v: &Value| (v["pr"]["state"] == "OPEN").then(|| v["pr"]["head"].as_str().unwrap_or_default().to_owned()).filter(|h| !h.is_empty());
    head(now).is_some_and(|h| was.and_then(head).as_deref() != Some(h.as_str()))
}

/// The task kept in a session's slot (after a restart), or None when the slot is empty or unreadable.
pub fn restore(session: &str, slot: &Value) -> Option<ShipTask> {
    let mut o = slot.as_object()?.clone();
    o.remove("pr");
    o.insert("session".into(), Value::String(session.to_owned()));
    serde_json::from_value(Value::Object(o)).ok()
}

/// The task ship follows after a session's facts, given what it had (`was`, else the slot's). None:
/// nothing to follow (no worktree and no PR attached). A worktree that changed (moved, brought back on
/// a new branch) replaces the first repo's and keeps its PR only on the same branch.
pub fn sync(was: Option<ShipTask>, f: &Facts) -> Option<ShipTask> {
    let mut t = match was {
        Some(t) => t,
        None if f.worktree.is_some() => ShipTask { session: f.session.clone(), ..ShipTask::default() },
        None => return None,
    };
    t.session.clone_from(&f.session);
    t.cwd.clone_from(&f.cwd);
    t.archived = f.archived;
    t.child = f.child;
    t.updated_at = t.updated_at.max(f.updated_at);
    if let Some(w) = &f.worktree {
        match t.repos.first_mut() {
            Some(r) if r.worktree == *w => {}
            Some(r) => {
                if r.worktree.branch != w.branch {
                    r.pr = None;
                }
                r.worktree = w.clone();
                r.name = repo_name(w);
            }
            None => t.repos.push(ShipRepo { name: repo_name(w), worktree: w.clone(), pr: None }),
        }
    }
    (!t.repos.is_empty() || !t.prs.is_empty()).then_some(t)
}

/// The row's fields from the slot (`runtime.summary@1`): only those with something to say.
pub fn row_fields(slot: &Value, out: &mut BTreeMap<String, Value>) {
    let Some(t) = restore("", slot) else { return };
    if let Some(pr) = t.pr() {
        out.insert("pr".into(), json!(pr));
    }
    let also: Vec<Value> = t
        .repos
        .iter()
        .skip(1)
        .map(|r| {
            let mut a = json!({ "project": r.name, "branch": r.worktree.branch });
            if let Some(pr) = &r.pr {
                a["pr"] = json!(pr);
            }
            a
        })
        .collect();
    if !also.is_empty() {
        out.insert("also".into(), Value::Array(also));
    }
    if !t.prs.is_empty() {
        out.insert("prs".into(), json!(t.prs));
    }
    if let Some(ts) = t.to_ship {
        out.insert("toShip".into(), json!(ts));
    }
    if let Some(s) = &t.shipping {
        out.insert("shipping".into(), json!(s));
    }
    if let Some(c) = &t.conflict_fix {
        out.insert("conflictFix".into(), json!(c));
    }
}

#[cfg(test)]
mod tests;
