//! `runtime.summary@1`: what the list row says of a task's worktree, from its `ext["wisp.worktrees"]` slot.
//! `branch` (the shell's task view and Ship it read it: no branch, no Ship it), `foreign` when it was brought
//! in from another tool (never wisp's to remove; Keep worktree isn't offered), and `project`, the last folder
//! of the repo it was made from (the task's cwd is the worktree's own folder, whose name says nothing).

use std::collections::BTreeMap;

use serde_json::{Value, json};
use wisp_runtime_api::model::{Session, Turn};
use wisp_worktrees_api::EXT;

use crate::runtime_port::project_of;

#[derive(Debug)]
pub struct Summary;

/// The row's fields from the slot; nothing when the task has no worktree.
pub fn fields_of(slot: Option<&Value>, out: &mut BTreeMap<String, Value>) {
    let Some(slot) = slot.filter(|s| s.is_object()) else { return };
    let text = |k: &str| slot.get(k).and_then(Value::as_str).filter(|s| !s.is_empty());
    if text("path").is_none() {
        return;
    }
    if let Some(b) = text("branch") {
        out.insert("branch".into(), json!(b));
    }
    if slot.get("foreign").is_some_and(|f| f.as_bool() == Some(true) || f.as_str().is_some_and(|s| !s.is_empty())) {
        out.insert("foreign".into(), json!(true));
    }
    if let Some(p) = text("root").map(project_of).filter(|p| !p.is_empty()) {
        out.insert("project".into(), json!(p));
    }
}

impl wisp_runtime_api::points::SummaryField for Summary {
    fn plugin(&self) -> &str {
        EXT
    }
    fn fields(&self, session: &Session, _last: Option<&Turn>, out: &mut BTreeMap<String, Value>) {
        fields_of(session.ext.get(EXT), out);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn of(slot: &Value) -> BTreeMap<String, Value> {
        let mut out = BTreeMap::new();
        fields_of(Some(slot), &mut out);
        out
    }

    /// The row says the worktree's branch and project; a brought-in one is foreign; no worktree says nothing.
    #[test]
    fn the_rows_worktree_fields_are_its_branch_project_and_foreign() {
        let own = of(&json!({ "path": "/h/.wisp/worktrees/app-fix", "branch": "wisp/fix", "root": "/src/app/", "foreign": false }));
        assert_eq!(own.get("branch"), Some(&json!("wisp/fix")));
        assert_eq!(own.get("project"), Some(&json!("app")));
        assert!(!own.contains_key("foreign"));
        let brought = of(&json!({ "path": "/u/conductor/workspaces/app/oslo", "branch": "oslo", "root": "/src/app", "foreign": true }));
        assert_eq!(brought.get("foreign"), Some(&json!(true)));
        assert_eq!(of(&json!({ "path": "/c/x", "branch": "x", "foreign": "conductor" })).get("foreign"), Some(&json!(true)), "v1's mark");
        assert!(!of(&json!({ "path": "/c/x", "branch": "x" })).contains_key("project"), "no root: no project");
        assert!(of(&json!({ "kept": true })).is_empty(), "only Keep in the slot: no worktree");
        assert!(of(&Value::Null).is_empty());
        let mut none = BTreeMap::new();
        fields_of(None, &mut none);
        assert!(none.is_empty());
    }
}
