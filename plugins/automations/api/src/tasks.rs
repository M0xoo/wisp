//! Declared tasks (ADR-0027): a task spec kept as a template (`tasks:` in a formula). Applying the
//! formula registers it; each run (its schedule, `wisp run <name>`, a trigger) makes a task from it.
//! A `{param}` in its prompt or steps is filled from the run's values: recipes are these.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use wisp_kernel::Command;

/// A task you can run by name, by schedule or from a trigger.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskDecl {
    /// what to do; `{param}` is filled from the run's values
    pub prompt: String,
    /// prompts sent after the first, each when the turn before ends
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub steps: Vec<String>,
    /// the folder it runs in
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub project: String,
    /// an agent profile's name or a harness
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub agent: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub model: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub effort: String,
    /// plan | edits | auto
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub mode: String,
    /// run in a worktree of its own
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<bool>,
    /// `{ text: tests pass }`: the goal judged after each turn
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal: Option<Value>,
    /// the crew member it runs for
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub crew: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub connectors: Vec<String>,
    /// when it runs by itself: a cron or words ("every day at 2"), in UTC
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub schedule: String,
    /// paused: its schedule doesn't fire (it still runs by hand)
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub paused: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct NamedTask {
    pub name: String,
    #[serde(flatten)]
    pub spec: TaskDecl,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TaskName {
    pub name: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RunTask {
    pub name: String,
    /// `{param}` values by name
    #[serde(default)]
    pub params: BTreeMap<String, String>,
    /// values by position, for the params not named
    #[serde(default)]
    pub words: Vec<String>,
    /// any field of the spec, over it (`agent`, `project`, …)
    #[serde(default)]
    pub over: serde_json::Map<String, Value>,
}

/// The `{name}` params of a text, in order, once each.
pub fn params_of(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut rest = text;
    while let Some(a) = rest.find('{') {
        let after = &rest[a + 1..];
        let Some(b) = after.find('}') else { break };
        let name = &after[..b];
        if !name.is_empty() && name.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-') && !out.iter().any(|x| x == name) {
            out.push(name.to_owned());
        }
        rest = &after[b + 1..];
    }
    out
}

/// `text` with its `{params}` filled; the first missing one is the error.
pub fn fill(text: &str, values: &BTreeMap<String, String>) -> Result<String, String> {
    let mut out = text.to_owned();
    for p in params_of(text) {
        let v = values.get(&p).ok_or_else(|| format!("needs {{{p}}}: wisp run <task> {p}=…"))?;
        out = out.replace(&format!("{{{p}}}"), v);
    }
    Ok(out)
}

macro_rules! command {
    ($name:ident = $id:literal [$perm:literal] $(read $ro:ident)? : $args:ty => $out:ty) => {
        #[derive(Debug)]
        pub struct $name;
        impl Command for $name {
            const ID: &'static str = $id;
            const PERMISSION: Option<&'static str> = Some($perm);
            $(const READ_ONLY: bool = { let _ = stringify!($ro); true };)?
            type Args = $args;
            type Out = $out;
        }
    };
}

command!(Tasks = "automations.tasks" ["automations:read"] read yes : Value => Vec<NamedTask>);
command!(TaskSet = "automations.task.set" ["automations:write"] : NamedTask => NamedTask);
command!(TaskRemove = "automations.task.remove" ["automations:write"] : TaskName => Value);
command!(TaskRun = "automations.task.run" ["automations:run"] : RunTask => Value);

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn params_fill_in_order() {
        assert_eq!(params_of("fix {issue} in {repo}, then {issue}"), ["issue", "repo"]);
        let v: BTreeMap<String, String> = [("issue".to_owned(), "42".to_owned()), ("repo".to_owned(), "api".to_owned())].into();
        assert_eq!(fill("fix {issue} in {repo}", &v).unwrap(), "fix 42 in api");
        assert!(fill("fix {issue}", &BTreeMap::new()).unwrap_err().contains("{issue}"));
    }
}
