//! `wisp mcp`'s words (v1 server/mcp-wisp.js and crew-tools.js): how a session, a harness, a machine and a
//! crew member read back to the user's editor, and the shaping of its arguments. Values are the owners'
//! JSON; a field that isn't there reads as empty, where v1 printed "undefined".

use serde_json::{Map, Value};

use crate::rpc::truthy;

/// `wisp mcp`'s default wait (under typical MCP client tool-call timeouts).
pub const DEFAULT_WAIT_S: f64 = 240.0;
pub const NO_SESSIONS: &str = "No sessions.";
pub const NO_CREW: &str = "No crew yet. Add a member with wisp_crew_add.";
pub const SPELL_NOT_CREW: &str = "That is a spell, not a crew file: add it with `wisp spell install`.";
pub const TIMED_OUT: &str = " (timed out waiting; still running)";
/// What a member's edit may set (crew-tools.js `MEMBER_PROPS`, then the notebook).
pub const EDIT_FIELDS: &[&str] = &["name", "role", "brief", "cwd", "agent", "model", "effort", "mode", "cron", "parallel", "paused", "avatar", "notebook"];

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

/// A value as v1's template strings printed it (a missing one as empty).
pub fn as_text(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(x) => x.clone(),
        x => x.to_string(),
    }
}

fn shown(v: &Value, k: &str) -> String {
    v.get(k).map(as_text).unwrap_or_default()
}

fn on(v: &Value, k: &str) -> bool {
    v.get(k).is_some_and(truthy)
}

/// v1's states: `waiting` while an ask is open.
pub fn state_of(session: &Value) -> String {
    if on(session, "ask") { "waiting".into() } else { shown(session, "state") }
}

/// One session in `wisp_list`.
pub fn session_line(x: &Value) -> String {
    let state = state_of(x);
    let later = if on(x, "forLater") { " (for later)" } else { "" };
    let tail = if state == "running" {
        format!(" ({})", shown(x, "live"))
    } else if on(x, "preview") {
        format!(": {}", shown(x, "preview"))
    } else {
        String::new()
    };
    let question = Some(shown(x, "question")).filter(|q| !q.is_empty()).or_else(|| x.get("ask").map(|a| shown(a, "question")).filter(|q| !q.is_empty()));
    let asks = question.map(|q| format!(" — asks: {q}")).unwrap_or_default();
    format!("- `{}` **{}** — {state}{later}{tail}{asks} [{}, {}]", shown(x, "id"), shown(x, "title"), shown(x, "agent"), shown(x, "project"))
}

/// `wisp_get`: the session's head, its latest presentation, and what to do next.
pub fn describe(id: &str, session: &Value, markdown: &str, extra: &str) -> String {
    let state = state_of(session);
    let hint = match state.as_str() {
        "waiting" => "\n\n_Answer with wisp_reply._",
        "running" => "\n\n_Still running. Call wisp_wait to block until it finishes._",
        _ => "",
    };
    format!("Session `{id}` — **{}** — state: **{state}**{extra}\n\n{markdown}{hint}", shown(session, "title"))
}

/// `wisp_list`'s filter, as v1's `GET /api/sessions?state&cwd&limit` did it.
pub fn list(all: &[Value], a: &Map<String, Value>) -> String {
    let states: Option<Vec<String>> = a.get("state").filter(|v| truthy(v)).map(|v| as_text(v).split(',').map(|x| x.trim().to_owned()).collect());
    let cwd = a.get("cwd").and_then(Value::as_str).unwrap_or("");
    let under = format!("{}/", cwd.trim_end_matches('/'));
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)] // a count, floored at 1 below
    let limit = crate::words::number_or(a.get("limit"), 20.0).max(1.0) as usize;
    let hits: Vec<String> = all
        .iter()
        .filter(|x| states.as_ref().is_none_or(|st| st.contains(&state_of(x))))
        .filter(|x| cwd.is_empty() || s(x, "cwd") == cwd || s(x, "cwd").starts_with(&under))
        .take(limit)
        .map(session_line)
        .collect();
    if hits.is_empty() { NO_SESSIONS.into() } else { hits.join("\n") }
}

