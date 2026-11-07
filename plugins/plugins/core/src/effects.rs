//! What the spells that are on do to the rest of wisp (v1 Spells.settings/recipes/promptFor/blocksFor/
//! hooks): settings they set and lock, recipes they bring, prompt rules and agent blocks for a task,
//! and the block types and slash names two spells can't both claim.
use std::collections::BTreeMap;

use serde_json::{Value, json};
use wisp_plugins_api::{LockedBy, LocksOut};

/// The task a rule is tested against.
#[derive(Debug, Clone, Default)]
pub struct TaskScope<'a> {
    pub agent: &'a str,
    pub mode: &'a str,
    pub cwd: &'a str,
    pub project_id: Option<&'a str>,
    pub project_name: Option<&'a str>,
}

fn strs(v: Option<&Value>) -> Option<Vec<&str>> {
    v.and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).collect())
}

/// v1 scopeMatches: `{ project: [names|ids|/paths], agent: [...|'*'], mode: [...] }`.
pub fn scope_matches(scope: Option<&Value>, t: &TaskScope) -> bool {
    let Some(sc) = scope.filter(|s| s.is_object()) else { return true };
    if let Some(a) = strs(sc.get("agent"))
        && !a.contains(&t.agent)
        && !a.contains(&"*")
    {
        return false;
    }
    if let Some(m) = strs(sc.get("mode"))
        && !m.contains(&t.mode)
    {
        return false;
    }
    if let Some(p) = strs(sc.get("project")) {
        let hit = p.iter().any(|x| Some(*x) == t.project_name || Some(*x) == t.project_id || (x.starts_with('/') && t.cwd.starts_with(x)));
        if !hit {
            return false;
        }
    }
    true
}

fn name(s: &Value) -> &str {
    s.get("name").and_then(Value::as_str).unwrap_or_default()
}
fn id(s: &Value) -> &str {
    s.get("id").and_then(Value::as_str).unwrap_or_default()
}
fn items<'a>(s: &'a Value, k: &str) -> &'a [Value] {
    s.get(k).and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

/// Does a spell apply to this task: its harnesses and its `when`?
pub fn applies(s: &Value, t: &TaskScope) -> bool {
    let harness_ok = strs(s.get("harnesses")).is_none_or(|h| h.contains(&"*") || h.contains(&t.agent));
    harness_ok && scope_matches(s.get("when"), t)
}

/// Settings the spells that are on set (in the order they were switched on: the last one wins).
pub fn settings_of(on: &[&Value]) -> LocksOut {
    let mut out = LocksOut::default();
    for s in on {
        for (k, v) in s.get("settings").and_then(Value::as_object).into_iter().flatten() {
            out.values.insert(k.clone(), v.clone());
            out.locked_by.insert(k.clone(), LockedBy { id: id(s).into(), name: name(s).into() });
        }
    }
    out
}

pub fn recipes_of(on: &[&Value]) -> Vec<Value> {
    on.iter()
        .flat_map(|s| {
            items(s, "recipes").iter().map(move |r| {
                let mut r = r.clone();
                r["runs"] = json!(0);
                r["lastRunAt"] = Value::Null;
                r["spell"] = json!({ "id": id(s), "name": name(s) });
                r
            })
        })
        .collect()
}

/// Prompt rules for this task, as one section of its system prompt ('' when none).
pub fn prompt_for(on: &[&Value], t: &TaskScope) -> String {
    let rules: Vec<String> = on
        .iter()
        .filter(|s| applies(s, t))
        .flat_map(|s| items(s, "prompt").iter().filter(|r| scope_matches(r.get("when"), t)).map(move |r| format!("- {} _(spell: {})_", r.get("text").and_then(Value::as_str).unwrap_or(""), name(s))))
        .collect();
    if rules.is_empty() {
        return String::new();
    }
    format!("\n\n## Spells the user cast\n\nThe user turned these on in wisp. Follow them unless the current request says otherwise.\n\n{}\n", rules.join("\n"))
}

/// An agent block a spell adds, for this task's report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtraBlock {
    pub r#type: String,
    pub doc: String,
    pub summary: String,
    pub spell: String,
}

pub fn blocks_for(on: &[&Value], t: &TaskScope) -> Vec<ExtraBlock> {
    let s = |b: &Value, k: &str| b.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
    on.iter().filter(|sp| applies(sp, t)).flat_map(|sp| items(sp, "blocks").iter().map(move |b| ExtraBlock { r#type: s(b, "type"), doc: s(b, "doc"), summary: s(b, "summary"), spell: name(sp).into() })).collect()
}

/// The block docs v1's systemPrompt({ extraBlocks }) listed beside the built-in ones, one per block:
/// the protocol owner puts them before "Strings must be valid JSON".
pub fn block_lines(extra: &[ExtraBlock]) -> String {
    extra
        .iter()
        .map(|b| {
            let doc = b.doc.trim();
            let example = if doc.starts_with('{') { break_after_example(doc) } else { format!("{{\"type\":\"{}\"}} {}", b.r#type, b.doc) };
            format!("- {example}\n  (From the user's spell {}.)", b.spell)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// `/\}\s+(?=\S)/` → `}\n  `: the first `}` followed by space and then more text.
fn break_after_example(doc: &str) -> String {
    for (i, _) in doc.match_indices('}') {
        let rest = &doc[i + 1..];
        let trimmed = rest.trim_start();
        if trimmed.len() < rest.len() && !trimmed.is_empty() {
            return format!("{}}}\n  {trimmed}", &doc[..i]);
        }
    }
    doc.to_owned()
}

/// Another spell must fit: its block types and slash names mustn't clash with one that's on.
pub fn clashes(s: &Value, on: &[&Value]) -> Vec<String> {
    let mut out = Vec::new();
    let names = |sp: &Value, list: &str, k: &str| -> Vec<String> { items(sp, list).iter().filter_map(|x| x.get(k).and_then(Value::as_str)).map(str::to_owned).collect() };
    for o in on.iter().filter(|o| id(o) != id(s)) {
        let theirs = names(o, "blocks", "type");
        out.extend(names(s, "blocks", "type").into_iter().filter(|t| theirs.contains(t)).map(|t| format!("block type {t} is already {}'s", name(o))));
        let theirs = names(o, "slash", "name");
        out.extend(names(s, "slash", "name").into_iter().filter(|t| theirs.contains(t)).map(|t| format!("/{t} is already {}'s", name(o))));
    }
    out
}

/// Every hook on `event`, with its spell.
pub fn hooks_of<'a>(on: &[&'a Value], event: &str) -> Vec<(&'a Value, &'a Value)> {
    on.iter().flat_map(|s| items(s, "hooks").iter().filter(move |h| h.get("on").and_then(Value::as_str) == Some(event)).map(move |h| (*s, h))).collect()
}

/// v1 overlayDefaults: the user's settings with the locked ones on top (what reads see).
pub fn overlay(user: &BTreeMap<String, Value>, locks: &LocksOut) -> BTreeMap<String, Value> {
    let mut out = user.clone();
    out.extend(locks.values.iter().map(|(k, v)| (k.clone(), v.clone())));
    out
}
