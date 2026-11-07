//! Spell hooks (v1 services/spell-hooks.js): what spells do on their own when something happens to a
//! task. A hook fires at most its `max` times per task (default once), so a spell that replies to
//! failed tests can't loop. This decides; the host counts, publishes and posts.
use serde_json::Value;
use wisp_plugins_api::HookTask;

use crate::js::{clip, js_number, truthy};
use crate::rules::fill_template;

fn list(v: &Value) -> Vec<&Value> {
    match v {
        Value::Array(a) => a.iter().collect(),
        v => vec![v],
    }
}

fn has(v: &Value, s: &str) -> bool {
    list(v).iter().any(|x| x.as_str() == Some(s))
}

/// v1 hookMatches: the hook's `if` against the task and its ending turn.
pub fn hook_matches(cond: Option<&Value>, t: &HookTask) -> bool {
    let Some(c) = cond.and_then(Value::as_object) else { return true };
    let sum = |k: &str| t.summary.get(k);
    if let Some(v) = c.get("status") {
        let status = sum("status").and_then(Value::as_str).unwrap_or("");
        if !has(v, status) && !has(v, &t.turn_status) {
            return false;
        }
    }
    if let Some(v) = c.get("testsFailed")
        && t.tests_failed != truthy(Some(v))
    {
        return false;
    }
    if c.get("agent").is_some_and(|v| !has(v, &t.agent)) || c.get("mode").is_some_and(|v| !has(v, &t.mode)) {
        return false;
    }
    if let Some(v) = c.get("project")
        && !list(v).iter().any(|p| Some(*p) == sum("project") || Some(*p) == sum("projectId"))
    {
        return false;
    }
    if let Some(v) = c.get("hasPr")
        && t.has_pr != truthy(Some(v))
    {
        return false;
    }
    true
}

/// v1 testsFailed: the turn's report has a tests block with failures.
pub fn tests_failed(blocks: &[Value]) -> bool {
    blocks.iter().any(|b| b.get("type").and_then(Value::as_str) == Some("tests") && js_number(b.get("failed")) > 0.0)
}

/// What a hook that fires does to the task.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HookDo {
    Reply(String),
    Done,
    Archive,
    ForLater,
    Notify(String),
    Webhook(String),
}

impl HookDo {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Reply(_) => "reply",
            Self::Done => "done",
            Self::Archive => "archive",
            Self::ForLater => "forLater",
            Self::Notify(_) => "notify",
            Self::Webhook(_) => "webhook",
        }
    }
}

/// A hook due on a task: the spell, the hook, and what to do (None: it counts, but can't apply now,
/// as v1 counted it before acting).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Due {
    pub spell: String,
    pub spell_name: String,
    pub hook: String,
    pub act: Option<HookDo>,
}

/// The action, with `{field}` templates filled from the task's summary; None when it can't apply now
/// (archiving or saving a task that is still running or waiting).
pub fn plan(action: &Value, t: &HookTask) -> Option<HookDo> {
    let (k, v) = action.as_object()?.iter().next()?;
    let text = || v.as_str().map(|s| fill_template(s, &t.summary)).unwrap_or_default();
    let busy = t.state == "running" || t.state == "waiting";
    Some(match k.as_str() {
        "reply" => HookDo::Reply(text()),
        "done" => HookDo::Done,
        "archive" if !busy => HookDo::Archive,
        "forLater" if !busy && !t.archived && !t.live => HookDo::ForLater,
        "notify" => HookDo::Notify(clip(&text(), 200)),
        "webhook" => HookDo::Webhook(v.as_str()?.to_owned()),
        _ => return None,
    })
}

/// The hooks that fire for `on` on this task: harness, the per-task cap (`count(spell, hook)`) and
/// `if`. The caller counts each one before acting, as v1 did.
pub fn due(on_spells: &[&Value], on: &str, t: &HookTask, count: impl Fn(&str, &str) -> u32) -> Vec<Due> {
    if t.internal || t.agent == "wisp" {
        return Vec::new();
    }
    let mut out = Vec::new();
    for (spell, hook) in crate::effects::hooks_of(on_spells, on) {
        let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
        let harness_ok = spell.get("harnesses").and_then(Value::as_array).is_none_or(|h| h.iter().any(|x| x == "*" || x.as_str() == Some(&t.agent)));
        let max = hook.get("max").and_then(Value::as_u64).and_then(|m| u32::try_from(m).ok()).unwrap_or(1);
        if !harness_ok || count(&s(spell, "id"), &s(hook, "id")) >= max || !hook_matches(hook.get("if"), t) {
            continue;
        }
        let act = hook.get("do").and_then(|a| plan(a, t));
        out.push(Due { spell: s(spell, "id"), spell_name: s(spell, "name"), hook: s(hook, "id"), act });
    }
    out
}

/// Which event a turn's end is: none for one the user stopped or a compaction (a hook's reply
/// would undo the click).
pub fn turn_event(turn_status: &str, interrupted: bool, by_compact: bool) -> Option<&'static str> {
    if interrupted || turn_status == "stopped" || by_compact {
        return None;
    }
    Some(if turn_status == "error" { "turn.failed" } else { "turn.finished" })
}