pub fn launched(x: &Value) -> String {
    format!("Launched session `{}` (“{}”) on {} in {}, mode {}. Call wisp_wait or wisp_get with this id for the result.", shown(x, "id"), shown(x, "title"), shown(x, "agent"), shown(x, "cwd"), shown(x, "mode"))
}

pub fn replied(r: &Value) -> &'static str {
    if on(r, "answered") {
        "Answered the agent’s question; it is continuing."
    } else if on(r, "interrupted") {
        "Interrupted the run; it resumes with your message."
    } else if on(r, "queued") {
        "Queued; it goes out when the current run finishes."
    } else {
        "Sent; the agent is working on it."
    }
}

pub fn stopped(id: &str) -> String {
    format!("Stopped `{id}`.")
}

/// `wisp_agents`: the harnesses here, then the machines.
pub fn agents(here: &[Value], machines: &[Value]) -> String {
    let here = here.iter().map(harness_line).collect::<Vec<_>>().join("\n");
    let there = machines.iter().map(machine_line).collect::<Vec<_>>().join("\n");
    format!("{here}\n\nMachines (pass machine to wisp_launch):\n{}", if there.is_empty() { "None." } else { &there })
}

fn harness_line(x: &Value) -> String {
    let what = if on(x, "available") {
        let version = Some(shown(x, "version")).filter(|v| !v.is_empty()).map(|v| format!(" {v}")).unwrap_or_default();
        let models = x.get("models").and_then(Value::as_array).map(|m| m.iter().map(|m| shown(m, "id")).filter(|id| !id.is_empty()).take(12).collect::<Vec<_>>().join(", ")).unwrap_or_default();
        format!("installed{version}; models: {}", if models.is_empty() { "default" } else { &models })
    } else {
        "not installed".into()
    };
    format!("- **{}** ({}) — {what}", shown(x, "id"), shown(x, "name"))
}

fn machine_line(m: &Value) -> String {
    let harnesses = m.get("remote").and_then(|r| r.get("agents")).and_then(Value::as_array).map(|a| {
        let ids = a.iter().filter(|x| on(x, "available")).map(|x| shown(x, "id")).collect::<Vec<_>>().join(", ");
        format!("; harnesses: {}", if ids.is_empty() { "none" } else { &ids })
    });
    format!("- `{}` **{}** — {}{}", shown(m, "id"), shown(m, "name"), shown(m, "state"), harnesses.unwrap_or_default())
}

/// v1's `clip`: at most `n` characters, the last one an ellipsis.
fn clip(x: &str, n: usize) -> String {
    if x.chars().count() > n { format!("{}…", x.chars().take(n - 1).collect::<String>()) } else { x.to_owned() }
}

/// One crew member, as one markdown item.
pub fn member_line(m: &Value) -> String {
    let role = Some(shown(m, "role")).filter(|r| !r.is_empty()).map(|r| format!(" — {r}")).unwrap_or_default();
    let model = Some(shown(m, "model")).filter(|r| !r.is_empty()).map(|r| format!(" ({r})")).unwrap_or_default();
    let place = if on(m, "machine") {
        format!("on machine {}", shown(m, "machine"))
    } else if on(m, "cwd") {
        format!("in {}", shown(m, "cwd"))
    } else {
        "no folder".into()
    };
    let cron = if on(m, "cron") { format!("checks in on `{}`", shown(m, "cron")) } else { "no schedule".into() };
    let mut bits = vec![format!("{}{model}", shown(m, "agent")), format!("{} mode", shown(m, "mode")), place, cron];
    if on(m, "paused") {
        bits.push("paused".into());
    }
    if on(m, "running") {
        let n = shown(m, "running");
        bits.push(format!("{n} job{} running", if n == "1" { "" } else { "s" }));
    }
    if let Some(q) = m.get("queue").and_then(Value::as_array).filter(|q| !q.is_empty()) {
        bits.push(format!("{} waiting", q.len()));
    }
    let brief = Some(shown(m, "brief")).filter(|b| !b.is_empty()).map(|b| format!("\n  Brief: {}", clip(&b.split_whitespace().collect::<Vec<_>>().join(" "), 200))).unwrap_or_default();
    format!("- **{}** (@{}, id `{}`){role} · {}{brief}", shown(m, "name"), shown(m, "handle"), shown(m, "id"), bits.join(" · "))
}

