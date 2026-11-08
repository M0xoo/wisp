//! v1 edge case HTTP #3, enforced once for every plugin: an agent's token speaks for its own task
//! (and the tasks under it: its delegations) only. Every command declares the args that name a task
//! (`Command::TASK_ARGS`, a kernel-wide default that every plugin's `sessionId`/`session`/`parentId`
//! /`taskId` falls under) and whether it answers about every task (`Command::ALL_TASKS`). Routes name
//! a task with `:sid`, `:sessionId`, `:taskId`, or `:id` under `/sessions/`. The kernel checks them at
//! every command entry, nested ones included (the caller travels with the call, so wisp's MCP tools
//! are checked like a direct call), and before every route handler. Which task is under which comes
//! from whoever owns tasks (`TASKS`, provided by wisp.runtime); without it only the agent's own task
//! is allowed.

use serde_json::Value;

use crate::{BoxFuture, Caller, Code, Point, Result, WireError};

/// The arg keys that name a task, unless a command says otherwise.
pub const DEFAULT_TASK_ARGS: &[&str] = &["sessionId", "session", "parentId", "taskId"];
/// Route params that name a task (and `:id` under `/sessions/`).
pub const TASK_PARAMS: &[&str] = &["sid", "sessionId", "taskId"];

/// Who knows the task tree.
pub trait TaskTree: Send + Sync + 'static {
    /// Whether task `task` is `root` or under it.
    fn within(&self, task: &str, root: &str) -> BoxFuture<'static, bool>;
}

pub const TASKS: Point<dyn TaskTree> = Point::new("kernel.tasks", 1);

/// The task an agent caller speaks for; None for every other caller.
pub fn agent_task(c: &Caller) -> Option<&str> {
    c.session.as_deref().filter(|_| c.set.starts_with("agent:"))
}

fn refused(what: &str) -> WireError {
    WireError::new(Code::Forbidden, format!("{what}: an agent's token speaks for its own task only"))
}

/// The task ids `keys` name in `args` (strings only; absent or null keys name none).
pub fn named(args: &Value, keys: &[&str]) -> Vec<String> {
    keys.iter().filter_map(|k| args.get(*k).and_then(Value::as_str)).filter(|s| !s.is_empty()).map(str::to_owned).collect()
}

/// Ok when `caller` may act on every task in `ids` (and on all tasks, when `all`).
pub(crate) async fn check(trees: Vec<std::sync::Arc<dyn TaskTree>>, caller: &Caller, what: &str, ids: Vec<String>, all: bool) -> Result<()> {
    let Some(own) = agent_task(caller) else { return Ok(()) };
    if all {
        return Err(refused(what));
    }
    for id in ids.iter().filter(|id| id.as_str() != own) {
        let mut ok = false;
        for t in &trees {
            if t.within(id, own).await {
                ok = true;
                break;
            }
        }
        if !ok {
            return Err(refused(what));
        }
    }
    Ok(())
}

/// The task params of a route's match.
pub fn route_tasks(pattern: &str, params: &std::collections::BTreeMap<String, String>) -> Vec<String> {
    let mut out: Vec<String> = TASK_PARAMS.iter().filter_map(|k| params.get(*k)).filter(|s| !s.is_empty()).cloned().collect();
    if pattern.starts_with("/sessions/:id")
        && let Some(id) = params.get("id").filter(|s| !s.is_empty())
    {
        out.push(id.clone());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Tree;
    impl TaskTree for Tree {
        fn within(&self, task: &str, root: &str) -> BoxFuture<'static, bool> {
            let ok = root == "L" && task == "L.child";
            Box::pin(async move { ok })
        }
    }

    fn agent(s: &str) -> Caller {
        Caller { set: "agent:session".into(), session: Some(s.into()), plugin: None }
    }

    #[tokio::test]
    async fn an_agent_speaks_for_its_own_task_and_the_ones_under_it() {
        let t: Vec<std::sync::Arc<dyn TaskTree>> = vec![std::sync::Arc::new(Tree)];
        assert!(check(t.clone(), &agent("L"), "x", vec!["L".into(), "L.child".into()], false).await.is_ok());
        assert!(check(t.clone(), &agent("L"), "x", vec!["A".into()], false).await.is_err());
        assert!(check(t.clone(), &agent("L"), "x", vec![], true).await.is_err(), "a list of every task");
        assert!(check(t.clone(), &Caller::user(), "x", vec!["A".into()], true).await.is_ok(), "only agents are scoped");
        assert!(check(Vec::new(), &agent("L"), "x", vec!["L.child".into()], false).await.is_err(), "no tree: only its own");
        assert_eq!(named(&json!({ "sessionId": "A", "session": null, "id": "B" }), DEFAULT_TASK_ARGS), ["A"]);
        let p = std::collections::BTreeMap::from([("id".to_owned(), "A".to_owned())]);
        assert_eq!(route_tasks("/sessions/:id/turns", &p), ["A"]);
        assert_eq!(route_tasks("/stuff/:id", &p), Vec::<String>::new());
    }
}