/// A member in full: what an agent reads before changing their notebook or kit.
pub fn member_detail(m: &Value) -> String {
    let mut head = m.clone();
    if let Some(o) = head.as_object_mut() {
        o.insert("brief".into(), Value::String(String::new()));
    }
    let brief = Some(shown(m, "brief")).filter(|b| !b.is_empty()).unwrap_or_else(|| "(none)".into());
    let notebook = shown(m, "notebook");
    // v1 counted UTF-16 units (JavaScript's length).
    let notebook = if notebook.is_empty() { "(empty)".into() } else { format!("{notebook}\n\n({} characters)", notebook.encode_utf16().count()) };
    let kit = m.get("kit").and_then(Value::as_array).filter(|k| !k.is_empty()).map_or_else(|| "No skills or instructions files yet. Propose some with wisp_crew_kit.".to_owned(), |k| k.iter().map(kit_file).collect::<Vec<_>>().join("\n\n"));
    [member_line(&head), format!("\n## Brief\n\n{brief}"), format!("\n## Notebook\n\n{notebook}"), format!("\n## Kit\n\n{kit}")].join("\n")
}

fn kit_file(k: &Value) -> String {
    let skill = s(k, "kind") == "skill";
    let off = if k.get("on") == Some(&Value::Bool(false)) { " (off)" } else { "" };
    let when = if skill { format!("When: {}\n\n", shown(k, "description")) } else { String::new() };
    format!("### {}: {}{off}\n\n{when}{}", if skill { "Skill" } else { "Instructions" }, shown(k, "name"), shown(k, "body"))
}

/// The fields of a member an add or edit sets: those given.
pub fn pick(a: &Map<String, Value>) -> Map<String, Value> {
    EDIT_FIELDS.iter().filter_map(|k| a.get(*k).map(|v| ((*k).to_owned(), v.clone()))).collect()
}

/// `remember`: lines added to the end of the notebook, at most 12, each on one line.
pub fn remembered(notebook: &str, remember: Option<&Value>) -> Option<String> {
    let lines: Vec<String> = remember.and_then(Value::as_array)?.iter().filter_map(Value::as_str).filter(|x| !x.trim().is_empty()).take(12).map(|x| format!("- {}", x.split_whitespace().collect::<Vec<_>>().join(" "))).collect();
    if lines.is_empty() {
        return None;
    }
    Some(std::iter::once(notebook.to_owned()).filter(|n| !n.is_empty()).chain(lines).collect::<Vec<_>>().join("\n"))
}

/// `@Name` → `Name`.
pub fn handle(v: Option<&Value>) -> String {
    let t = v.filter(|v| truthy(v)).map(as_text).unwrap_or_default();
    t.strip_prefix('@').map_or_else(|| t.clone(), str::to_owned)
}

pub fn added(m: &Value) -> String {
    let checkin = m.get("session").map(|x| format!("\n\nTheir first check-in is running (session `{}`).", shown(x, "id"))).unwrap_or_default();
    format!("Added {} to the crew.\n\n{}{checkin}", shown(m, "name"), member_line(m))
}

pub fn imported(members: &[Value]) -> String {
    let names = members.iter().map(|m| shown(m, "name")).collect::<Vec<_>>().join(", ");
    let lines = members.iter().map(member_line).collect::<Vec<_>>().join("\n");
    format!("Added {names} to the crew, paused until the user resumes them.\n\n{lines}")
}

pub fn updated(m: &Value) -> String {
    format!("Updated.\n\n{}", member_line(m))
}

pub fn removed(m: &Value) -> String {
    format!("Removed {} from the crew. Their jobs stay as ordinary sessions.", shown(m, "name"))
}

/// A shared crew file: a link (`https:`, `gist:`) or its text.
pub fn crew_source(from: &str) -> Value {
    let from = from.trim();
    let lower = from.to_ascii_lowercase();
    if lower.starts_with("https:") || lower.starts_with("gist:") { serde_json::json!({ "url": from }) } else { serde_json::json!({ "text": from }) }
}
